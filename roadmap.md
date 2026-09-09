# DailyPilot — Canonical Implementation Roadmap

> **`architecture.md` is the source of truth.** This file tracks implementation work against
> that baseline and cannot override, reinterpret, or silently change architectural decisions.
> Where implementation and architecture disagree, this roadmap records the item as
> `ARCHITECTURE CONFLICT / DECISION REQUIRED` instead of resolving it silently.

Last synced: G-02 closeout — CLOSED, no legacy data migration required (docs-only; last implementation commit `6691a89`).
Earlier: Decision 6 (§9.3 `INTERNAL` alignment) and Decision 2 (ADR-06: change-password ratified) after `f6f4430` (Phase E2).
Evidence basis: direct repository inspection (§-references verified in `architecture.md`,
commit hashes verified via `git log`).

---

## 1. Project Status

| Dimension | Status | Notes |
|---|---|---|
| **Overall V1 status** | `PARTIALLY COMPLETE` | Core domains complete and architecture-conformant; release-readiness items open (P1/P2 below) |
| **Core V1 implementation** | `COMPLETE` | Tasks, Daily Planning/Rebalance, AI analysis, Time Tracking, Auth, Rollover, Offline Queue (limited), PWA — all implemented and regression-tested |
| **Architecture alignment** | `COMPLETE` | All §6.4 / §7.12 / §9.10 / §11.4 registered gaps closed; 226 tests green across 24 files; typecheck + lint clean |
| **Release readiness** | `COMPLETE` (E2 run 3) | Full authenticated lifecycle verified over real HTTP with live `JWT_SECRET`: register+auto-session, login, task create (server-derived dayKey = Tehran-midnight instant), day budget, mock-AI analyze (attribution `aiSource=mock`), explicit-category preservation, complete+spentMinutes=90 (status DONE, completedOn=today), day summary (spent=90), stale detection (v2 > rv=1), lazy rebalance proven via read-only rv advance (2→3), overdue list, rollover (past→today), history markers, logout cookie-clear, negatives (400/404/401, ADR-04 codes incl. domain `TASK_NOT_FOUND`). Analyzer on populated data: 1 user / 3 tasks / 2 plans — 0 blockers, 0 collisions, 0 invalid keys; 2 expected pre-cutover `dayKey-scheduledDate-drift` warnings (canonical keys re-read as Jalali → year 2647), which itself evidences canonical storage. Smoke data cleaned guarded; DB back to exact baseline zeros. Deploy check `deployable=true`, 0 problems. Gates: 234/234 tests, typecheck, lint, migrate status — all clean; `architecture.md` untouched. Run-1 landing-500 was diagnosed as the missing-secret throw (not SSR); its one-line `"use client"` in DashboardPreview was proven redundant (framer-motion ships its own boundary) and excluded from E2 commit |
| **G-02 DayKey** | `CLOSED — No Legacy Data Migration Required` | History: `CODE CUTOVER COMPLETE — DATA MIGRATION PENDING` · `DATA REWRITE NOT EXECUTED` · early evidence EMPTY/VACUOUS (0-row DB) · populated-data evidence arrived with E2 run 3. **Closeout rationale:** (1) code cutover complete — canonical dayKey producers are server-side, derived from `User.timezone`, persisted as Gregorian `YYYY-MM-DD`, client-supplied dayKey never trusted, offline queue does not supply arbitrary dayKey; (2) populated smoke-data verification complete — E2 run 3 analyzer on 1 user / 3 tasks / 2 DailyPlans: 0 blockers, 0 collisions, 0 invalid/Jalali-looking stored keys, `npm run analyze:daykey` exit 0; (3) no legacy records requiring historical rewrite were present in the populated DB environment inspected during E2 closeout, therefore **no historical data migration was required** (and none was manufactured for evidence). Closed because there is no legacy data requiring migration — NOT because a historical migration was performed |
| **Test/typecheck/lint** | `COMPLETE` | 25 files / 234 tests green · `tsc --noEmit` 0 errors · ESLint clean · `prisma migrate status`: schema up to date |

---

## 2. Architecture Baseline (roadmap-level summary — not a redefinition)

Invariants every future phase must preserve:

- **dayKey**: server-derived canonical Gregorian `YYYY-MM-DD`; `User.timezone` is the local-day
  authority; client-supplied dayKey is never trusted (§6.2.2.1, §6.3.1).
- **Jalali / calendar preference**: presentation layer only; never persisted (§6.3.1).
- **Task independence from AI**: creation and editing never require AI (§2.1, ADR-05).
- **AI as optional analysis**: explicit user request only; suggestion layer, never the
  decision-maker; only TODO tasks; Zod-validated output; provider swappable with
  timeout/retry/backoff and distinguishable mock fallback (§7.13).
- **Lazy / on-demand rebalance** (ADR-03): mutations never rebalance eagerly; they only mark
  the day stale.
- **Version-based stale detection** (§6.3.2): stale ⇔ `rebalancedVersion IS NULL OR planVersion
  > rebalancedVersion`.
- **Atomic planVersion mutation** (§6.3.2): every effective planning mutation bumps
  `planVersion` in the same transaction; multi-day mutations bump all affected days.
- **DailyPlan absence semantics** (§6.3.3): missing record = stale; mutations must not fail on
  missing plan rows; read-side creation starts at `planVersion = 0`.
- **TaskEvent behavior** (§6.3.6): lifecycle events (CREATED/ANALYZED/EDITED/ROLLED_OVER/
  COMPLETED) recorded in the same transaction as the mutation; append-only.
- **Time Tracking** (§5.4.1): `spentMinutes` lives on Task; no TimeEntry entity in V1.
- **Standard API envelope** (ADR-04 / §3.11): `{ ok, data }` success; `{ ok:false,
  error:{ code, message, errors? } }` failure; all routes.
- **Thin Route Handlers** (ADR-02): Parse → Authenticate → Validate → Authorize → Service →
  Response; business logic in `app/lib/`, HTTP-independent.
- **Domain/infrastructure boundaries** (§9.11): Domain never depends on Prisma error codes or
  AI provider error formats; mapping happens at the appropriate boundary.
- **Deferred V1 domains**: Habits, Notifications, TimeEntry, TaskAnalysis entity, General
  Offline Sync, AI Coach, Payment/Subscription, Email, native apps, timezone change from UI.

---

## 3. Completed Phase History

| Phase | Purpose | Status | Commit | Notes |
|---|---|---|---|---|
| Alignment Audit | Full implementation-vs-architecture audit; master phase plan | `COMPLETE` | — (read-only) | Established gap matrix; no code |
| C1 | Task CRUD foundation (schema conformance §6.2, validation, service, 5 routes) | `COMPLETE` | `7a13609` | Server-derived dayKey; ownership enforced |
| C2 | Task completion & Time Tracking (§3.10-C, §5.4.1) | `COMPLETE` | `1aaf4a8` | Atomic completion transaction; TaskEvent COMPLETED |
| C3 | AI analysis integration + §7.8 fallback/retry coverage | `COMPLETE` | `1256092` | Category preservation §7.5 verified; strict route validation |
| C4 | Lazy rebalance wiring tests (ADR-03) | `COMPLETE` | `7ba45d3` | Read-vs-mutation trigger contract locked |
| C4.1 | Allocation algorithm unit tests (§5.6.1) | `COMPLETE` | `4723d6f` | Weight formula verified against the doc's own worked examples |
| C5 | Rollover & overdue service-layer coverage (§5.6.3/§6.3.2/§6.3.5) | `COMPLETE` | `fe44279` | Multi-day bumps + ROLLED_OVER events locked |
| C6 | Time Tracking completion input hardening | `COMPLETE` | `8afac2e` | ±5-min stepper; shared `parseSpentMinutes` mirroring server bounds |
| C7 | AI analysis display: source attribution + §9.6 error/retry | `COMPLETE` | `f666a95` | Mock identifiability §7.13; manual retry only for idempotent analyze |
| C8 | ADR-04 envelope conformance sweep | `COMPLETE` | `4ad22ec` | Last raw route fixed + missing error mapping closed |
| D1 | DayKey migration dry-run (read-only) | `COMPLETE` | — (read-only) | 0 blockers, 0 collisions; evidence vacuous (empty DB) |
| D1.1 | Migration plan doc sync (docs only) | `COMPLETE` | `3c83122` | Stale preconditions annotated; closeout not claimed |
| E2 | V1 end-to-end production readiness pass | `COMPLETE` | — (this phase: evidence run, commit records roadmap) | Run 3 (secret live): 35-check lifecycle + 4-check rebalance evidence over real HTTP — register 201 + auto-session, login 200, create 201 (dayKey server-derived `2026-09-09`, scheduledDate = Tehran midnight `2026-09-08T20:30:00Z`), budget 200 (planVersion 1), analyze 200 `aiSource=mock`, category `Work` preserved across re-analyze, complete 200 DONE spent=90 completedOn=today, summary spent=90 done=1, stale v2>rv1, lazy rebalance proven by read-only rv advance 2→3, overdue lists past task, rollover past→today, history markers `{dayKey, doneCount, savedMinutes, overspentMinutes}`, logout clears cookie (Max-Age=0), negatives: 400 `VALIDATION_ERROR` ×2, 404 domain `TASK_NOT_FOUND` (per §9.3/9.4 code table; generic `NOT_FOUND` is the P2025 mapper code), 401 `UNAUTHORIZED` ×2. Analyzer populated: 1/3/2 rows, 0 blockers/collisions/invalid; 2 expected pre-cutover drift warnings; exit 0. Cleanup guarded exact-match: BEFORE 1/3/8/2 → AFTER 0/0/0/0. Deploy check `deployable=true` 0 problems. Gates: 234/234 tests (25 files), typecheck/lint clean, migrations up-to-date, `architecture.md` diff empty. Temp smoke scripts deleted pre-commit. Run-1 `"use client"` in DashboardPreview proven redundant (framer-motion ships own client boundary) → excluded from commit |

Pre-session baseline: `b41be92` (auth hardening B2+P2) and earlier repo history.

---

## 4. Gap Matrix

Statuses: `CLOSED` / `PARTIALLY CLOSED` / `OPEN` / `DEFERRED` / `NEEDS PRODUCT DECISION` /
`NEEDS ADR` / `BLOCKED`.

| ID | Gap / feature | Status | Evidence | Blocks V1? | Dependency | Next action |
|---|---|---|---|---|---|---|
| G-§6.4-1 / §7.12-1 | AI in Create Task | `CLOSED` | `createTask` has no AI imports; C3/C4 tests | No | — | — |
| G-§6.4-2 / §7.12-2 | Eager rebalance | `CLOSED` | Mutations bump only; C4/C5 tests | No | — | — |
| G-§6.4-3 | Hardcoded Jalali/Tehran | `CLOSED` | `canonicalDay.ts` Intl-based; `jalili.ts` has no production callers | No | — | — |
| G-§6.4-4 | AvailableMinutes API | `CLOSED` | `POST /api/planner/day` → `setDayPlan` upsert (§6.3.3) | No | — | — |
| G-§6.4-5 / §5.4 | Task Edit API | `CLOSED` | `updateTask`: Content vs Planning-only, atomic | No | — | — |
| G-§6.4-7 / §7.12-7 | Category overwrite by AI | `CLOSED` | `task.category ?? analysis.category`; C3 tests | No | — | — |
| G-§7.12-3 | TaskEvent missing | `CLOSED` | Model + 5 event types, in-transaction | No | — | — |
| G-§9.10-1..3 | Shared envelope / ok / error.code | `CLOSED` | All 15 route files conform (C8) | No | — | — |
| G-§9.10-4 | Persian error messages | `CLOSED` | Envelope messages Persian; codes machine-readable | No | — | — |
| G-§9.10-5 | **Prisma known-error mapping** | `CLOSED` (E1) | `toServiceErrorFromInfrastructure` in `app/lib/services/errors.ts`: duck-typed `P2002`→409 `CONFLICT`, `P2025`→404 `NOT_FOUND` at the §9.11 boundary (no Prisma import); wired into `registerUser`'s `create` (race-safe 409); 8 dedicated tests | Edge only | — | Future call-site candidates only: `updateProfile` (if `username` gains `@unique`), future update/delete-or-throw sites |
| G-§9.10-6 | Offline-UI honesty | `CLOSED` | Queue is Create-only; syncs `{title, scheduledDate}`; canonical v2 cache | No | — | — |
| G-§9.10-7 | Client retry / duplicate mutation | `CLOSED` | C7: manual retry, idempotent-analyze only | No | — | — |
| G-§11.4 | Test/typecheck tooling | `CLOSED` | vitest + scripts exist and run | No | — | — |
| G-G-02 | DayKey data migration | `CLOSED — No Legacy Data Migration Required` (closeout) | Code cutover verified (server-derived canonical Gregorian keys; client dayKey untrusted; offline queue Create-only `{title, scheduledDate}`) · populated-data evidence E2 run 3 (1 user / 3 tasks / 2 DailyPlans — 0 blockers, 0 collisions, 0 invalid/Jalali-looking keys, analyzer exit 0; smoke data cleaned after evidence) · no legacy records requiring rewrite present → historical migration not required | No | — | — (was: See Decision Gate) |
| G-§8.12.1 | Change-password ratification | `CLOSED` (ADR-06) | Decision 2 (2026-09-09): deviation **KEPT** — `ADR-06-change-password.md` ratifies §8.12.1's pending state: stateless JWT retained; password change does NOT invalidate issued tokens; no revocation/session store/refresh tokens; session invalidation requires a separate future ADR. `architecture.md` untouched (§8.12.1 preserved as history) | No | — | — |
| G-§8.13 | **Registration auto-login** | `CLOSED` / architecture-conformant | §8.2 "Auto Login — بعد از Registration موفق، کاربر در همان Flow به‌صورت خودکار Login می‌شود" (arch:4149); §8.14 contract list (arch:4603). Code: register → `createSession` cookie → client redirect to `/dashboard` | No | — | None — conformant |
| G-§8.13 (rest) | Session helper / defaults / hash-exposure / no-middleware | `CLOSED` | `createSession.ts`; schema defaults `plan/timezone/locale/calendar`; `getCurrentUser` select omits `password`; no middleware file | No | — | — |
| G-§7.14 | Quota / entitlement / payment | `DEFERRED` | §7.14 LOCKED; §13.1 "PRO ... Entitlement/Quota فقط با نیاز واقعی" | No | Product decision | Post-V1 |
| G-C5 | `droppedTaskIds` API surfacing | `NEEDS PRODUCT DECISION` | Candidates derivable from state; API field would extend contract | No | Decision | Decide; do not implement implicitly |
| G-§6.4-6 | Timezone change policy | `DEFERRED` | §6.4-6: V1 does not support UI timezone change | No | — | Post-V1 |

---

## 5. Prioritized Roadmap

### P0 — Architectural / Foundation blockers

None. No open item prevents correct V1 operation.

### P1 — V1 Functional Completion

| Phase | Title | Priority | Objective | Scope | Non-goals | Dependencies | Expected verification | Architecture refs | Status |
|---|---|---|---|---|---|---|---|---|---|
| **E1** | **Prisma Infrastructure Error Mapping** | P1 | Close the last OPEN §9.10 gap: known Prisma errors mapped to ADR-04 envelopes at the infrastructure/error boundary, without coupling Domain logic to Prisma codes (§9.11) | Centralized mapper for `P2002` → 409 `CONFLICT`, `P2025` → 404 `NOT_FOUND` (Persian messages) inside the existing ServiceError/response channel; wire at service call sites where unique-constraint races are realistic (e.g. auth register); unit tests per code | No new endpoints; no schema changes; no Domain-layer Prisma coupling; no UI changes; no new deps | None | Mapper unit tests; full suite green; typecheck + lint; no migration | §9.10, §9.11, ADR-04 | `COMPLETE` — 8 tests (mapper ×4, registerUser race ×4); 25 files / 234 tests green; typecheck/lint clean; no schema/migration |
| E2 | V1 end-to-end production readiness pass | P1 | Exercise every core flow on a populated database and verify deployment configuration | Real-data smoke of register → create → budget → analyze → complete → rollover → history; `freebuff-deploy check`; fix what surfaces | No new features; no architecture changes | Populated DB / real usage | Analyzer + full suite on populated data; deploy check clean | §12, §13 | `COMPLETE` (run 3) — all lifecycle checks PASS over live HTTP; populated analyzer evidence recorded (G-02 evidence only, closeout stays at Decision Gate); deploy check clean; all gates green; smoke data cleaned to exact baseline; roadmap-only commit |

### P2 — Release Readiness / Hardening

| Phase | Title | Priority | Objective | Scope | Non-goals | Dependencies | Expected verification | Architecture refs | Status |
|---|---|---|---|---|---|---|---|---|---|
| E3 | Component/integration test consolidation | P2 | Cover UI flows that service/route tests don't reach | React component tests for completion modal, reanalyze modal, task card states; integration flow tests | No production behavior changes | None (vitest already present) | New tests green; suite green | §11.4 | `OPEN` |
| E4 | Observability baseline | P2 | Make production failures diagnosable | Structured server logging at route boundaries (replaces ad-hoc `console.error`) | No metrics/SaaS adoption without decision | — | Logs emitted in unified shape; suite green | §13.4 (candidate list) | `OPEN` |

### Decision Gate

| Item | Priority | Required decision | Why it cannot proceed |
|---|---|---|---|
| §9.3 doc-vs-code: `500 INTERNAL` vs `INTERNAL_ERROR` | Decision Gate | ~~`ARCHITECTURE CONFLICT / DECISION REQUIRED` — §9.3's locked table says the generic internal code is `INTERNAL`, but every route (and all tests) use `INTERNAL_ERROR` since A6. Resolve by doc-only correction **or** a mass route/error-code refactor (code-only change discouraged: client-facing code churn)~~ **RESOLVED — Decision 6, Option 1: implementation aligned with architecture** — generic 500 code `INTERNAL_ERROR` → `INTERNAL` at all 20 production sites (14 route files) + 3 test files; envelope shape, HTTP statuses, messages, and every other error code unchanged | History: surfaced during E1 pre-coding inspection; ruled OUTSIDE E1 scope; read-only investigation in Decision 6 (26 occurrences inventoried); user approved Option 1. Implementation commit `6691a89` (17 files, +26/−26). Gates: 234/234 tests, typecheck, lint, migrate status — clean. `architecture.md` untouched |
| G-02 populated-data closeout | Decision Gate | ~~Declare the empty DB the intended production state (retire 4B-2) **or** commit to a populated-data migration run per the synced plan doc~~ **RESOLVED — G-02 CLOSED: No Legacy Data Migration Required** | History: E2 run 3 produced the first non-vacuous populated-data evidence (0 blockers, 0 collisions; 1 user / 3 tasks / 2 DailyPlans; 0 invalid/Jalali-looking stored keys; analyzer exit 0). Decision: **no historical data migration was required** — the populated DB environment contained no legacy records needing rewrite; none was manufactured. Closing rationale is absence of legacy data, NOT an executed migration. `docs/daykey-canonical-migration-plan.md` intentionally left untouched (outside closeout scope): its historical preparation status (`CODE CUTOVER COMPLETE — DATA REWRITE NOT EXECUTED` / `closeout NOT CLAIMED`) is now factually stale and awaits its own doc-sync if desired |
| §8.12.1 change-password ADR | Decision Gate | ~~Ratify the documented deviation (stateless JWT; no session invalidation on password change) or schedule revocation design~~ **RESOLVED — Decision 2 (2026-09-09): ratification chosen** | ADR-06 created (`ADR-06-change-password.md`): deviation ratified; session invalidation/revocation explicitly excluded and requires a separate ADR. Gap G-§8.12.1 `CLOSED`. Doc-vs-code conflict in the other row (§9.3 `INTERNAL`) since RESOLVED by Decision 6 (implementation aligned) |
| `droppedTaskIds` API field | Decision Gate | Approve extending the API contract for §5.6.3 rollover candidates | Contract change; logged in C5 |
| §7.14 quota / entitlement | Decision Gate | Decide whether AI quota gating enters V1 | §7.14 defers it; entry requires a new ADR |

### Post-V1 / Deferred

As listed in `architecture.md` §13 (LOCKED candidate list): AI Coach, Planned-vs-Actual
analytics, PRO/Payment, external calendars, analytics dashboard, timezone change, MFA
planning, TimeEntry, General Offline Sync, push notifications, native apps,
moment-jalaali→Intl, Next.js upgrade, i18n-by-code, refresh tokens, object-storage avatars,
centralized logging/monitoring, distributed rate limiting.

---

## 6. Roadmap Maintenance Policy

1. `architecture.md` is the architectural source of truth.
2. `roadmap.md` tracks implementation against that architecture.
3. Every completed implementation phase MUST update `roadmap.md`.
4. Every new phase MUST be added to `roadmap.md` before implementation begins.
5. Phase status must be updated after verification.
6. Commit hashes should be recorded after successful commits.
7. Deferred items must remain visible rather than silently disappearing.
8. Product/ADR decisions must be explicitly recorded as pending until resolved.
9. The roadmap must never be used as justification for silently modifying architecture.
10. Any architecture deviation requires explicit approval and, where appropriate, an ADR.
