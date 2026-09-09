# DailyPilot — Canonical Implementation Roadmap

> **`architecture.md` is the source of truth.** This file tracks implementation work against
> that baseline and cannot override, reinterpret, or silently change architectural decisions.
> Where implementation and architecture disagree, this roadmap records the item as
> `ARCHITECTURE CONFLICT / DECISION REQUIRED` instead of resolving it silently.

Last synced: **E3 — V1 Release Readiness: PASS** (2026-09-09) · Decision Gate CLOSED (2026-09-09) — all seven decisions recorded; no required implementation decisions blocking V1 MVP.
Implementation baseline: `6691a89` (Decision 6: §9.3 `INTERNAL` alignment) · G-02 closeout `4481bee` · DayKey plan-doc sync `7e86a10` · Decision Gate closure `03ee512` · earlier: Decision 2 (ADR-06) after `f6f4430` (Phase E2).
Evidence basis: direct repository inspection (§-references verified in `architecture.md`,
commit hashes verified via `git log`).

---

## 1. Project Status

| Dimension | Status | Notes |
|---|---|---|
| **Overall V1 status** | `RELEASE READY (MVP)` — was `PARTIALLY COMPLETE` | Core domains complete and architecture-conformant; Decision Gate CLOSED; E3 V1 release-readiness PASS (2026-09-09). Remaining P2 items (E3 component/integration test consolidation, E4 observability) are improvement work, not release blockers |
| **Core V1 implementation** | `COMPLETE` | Tasks, Daily Planning/Rebalance, AI analysis, Time Tracking, Auth, Rollover, Offline Queue (limited), PWA — all implemented and regression-tested |
| **Architecture alignment** | `COMPLETE` | All §6.4 / §7.12 / §9.10 / §11.4 registered gaps closed; 226 tests green across 24 files; typecheck + lint clean |
| **Release readiness** | `COMPLETE` (E2 run 3) — **E3 release-readiness PASS (2026-09-09)** | Full authenticated lifecycle verified over real HTTP with live `JWT_SECRET`: register+auto-session, login, task create (server-derived dayKey = Tehran-midnight instant), day budget, mock-AI analyze (attribution `aiSource=mock`), explicit-category preservation, complete+spentMinutes=90 (status DONE, completedOn=today), day summary (spent=90), stale detection (v2 > rv=1), lazy rebalance proven via read-only rv advance (2→3), overdue list, rollover (past→today), history markers, logout cookie-clear, negatives (400/404/401, ADR-04 codes incl. domain `TASK_NOT_FOUND`). Analyzer on populated data: 1 user / 3 tasks / 2 plans — 0 blockers, 0 collisions, 0 invalid keys; 2 expected pre-cutover `dayKey-scheduledDate-drift` warnings (canonical keys re-read as Jalali → year 2647), which itself evidences canonical storage. Smoke data cleaned guarded; DB back to exact baseline zeros. Deploy check `deployable=true`, 0 problems. Gates: 234/234 tests, typecheck, lint, migrate status — all clean; `architecture.md` untouched. Run-1 landing-500 was diagnosed as the missing-secret throw (not SSR); its one-line `"use client"` in DashboardPreview was proven redundant (framer-motion ships its own boundary) and excluded from E2 commit. **E3 verdict pass (read-only, zero implementation changes): 59/59 lifecycle checks over live HTTP** (register 201 + auto-session, login, create w/ server-derived dayKey + Tehran-midnight instant, budget pv1→pv2 with rv=null per §6.3.2 fresh-plan-stale, summary read, lazy rebalance proven via read-only rv 1→2, analyze `aiSource=mock` + explicit category preserved, PATCH complete DONE spent=90 completedOn=today, overspent consistent, overdue, rollover past→today, history markers, **ADR-06 change-password contract** (old JWT stays valid; old password 401 after change), negatives 400/404 `TASK_NOT_FOUND`/401 ×2, logout cookie-clear); **19/19 analyzer+security checks**: populated-data analyzer (2 users/3 tasks/1 plan) — blockers 0, collisions 0, invalid keys 0, exit 0; cross-user GET/PATCH/complete by user B on user A's task → 404 `TASK_NOT_FOUND`; **UI smoke**: `/`, `/auth/login`, `/auth/register` 200 with forms, `/dashboard` 307→200 with session (real task/planner markup, no crash/blank), PWA manifest + sw.js present; **build**: production build OK (21 routes) — unbounded default worker fan-out hits the sandbox 2 GiB cgroup (environmental; bounded run green, repo unchanged); **deploy check** `deployable=true`, 0 problems; gates 234/234 tests (25 files), typecheck, lint, migrations — clean; smoke data cleaned to exact baseline; temp scripts deleted pre-commit. **One non-blocking finding E3-1**: `POST|GET /api/planner/day` accepts a calendar-invalid lexical dayKey (`2026-13-99` matches the schema regex) → 200 + plan row; no §6.3.1 conformance breach (format is canonical-shaped), no data corruption; candidate hardening for a future phase |
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
| E3 | V1 release readiness pass (release verdict, not the P2 test-consolidation phase) | `COMPLETE` — **PASS** | — (read-only; roadmap-only commit) | 59/59 lifecycle + 19/19 analyzer/security checks over live HTTP; ADR-06 contract live-verified; UI smoke clean; production build OK (worker cap = sandbox artifact); deploy check `deployable=true`; gates 234/234 + typecheck + lint + migrations clean; smoke data cleaned to exact baseline; 1 non-blocking finding (E3-1: lexical calendar-invalid dayKey accepted by planner/day); zero implementation changes; **V1 RELEASE READY (MVP)** |

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

### E3 — V1 Release Readiness Pass (2026-09-09) — PASS

Release-readiness verdict for the locked V1 scope, evaluated as an MVP (blockers only; scope rules per the E3 phase instruction — no security-audit/hardening program, no feature work):

- **Verdict: PASS — DailyPilot V1 is Release Ready for MVP.** Zero implementation changes required; zero release blockers found.
- **Build/deploy:** production build OK (21 routes; sandbox requires bounded build workers — environmental, repo unchanged); `freebuff-deploy check` `deployable=true`, 0 problems; required env names inventoried (`JWT_SECRET` required in production, verified live without exposure; `AIXAI_API_KEY` optional — absent triggers documented mock fallback per §7.13; `AIXAI_BASE_URL`/`AIXAI_MODEL`/`AI_TIMEOUT_MS`/`AI_MAX_ATTEMPTS` optional tunables; `DATABASE_URL` managed by the platform).
- **Critical journey (59/59 over live HTTP):** register 201 + auto-session (§8.2), profile 200, login 200, create 201 (server-derived canonical dayKey `2026-09-09`, scheduledDate = Tehran-midnight instant), PATCH category `Work`, day budget 200 (fresh plan `pv=1, rv=null` — §6.3.2 fresh-plan-stale; bump `pv=2, rv=null` still stale), GET summary 200 (`hasPlan`, `availableMinutes=240`), **lazy rebalance proven via read-only `rv` 1→2** (ADR-03), analyze 200 `aiSource=mock` + explicit category preserved (§7.5), PATCH complete 200 (`DONE`, `spentMinutes=90`, `completedOn=2026-09-09`), summary `spentMinutes=90/doneTasks=1` + overspent consistent, overdue lists past task, rollover `{from: yesterday → to: today}` with canonical recompute via PATCH, history `[{dayKey, doneCount:1, savedMinutes, overspentMinutes}]`, negatives: 400 `VALIDATION_ERROR` (malformed JSON), 404 `TASK_NOT_FOUND`, 401 `UNAUTHORIZED` ×2 (no token / bad token), logout 200 + cookie cleared (`Max-Age=0`) + post-logout 401.
- **Auth/session (V1 baseline):** all 401/200 paths verified; **ADR-06 change-password contract live-verified**: 200 success, existing JWT remains valid afterwards (stateless, no invalidation), old password → 401 `INVALID_CREDENTIALS` after change, new password logs in.
- **DayKey (G-02 context, not reopened):** server-derived canonical Gregorian; timezone respected (Tehran-midnight instant); client cannot override (dayKey accepted only as display context on GET); stored keys `YYYY-MM-DD`; populated analyzer run — blockers 0, collisions 0, invalid/Jalali-looking keys 0, exit 0. **No migration performed; G-02 stays closed.**
- **Planning/DailyPlan:** budget mutation + version/stale semantics + lazy rebalance verified; summary math verified (spent/saved/overspent/committed); task source-of-truth fields not corrupted by allocation (`allocatedMinutes` computed, content fields untouched). No `droppedTaskIds` (deferred).
- **AI:** mock fallback correctly labeled `aiSource=mock`; result persisted; explicit category preserved; no provider/architecture changes.
- **Security boundary (spot-check only, NOT an audit):** cross-user GET / PATCH / complete by user B on user A's task → 404 `TASK_NOT_FOUND` (no cross-user leakage); no-auth and bad-token → 401; no secrets in client bundles observed; no blocker found. No new security project opened.
- **UI/runtime:** `/`, `/auth/login`, `/auth/register` → 200 with real forms/copy; `/dashboard` unauthenticated → 307 redirect; with session → 200 rendering real task/planner UI (no crash/blank screen); PWA `manifest.webmanifest` + `sw.js` served and linked. No visual redesign performed.
- **Data hygiene:** all smoke identities (`e3release_probe`, `e3pop_a/b`, `e3ui_probe`) cleaned guarded (exact email+username match, caps, dependents-first); DB returned to exact pre-E3 baseline (all tables 0) after every run; temp scripts deleted before commit.
- **Non-blocking finding E3-1:** `POST|GET /api/planner/day` accepts a calendar-invalid lexical dayKey (`2026-13-99` satisfies the `\d{4}-\d{2}-\d{2}` schema regex) → 200 + plan row persisted. Not a §6.3.1 breach (format canonical-shaped; the canonical-day derivation itself is proven correct), no data corruption, no crash — recorded as future hardening candidate, intentionally NOT fixed in E3.
- **Naming note:** this pass is the release-readiness verdict; the pre-existing planned P2 phase "E3 — Component/integration test consolidation" (below) remains `OPEN` and unaffected.

### P2 — Release Readiness / Hardening

| Phase | Title | Priority | Objective | Scope | Non-goals | Dependencies | Expected verification | Architecture refs | Status |
|---|---|---|---|---|---|---|---|---|---|
| E3 | Component/integration test consolidation | P2 | Cover UI flows that service/route tests don't reach | React component tests for completion modal, reanalyze modal, task card states; integration flow tests | No production behavior changes | None (vitest already present) | New tests green; suite green | §11.4 | `OPEN` |
| E4 | Observability baseline | P2 | Make production failures diagnosable | Structured server logging at route boundaries (replaces ad-hoc `console.error`) | No metrics/SaaS adoption without decision | — | Logs emitted in unified shape; suite green | §13.4 (candidate list) | `OPEN` |

### Decision Gate

| Item | Priority | Required decision | Why it cannot proceed |
|---|---|---|---|
| §9.3 doc-vs-code: `500 INTERNAL` vs `INTERNAL_ERROR` | Decision Gate | ~~`ARCHITECTURE CONFLICT / DECISION REQUIRED` — §9.3's locked table says the generic internal code is `INTERNAL`, but every route (and all tests) use `INTERNAL_ERROR` since A6. Resolve by doc-only correction **or** a mass route/error-code refactor (code-only change discouraged: client-facing code churn)~~ **RESOLVED — Decision 6, Option 1: implementation aligned with architecture** — generic 500 code `INTERNAL_ERROR` → `INTERNAL` at all 20 production sites (14 route files) + 3 test files; envelope shape, HTTP statuses, messages, and every other error code unchanged | History: surfaced during E1 pre-coding inspection; ruled OUTSIDE E1 scope; read-only investigation in Decision 6 (26 occurrences inventoried); user approved Option 1. Implementation commit `6691a89` (17 files, +26/−26). Gates: 234/234 tests, typecheck, lint, migrate status — clean. `architecture.md` untouched |
| G-02 populated-data closeout | Decision Gate | ~~Declare the empty DB the intended production state (retire 4B-2) **or** commit to a populated-data migration run per the synced plan doc~~ **RESOLVED — G-02 CLOSED: No Legacy Data Migration Required** | History: E2 run 3 produced the first non-vacuous populated-data evidence (0 blockers, 0 collisions; 1 user / 3 tasks / 2 DailyPlans; 0 invalid/Jalali-looking stored keys; analyzer exit 0). Decision: **no historical data migration was required** — the populated DB environment contained no legacy records needing rewrite; none was manufactured. Closing rationale is absence of legacy data, NOT an executed migration. References: closeout commit `4481bee` (roadmap); plan-doc sync `7e86a10` (`docs/daykey-canonical-migration-plan.md` now carries the same closeout with history preserved) |
| §8.12.1 change-password ADR | Decision Gate | ~~Ratify the documented deviation (stateless JWT; no session invalidation on password change) or schedule revocation design~~ **RESOLVED — Decision 2 (2026-09-09): ratification chosen** | ADR-06 created (`ADR-06-change-password.md`): deviation ratified; session invalidation/revocation explicitly excluded and requires a separate ADR. Gap G-§8.12.1 `CLOSED`. Doc-vs-code conflict in the other row (§9.3 `INTERNAL`) since RESOLVED by Decision 6 (implementation aligned) |
| `droppedTaskIds` API field | Decision Gate | ~~Approve extending the API contract for §5.6.3 rollover candidates~~ **RESOLVED — DEFERRED: NOT PART OF V1 API** | History: contract change flagged during C5 (rollover candidates are derivable from task allocation state). Final decision (2026-09-09): do NOT add `droppedTaskIds` to the V1 API contract; no new API field for this gate; revisit only if a future product/API requirement makes it necessary. No implementation change |
| §7.14 quota / entitlement | Decision Gate | ~~Decide whether AI quota gating enters V1~~ **RESOLVED — DEFERRED: POST-V1** | History: §7.14 LOCKED; §13.1 "PRO … Entitlement/Quota فقط با نیاز واقعی"; entry would require a new ADR. Final decision (2026-09-09): no quota entity, no quota counters, no payment/billing integration, no entitlement enforcement, no new database model, no V1 implementation. Explicitly Post-V1 |

### Decision Gate — Closure (2026-09-09)

**DECISION GATE: CLOSED** — there are no remaining required implementation decisions blocking V1 MVP completion. The remaining deferred items are intentionally outside V1 scope.

Final status of every gate item (history preserved above; nothing rewritten as if always decided):

| # | Item | Final status | Evidence / reference |
|---|---|---|---|
| 1 | Registration auto-login | `CLOSED — RATIFIED / ARCHITECTURE-CONFORMANT` | Implementation consistent with §8.2 auto-login requirement (gap G-§8.13); no implementation change |
| 2 | Change password | `CLOSED — RATIFIED via ADR-06` | `ADR-06-change-password.md`; stateless JWT kept; no invalidation of issued JWTs; revocation needs a separate future ADR; no implementation change |
| 3 | G-02 Canonical DayKey Migration | `CLOSED — No Legacy Data Migration Required` | Code cutover complete; populated smoke verification complete (1 user / 3 tasks / 2 DailyPlans — 0 blockers, 0 collisions, 0 invalid/Jalali-looking keys, `analyze:daykey` exit 0); **G-02 is closed because no legacy data requiring migration was present, not because a historical migration was executed**; no rewrite was executed. Refs: `4481bee` (closeout), `7e86a10` (plan-doc sync) |
| 4 | `droppedTaskIds` | `DEFERRED — NOT PART OF V1 API` | Derivable from allocation state; no API field added; revisit only on future product/API need |
| 5 | Quota / entitlement (§7.14) | `DEFERRED — POST-V1` | No quota entity/counters/billing/entitlement enforcement/new DB model in V1 |
| 6 | Hosting | `DEFERRED` | `freebuff-deploy check` establishes deployability (`deployable=true`), not a hosting-provider decision; no provider selected or implemented |
| 7 | Generic 500 error code conflict | `CLOSED — RESOLVED via Decision 6, Option 1` | Architecture requires `INTERNAL`; implementation aligned (`INTERNAL_ERROR` → `INTERNAL`, 20 sites + tests); ref `6691a89`; conflict history preserved above |

### Post-V1 / Deferred

As listed in `architecture.md` §13 (LOCKED candidate list): AI Coach, Planned-vs-Actual
analytics, PRO/Payment, external calendars, analytics dashboard, timezone change, MFA
planning, TimeEntry, General Offline Sync, push notifications, native apps,
moment-jalaali→Intl, Next.js upgrade, i18n-by-code, refresh tokens, object-storage avatars,
centralized logging/monitoring, distributed rate limiting.

Deferred by Decision Gate closure (2026-09-09): `droppedTaskIds` API field (revisit on future
product/API need), §7.14 quota/entitlement (Post-V1), final hosting-provider selection.
Release-readiness phases E3 (component/integration tests) and E4 (observability) remain `OPEN`
as planned P2 work — intentionally outside the Decision Gate. (The E3 label above refers to the
2026-09-09 release-readiness pass, distinct from the planned P2 test-consolidation phase.)

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
