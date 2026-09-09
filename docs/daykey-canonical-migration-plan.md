# G-02 — Canonical dayKey Migration: Execution Plan (Phase 4B-2)

**Status: CLOSED — No Legacy Data Migration Required (G-02 closeout, 2026-09-09; see Closeout below).**
Historical status at Phase D1: `CODE CUTOVER COMPLETE — DATA REWRITE NOT EXECUTED` (Status Sync below).
Scope of the eventual execution: a one-time, application-layer rewrite of persisted day keys
from Jalali (`1403-05-17`) to canonical Gregorian (`YYYY-MM-DD`) derived from `User.timezone`.
No schema change is required for the rewrite itself (columns are strings; formats change).

> ### Status Sync — Phase D1 / 4C-verification (documentation housekeeping only) — HISTORICAL RECORD
>
> *Everything in this block describes the state as of Phase D1 and is superseded by the
> **Closeout** section below (roadmap commit `4481bee`). Retained verbatim for history.*
>
> - **Code cutover: COMPLETE.** All current Task/DailyPlan `dayKey` write paths derive the key
>   server-side via `app/lib/canonicalDay.ts` from `User.timezone` (Gregorian `YYYY-MM-DD`):
>   `createTask`, `completeTask`, `updateTask`, `rolloverTasks`, `setDayPlan`, and the planner
>   routes. Jalali and the calendar preference are presentation-only; no active producer writes
>   Jalali or client-supplied day keys (schemas accept `title` + `scheduledDate`; the offline
>   queue syncs only `{ title, scheduledDate }`; the `jalili.ts` legacy helpers have no
>   production callers — the analyzer script imports them intentionally for legacy conversion).
>   This is a **code cutover** — it is not, by itself, proof that historical production data
>   has been migrated.
> - **Existing-data migration: PENDING / NOT REQUIRED YET** — the current database contains
>   0 users, 0 tasks, and 0 DailyPlans, so there is no legacy data to rewrite in this environment.
>   **[HISTORICAL — true at Phase D1; superseded by Closeout: no legacy data was ever present, so no migration was required]**
> - **Evidence on populated data: NOT YET AVAILABLE.** The dry-run analyzer executed successfully
>   (via `npm run analyze:daykey`, read-only) but against an **empty** database: blockers = 0,
>   collisions = 0, Jalali-looking keys = 0, affected rows = 0. This result is
>   **vacuous / non-representative of a populated production dataset** and must not be read as
>   proof that historical-data migration is unnecessary for a populated database. Archived
>   analyzer artifacts: `docs/dry-run-reports/`.
>   **[HISTORICAL — superseded by Closeout: populated-data evidence arrived with E2 run 3]**
> - **Formal migration closeout: NOT CLAIMED.** Sections 1, 7, 8, and 9 keep their original
>   runbook value; stale operational assumptions are annotated in place rather than deleted.
>   **[HISTORICAL — superseded by Closeout: G-02 is now CLOSED — No Legacy Data Migration Required]**

> ### Closeout — G-02 CLOSED (2026-09-09, roadmap commit `4481bee`)
>
> **G-02 is closed because no legacy data requiring migration was present, not because a
> historical migration was executed.** No data rewrite was ever executed; none was required.
>
> - **Code cutover: complete.** Canonical `dayKey` producers are server-side, derived from
>   `User.timezone`, persisted as Gregorian `YYYY-MM-DD`; client-supplied dayKey is never
>   trusted; the offline queue does not supply arbitrary dayKeys (see Status Sync above).
> - **Populated smoke-data verification: complete (E2 run 3).** `npm run analyze:daykey`
>   (read-only) against populated data: **1 user · 3 tasks · 2 DailyPlans · 0 blockers ·
>   0 collisions · 0 invalid/Jalali-looking stored keys · exit 0**.
> - **No legacy records requiring historical rewrite were present** in the populated database
>   environment inspected during the E2 closeout — therefore **no historical data migration
>   was required**, and none was manufactured for evidence.
> - The pre-cutover `dayKey-scheduledDate-drift` warnings in that run are the expected
>   artifact of the pre-cutover analyzer reading canonical Gregorian keys as Jalali
>   (year-2647 mapping) — itself evidence that stored keys are canonical, not legacy.
> - Sections 2–9 below are retained as the historical runbook: what **would** have been
>   executed had legacy Jalali-keyed data existed. They were never run and are not pending.

---

## 1. Preconditions (all must hold before any write)

1. **`DATABASE_URL` reachable** — ~~currently *not available* in the sandbox (verified: `prisma migrate status` → P1012)~~ **[RESOLVED — D1/4C-verification: reachable; `DATABASE_URL` resolves to the configured Neon instance; `prisma migrate status` and the analyzer both connect]**. The rewrite must run where the DB lives.
2. **Migrations applied**: `20260907183514_add_user_prefs_task_priority_nullable_history_index` (Phase 2A) and `20260907190952_add_dailyplan_versioning_and_task_event` (Phase 3) — ~~both exist on disk, **neither is applied** (blocked by #1)~~ **[RESOLVED — D1/4C-verification: all migrations applied; `prisma migrate status` → "Database schema is up to date!"]**.
3. `npx prisma migrate status` → clean, no drift, no pending. **[HOLDS TODAY]**
4. Dry-run analyzer (`scripts/analyze-daykey-migration.ts`) executed against the real database; output archived as evidence. **[RESOLVED — E2 run 3 executed it successfully against populated data (1 user / 3 tasks / 2 DailyPlans) with exit 0; earlier archive was empty-DB only]**
5. Analyzer verdict: `blockers === 0` **and** `gregorianLookingKeys.length === 0`. **[RESOLVED — E2 run 3 on populated data: 0 blockers, 0 collisions, 0 invalid/Jalali-looking keys, exit 0 (no longer vacuous); moot for execution since the closeout means no rewrite will be run]**

> **Producer format note (D1/4C-verification):** the original premise of preconditions 1–2 —
> that producers were still dual-format/legacy-producing — no longer describes the code.
> Producer cutover is complete (see Status Sync); only the historical-data question remains.
> **[RESOLVED — see Closeout: no legacy data present, question closed]**

## 2. Invariants the rewrite relies on

- **Source/target format disjointness**: Jalali keys start with `13xx/14xx`; canonical keys are Gregorian `YYYY-MM-DD` (19xx/20xx). In-place `UPDATE dayKey` cannot transiently violate `@@unique([userId, dayKey])` on `DailyPlan` **as long as no Gregorian-looking keys already exist** (analyzer precondition #5).
- Conversion is deterministic and per-user: `fromDayKey(jalali)` → Tehran midnight → `getCanonicalDayKey(_, user.timezone)`. All users currently hold the Prisma default `Asia/Tehran`, so today's mapping is 1:1.
- **DONE tasks** legitimately have `dayKey` (completion day) ≠ `scheduledDate`-day. The rewrite must preserve them as-is; the analyzer already excludes them from drift warnings.
- `Task.scheduledDate` is NOT NULL and never rewritten (it stays the Tehran-midnight instant until a later approved phase).

## 3. Backup requirements (before any write)

1. **Logical snapshot (authoritative)**:
   `pg_dump "$DATABASE_URL" -t '"Task"' -t '"DailyPlan"' -t '"User"' -Fc -f daykey-backup-<timestamp>.dump`
2. **Row-level audit JSON** (produced by the executor in the same run): per-row
   `{ table, id, oldDayKey, oldCompletedOn? }` for every row actually updated.
   Store next to the dump; retention ≥ until Phase 4C cutover is verified in production.
3. Recommended: restore-drill on a staging copy before the production run.

## 4. Transaction boundaries

- **Per-user single transaction** (`prisma.$transaction`): all of that user's `DailyPlan` + `Task` `dayKey`/`completedOn` updates together.
  - A failure rolls back only that user; already-committed users remain consistent.
  - Avoids a single giant lock across all users.
- Chunking: if one user has an unusually large row count, split into sequential transactions per chunk **within the same user's plan rows only if collision-free** — default is one tx per user.
- **Runtime re-check inside the executor**: immediately before the first write, re-run the analyzer checks (blockers = 0, gregorian-looking = 0). Abort before any write on failure.
- No writes outside transactions; the executor performs no `DELETE` and no raw SQL.

## 5. Collision handling strategy

| Case | Handling |
|---|---|
| **DailyPlan collision candidate** (same user, ≥2 Jalali sources → same canonical target; would violate `@@unique([userId, dayKey])`) | **Hard stop.** Requires an explicit per-occurrence decision (merge strategy — keep-latest vs. sum — is an architecture decision that must not be invented here). Expected count today: 0 (1:1 Tehran mapping). |
| **Task collision** (two Jalali days fold into one canonical day for a user) | Allowed by design (`dayKey` is a label, not unique). Recorded in `taskConversionMap` + `collisions` with task IDs for the audit log. |
| **Unconvertible keys** (bad format / invalid Jalali date / Gregorian-looking) | Hard stop — listed in `verdict.blockersDetail`. No partial rewrite. |

## 6. Rollback strategy

1. **Primary**: restore tables from the `pg_dump` snapshot (authoritative).
2. **Secondary**: replay the row-level audit JSON in reverse (id-keyed) — valid because the rewrite touches only `Task.dayKey`, `Task.completedOn`, `DailyPlan.dayKey` and inserts/deletes nothing.
3. Post-rollback verification: re-run the analyzer; numbers must equal the archived dry-run output.

## 7. Order of operations (runbook)

1. **Decide the write-window strategy** (see §8) — ~~producers still write Jalali until Phase 4C, so Jalali rows created *after* the rewrite would poison the invariant.~~ **[OBSOLETE — producers are already canonical (code cutover complete); no mixed-format risk exists. Retained as historical context; the freeze decision itself is moot, though a brief quiet period during the rewrite is still good practice.]**
2. ~~Apply pending migrations; verify `migrate status` clean.~~ **[DONE — all migrations applied; `migrate status` clean]**
3. Take backups (dump + audit JSON).
4. Run dry-run analyzer; archive output; confirm blockers = 0.
5. **Approval gate** (§9).
6. Execute rewrite: per-user transactions, `DailyPlan` rows first, then `Task` rows, inside each user's transaction.
7. Verification pass: re-run analyzer → expect zero Jalali keys remaining, zero blockers; `affectedRowCounts.totalRowsToRewrite` == rows updated.
8. Archive artifacts (dump, audit JSON, both analyzer outputs).
9. Separate approved phase (4C): cut over producers/consumers to `canonicalDay.ts` + `user.timezone`.

## 8. Open decision — write-window strategy ~~(requires approval)~~ **[OBSOLETE — see Status Sync: producer cutover is complete, so the mixed-format risk these options were designed to avoid no longer exists. Kept as historical context.]**

- **Option A (recommended)**: short write-freeze window; run rewrite + Phase 4C producer cutover in the same deploy. No mixed-format state.
- **Option B**: rewrite immediately before the cutover deploy with a brief quiet period; accept a small risk window if clients write during the gap (offline-queued tasks would re-introduce Jalali keys).

## 9. Exact approvals needed before actual data rewrite

1. ~~**DATABASE_URL access** in the execution environment (blocker today).~~ **[RESOLVED — D1/4C-verification: access confirmed]**
2. ~~Approval to **apply pending migrations** (2A + 3) on the target database.~~ **[RESOLVED — all migrations applied]**
3. ~~Approval of **window strategy** (Option A vs. B).~~ **[OBSOLETE — see §8; no mixed-format risk remains]**
4. Confirmation that **dailyPlan merge strategy stays "hard stop + manual resolution"** if a collision materializes. **[MOOT — Closeout: no rewrite will be executed, so no collisions can materialize; strategy remains documented should the question ever reopen]**
5. Sign-off on the **archived dry-run output** (real data) showing blockers = 0. **[RESOLVED — E2 run 3 populated-data analyzer: 0 blockers / 0 collisions / 0 invalid keys, exit 0; recorded in `roadmap.md` G-02 closeout. Moot for execution: no rewrite will be run]**
