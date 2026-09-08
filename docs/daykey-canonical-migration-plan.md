# G-02 — Canonical dayKey Migration: Execution Plan (Phase 4B-2)

**Status: PREPARATION ONLY — nothing in this plan has been executed.**
Scope of the eventual execution: a one-time, application-layer rewrite of persisted day keys
from Jalali (`1403-05-17`) to canonical Gregorian (`YYYY-MM-DD`) derived from `User.timezone`.
No schema change is required for the rewrite itself (columns are strings; formats change).

---

## 1. Preconditions (all must hold before any write)

1. **`DATABASE_URL` reachable** — currently *not available* in the sandbox (verified: `prisma migrate status` → P1012). The rewrite must run where the DB lives.
2. **Migrations applied**: `20260907183514_add_user_prefs_task_priority_nullable_history_index` (Phase 2A) and `20260907190952_add_dailyplan_versioning_and_task_event` (Phase 3) — both exist on disk, **neither is applied** (blocked by #1).
3. `npx prisma migrate status` → clean, no drift, no pending.
4. Dry-run analyzer (`scripts/analyze-daykey-migration.ts`) executed against the real database; output archived as evidence.
5. Analyzer verdict: `blockers === 0` **and** `gregorianLookingKeys.length === 0`.

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

1. **Decide the write-window strategy** (see §8) — producers still write Jalali until Phase 4C, so Jalali rows created *after* the rewrite would poison the invariant.
2. Apply pending migrations; verify `migrate status` clean.
3. Take backups (dump + audit JSON).
4. Run dry-run analyzer; archive output; confirm blockers = 0.
5. **Approval gate** (§9).
6. Execute rewrite: per-user transactions, `DailyPlan` rows first, then `Task` rows, inside each user's transaction.
7. Verification pass: re-run analyzer → expect zero Jalali keys remaining, zero blockers; `affectedRowCounts.totalRowsToRewrite` == rows updated.
8. Archive artifacts (dump, audit JSON, both analyzer outputs).
9. Separate approved phase (4C): cut over producers/consumers to `canonicalDay.ts` + `user.timezone`.

## 8. Open decision — write-window strategy (requires approval)

- **Option A (recommended)**: short write-freeze window; run rewrite + Phase 4C producer cutover in the same deploy. No mixed-format state.
- **Option B**: rewrite immediately before the cutover deploy with a brief quiet period; accept a small risk window if clients write during the gap (offline-queued tasks would re-introduce Jalali keys).

## 9. Exact approvals needed before actual data rewrite

1. **DATABASE_URL access** in the execution environment (blocker today).
2. Approval to **apply pending migrations** (2A + 3) on the target database.
3. Approval of **window strategy** (Option A vs. B).
4. Confirmation that **dailyPlan merge strategy stays "hard stop + manual resolution"** if a collision materializes.
5. Sign-off on the **archived dry-run output** (real data) showing blockers = 0.
