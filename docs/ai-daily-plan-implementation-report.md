# AI Daily Plan — Implementation Report

**Feature:** «ایجاد برنامه با هوش مصنوعی» (advisory AI daily planning)
**Branch:** `feat/ai-daily-plan`
**Scope of this document:** state of the implementation against the original feature spec,
the gap-closing audit pass, and the explicit decisions that remain open.

> This report is written for the repo, not for a chat. It is factual: every claim below is
> either traceable to a file/line in this branch or to a test in this branch.

---

## 1. Files changed by the audit pass

Changes made after the feature commits (`cb75bcc`, `e0ff6f1`, `8933a2b`) to close the
remaining spec gaps. No architecture was redesigned.

| File | Change |
|---|---|
| `app/lib/planner/planProposal.ts` | Carries the AI's `reason` on `planned[]` and `unfitted[]` |
| `app/schema/plannerSchema.ts` | Accepts/bounds `reason` on the untrusted Apply request |
| `app/lib/planner/planProposalFlow.ts` | `reason` in the client mirror types; new `isStale` state + `invalidate()` + `PLAN_PROPOSAL_STALE_MESSAGE` |
| `app/components/task/planProposalView.ts` | `reason` in the view row + `normalizeReason()` (empty/whitespace/non-string → `null`) |
| `app/components/task/PlanProposalModal.tsx` | Renders `ReasonNote` for planned and unfitted rows (renders nothing when absent) |
| `app/components/task/planProposal.module.css` | New `.reason` style (visually distinct from data `.tag`s) |
| `app/hooks/usePlanProposal.ts` | Exposes `invalidate`, `isStale`, `staleMessage`; `planner:mutated` now uses `invalidate` |
| `app/components/task/DailyTaskList.tsx` | Day switch uses `invalidate`; stale banner with «ایجاد برنامه جدید» CTA |
| `app/api/planner/plan/route.test.ts` | **+2 concurrent-Generate tests** |
| `app/api/planner/plan/apply/route.test.ts` | Schema accepts `reason`; rejects over-long `reason` |
| `app/lib/planner/planProposal.test.ts` | `reason` present/absent/neutrality (4 tests) |
| `app/lib/planner/planProposalFlow.test.ts` | Stale UX vs 409 separation (7 tests); `reason` round-trip (1 test) |
| `app/components/task/planProposalView.test.ts` | `reason` normalization (3 tests) |
| `app/lib/services/planApply.service.test.ts` | Fixtures updated for the new field |

## 2. Files created

- `app/lib/planner/planLifecycle.integration.test.ts` — integration-level coverage of the spec §24 main lifecycle (10 tests)
- `docs/ai-daily-plan-implementation-report.md` — this report

## 3. Files deleted

None.

## 4. API endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/planner/plan` | Generate an ephemeral advisory proposal. Consumes 1 AI quota unit. No mutation. |
| `POST` | `/api/planner/plan/apply` | Apply a proposal to the day. Consumes **0** quota units. No AI call. |

**Generate request** — only a day selector; the client cannot inject tasks or capacity:
```json
{ "dayKey": "2026-09-27" }
```

**Apply request** — the proposal is round-tripped verbatim from Generate:
```json
{ "dayKey": "2026-09-27", "expectedPlanVersion": 3, "proposal": { ... } }
```

## 5. AI input contract

`PlanInput` (`app/lib/ai/planContract.ts`), built server-side from the DB by
`getPlanGenerationContext` (`app/lib/services/plan.service.ts`) — never from the request body:

```ts
{
  dayKey: string                  // canonical "YYYY-MM-DD"
  availableMinutes: number        // from DailyPlan
  tasks: Array<{
    taskId: number                // Int autoincrement
    title: string
    category: string | null
    existingEstimatedMinutes: number | null
    existingScore: number | null
    existingPriority: "HIGH" | "MEDIUM" | "LOW" | null
  }>
}
```

The input is the **complete open task set of the day**. There is no incremental/partial mode.

## 6. AI output contract

`AiBatchPlan` (`app/lib/ai/planSchema.ts`):

```ts
{
  items: Array<{
    taskId: number               // positive int
    estimatedMinutes: number     // int, 5..480
    score: number                // int, 0..100
    priority: "HIGH" | "MEDIUM" | "LOW"
    order: number                // positive int, unique — ADVISORY only
    reason?: string              // 1..300 chars — informational only
  }>                             // min 1 item
  unscheduledTaskIds?: number[]  // optional, unique, disjoint from items
  summary?: string               // optional, max 600
}
```

## 7. Prompt strategy

`app/lib/ai/analyzeBatchPlan.ts`:

- System prompt is explicit that the model is an **analyst, not the scheduler**, and that final
  ordering and capacity allocation belong to the system engine.
- Output is required to be a **raw JSON object only** (no markdown, no prose).
- On a retry, `SYSTEM_PROMPT_STRICT` appends a stricter output instruction.
- Shared transport (`app/lib/ai/providerClient.ts`): 3 attempts, 12s per attempt, exponential
  backoff with jitter, retry only on 408/429/5xx/network. 4xx never retries.
- Environment policy: non-production falls back to a deterministic mock
  (`source: "mock"`); production never returns a mock as success and throws
  `AiProviderUnavailableError` instead.

## 8. Validation

Two layers, both required:

1. **Structural (zod, `planSchema.ts`)** — bounds, types, duplicate `taskId`/`order`/
   `unscheduledTaskIds`, and overlap between `items` and `unscheduledTaskIds`.
   Tolerates markdown fences via the existing `extractJson` repair helper.
2. **Relative to input (`planContract.validateBatchPlan`)** — every returned id must exist in the
   input, and every input task must appear exactly once across the two lists.

On failure: quota is released with `failureCode`, the request returns `502 AI_PLAN_INVALID`, and
**nothing is written to the database**.

**Apply is a second, independent trust boundary.** The proposal arrives from the client and is
treated as raw input: `planApplyRequestSchema` re-validates structure, then
`applyPlan` re-checks ownership, day, status and version against the DB. Any mismatch →
`409 PLAN_STALE` with **zero mutation**.

## 9. Quota

- Reuses the existing quota service (`aiQuota.service` / `aiUsage.service`). No second system.
- One Generate = **1 unit**, reserved before the AI call and completed only on success; released
  (with a `failureCode`) on provider failure or invalid output. Release failure is fail-closed and
  marked for reconciliation.
- Apply consumes **0** units and makes no AI call.
- Reservation is atomic (CAS inside a transaction, bounded optimistic retry) and idempotent per
  `requestId`. Each request gets its own `requestId` from `randomUUID`.

## 10. Concurrency

### Generate

Verified empirically in this audit (see §15). Two simultaneous Generate requests for the same
user/day are **independent and safe**:

- both return `200` with a valid proposal;
- the AI provider is called exactly once per request;
- each request reserves and completes exactly 1 quota unit;
- `requestId`s are distinct, so `reserveQuota`'s idempotency check never collides and the CAS
  reservation succeeds for both;
- no partial mutation — a proposal is never persisted.

**No implementation change was made**: the behavior is already controlled and consistent with the
spec (§19: every Generate that reaches the AI is one AI request and one unit). Two tests now lock
this in.

### Apply

The optimistic version guard (`updateMany` with `planVersion: expectedPlanVersion` → increment)
makes concurrent Apply safe: of two concurrent applies on the same version, exactly one commits
and the other rolls back entirely. Covered by an existing test.

### Client

The request-sequence guard means **the newest Generate wins**; an older in-flight response can
never overwrite or reopen the current proposal. An in-flight Generate is also cancelled when the
proposal is discarded.

### Rate limiting

`isRateLimited("plan:user:<id>", 5, 15min)` — in-process, per instance, matching the existing
project convention. Not a distributed limiter.

## 11. Stale / version control

| Situation | Mechanism | User-visible result |
|---|---|---|
| Any planner mutation (`planner:mutated`), day switch, or capacity change while a proposal is open | Client-side `invalidate()` — discards the proposal, invalidates in-flight requests, sets `isStale` | Stale banner + «ایجاد برنامه جدید» CTA. No backend call. |
| User clicks Apply on an outdated proposal | Backend `applyPlan` version guard → `409 PLAN_STALE` | Proposal discarded, error message shown. No mutation, no forced re-apply. |
| Day/task changed between Generate and Apply (detected server-side) | Same `409 PLAN_STALE` | Same as above. |

These two are deliberately distinct and both are covered by tests: client invalidation sets
`isStale`; a backend `409` does not (it surfaces as an error message).

## 12. Planner integration

The AI is advisory and is **not** a scheduler (see `ADR-08-ai-plan-advisory-ordering.md`).

`buildPlanProposal` maps the AI's `estimatedMinutes` / `score` / `priority` onto the canonical
engine input and calls the **existing** `suggestDay()` / `distribute()`. The deterministic engine
remains the sole authority for allocation, minimum allocation (15 min), granularity (5 min),
partial allocation, and unfitted detection. The AI's `order` is carried as `aiOrder` and never
overrides the engine's rank. `rebalance.ts` and `suggestion.ts` are unmodified.

**`reason` does not participate in any decision.** A test asserts that the same input with and
without `reason` produces an identical engine output.

## 13. Frontend flow

```
«ایجاد برنامه» → generate(dayKey) → proposal in store
       ↓
PlanProposalModal: capacity summary, planned list, unfitted list, per-task reason/priority/score
       ↓
«تأیید و اعمال برنامه» → apply() targeting the proposal's OWN basis.dayKey
   «فعلاً نه»        → clear() (no mutation)
```

Modal close/reject performs **no** mutation. The Apply button is disabled while applying, and
close is locked while an apply is in flight.

## 14. Proposal / apply behavior

- The proposal is **ephemeral** — no `PlanProposal` table exists. Reject stores nothing.
- Apply writes only `estimatedTime`, `score` and `priority` to `TODO` tasks. `IN_PROGRESS` and
  `DONE` tasks are protected. `Task.reason` is deliberately **not** written by this flow.
- Allocation after Apply comes from the existing lazy rebalance path, so the shown proposal and
  the post-apply state agree.
- Apply is all-or-nothing: any mid-transaction failure rolls back both the version bump and the
  task writes.

## 15. Tests

**29 tests added in this pass** (baseline 1615 → 1644 passing).

- `app/api/planner/plan/route.test.ts` — 2 concurrent-Generate tests (gated so both requests are
  genuinely in-flight at the AI at the same time; plus a mixed success/failure quota test).
- `app/lib/planner/planLifecycle.integration.test.ts` — 10 tests, real service layers
  (`plan.service` → `analyzeBatchPlan` → `parseAiPlanJson` → `validateBatchPlan` →
  `buildPlanProposal` → `applyPlan` → `planProposalFlow`); only the network, Prisma (with
  faithful rollback) and the lazy-rebalance read path are faked. Covers the spec §24 lifecycle,
  full re-analysis on regenerate, deleted/foreign task exclusion, reject-without-mutation,
  capacity overflow, and malformed AI output (including the production no-mock policy).
- `app/lib/planner/planProposalFlow.test.ts` — 7 stale-UX tests + 1 reason round-trip test.
- `app/lib/planner/planProposal.test.ts` — 4 reason tests (planned, unfitted, absent, engine-neutrality).
- `app/components/task/planProposalView.test.ts` — 3 reason normalization tests.
- `app/api/planner/plan/apply/route.test.ts` — 2 schema tests for `reason`.

### Test results

```
TypeScript (npx tsc --noEmit):  PASS
Feature tests:                  PASS (188 passed across planner/plan routes/view/apply)
Full suite:                     29 failed | 1644 passed | 19 skipped
```

The 3 failing files are **pre-existing and unrelated to this feature** — all of them require a real
PostgreSQL instance that is unavailable in this environment, and the suite is explicitly
configured to fail rather than silently skip:

- `app/lib/services/aiQuota.concurrency.db.test.ts` — `REAL_POSTGRESQL_UNAVAILABLE`
- `app/lib/services/userActivity.concurrency.db.test.ts` — `REAL_POSTGRESQL_UNAVAILABLE`
- `src/lib/observability/__tests__/errorLog.persistence.db.test.ts` — `REAL_POSTGRESQL_UNAVAILABLE`

These fail identically before and after this pass (verified at baseline before any edit).

> Note: `app/lib/services/pushSubscription.db.test.ts` was expected to be a known failure; it
> currently **passes**. The real DB-gated baseline failures are the three files above.

## 16. Known limitations

1. **No browser E2E test.** The repo has no Playwright/Cypress and vitest runs in a `node`
   environment with no DOM. No new test framework was added for this. The closest executable
   equivalent is `planLifecycle.integration.test.ts`; the React rendering path
   (`PlanProposalModal`) is only covered through the pure view model, not through a mounted
   component.
2. **Rate limiting is per-instance and in-memory.** On a multi-instance deployment it is not a
   global limit.
3. **No persisted proposal history**, analytics, or AI-vs-user plan comparison. Intentional for V1
   (spec §18).
4. **Task names not resolved for deleted tasks** are shown as a safe placeholder with a
   «حذف‌شده» tag.
5. `aiBatchPlanSchema` requires at least one `items` entry. If the AI places every task in
   `unscheduledTaskIds`, the response is rejected as `AI_PLAN_INVALID`. Rare edge case, not
   addressed in this pass.
6. The AI never receives task **descriptions** — the `Task` model has no description field.

## 17. Migrations / environment

**Migrations:** none. No schema or Prisma model was changed in this pass. `Task.reason` already
existed and is intentionally left untouched by the Apply flow.

**Environment variables:** no new variables. This feature reuses the existing
`AIXAI_API_KEY` / `AIXAI_BASE_URL` / `AIXAI_MODEL` provider configuration and the existing quota
policy.

---

## 18. Intentional deviations from the original spec

| # | Spec | Implementation | Rationale |
|---|---|---|---|
| 1 | `POST /api/ai/daily-plan` | `POST /api/planner/plan` (+ `/apply`) | Matches the existing repo structure instead of a parallel `app/api/ai/` tree (spec §26 explicitly asked to follow the real repository conventions). |
| 2 | Request carries `tasks[]` and `availableMinutes` | Request carries **only** `dayKey` | The backend must own ownership and capacity; a client-supplied task list or capacity is a trust hole (spec §7/§9 require the opposite of trusting the body). |
| 3 | `taskId: "task-1"` (string) | `taskId: number` | `Task.id` is an `Int`. Numeric strings are still coerced by the schema. |
| 4 | `dayKey: "1405-07-03"` (Jalali) | Canonical `YYYY-MM-DD` | Matches the project's canonical day key, validated by `isValidCanonicalDayKey`. |
| 5 | `priority: number 1..10` | `score: 0..100` + `priority: HIGH/MEDIUM/LOW` | Matches the existing `Task.score` and `TaskPriority` model. A single 1–10 number conflates importance and urgency. |
| 6 | §12: real time slots (`09:00–09:45`) | **Not implemented** | See below — requires a new architectural decision. |
| 7 | §33: "your plan changed" indicator | Implemented as an invalidation banner with a regenerate CTA | The spec's intent (tell the user why the proposal disappeared) is met; the exact copy is the project's. |

## 19. Open decisions

### SPEC/ARCHITECTURE DECISION REQUIRED — Time Slot (§12)

The spec asks the backend to render real clock times (`09:00–09:45`). This was **not**
implemented, deliberately. Current state of the codebase:

- `DailyPlan` stores only `availableMinutes`, `planVersion`, `rebalancedVersion`.
- `Task` stores only `allocatedMinutes` (a duration), never a start or end time.
- A search across `app/lib/planner`, `app/lib/services` and `app/schema` finds **no**
  `startTime`, `endTime`, `timeSlot`, or `scheduledStart` anywhere.

Satisfying §12 would therefore require all of:

1. a **schema migration** (a start instant per task, or a slot entity);
2. a new **day-start anchor** concept — the spec says the day's start time must come from
   "existing project logic", but no such logic exists;
3. a new **packing pass** that turns the engine's `allocatedMinutes` into a clock timeline —
   i.e. a second scheduler, which §6, §29 and §34.1 explicitly forbid.

Per instruction, no scheduler, no `startTime`/`endTime` in the AI contract, and no AI-assigned
clock time were introduced. This needs an explicit product/architecture decision (and its own ADR)
before any implementation.

### Reminder commit on this branch — merge/scope risk (not a feature bug)

Commit `cb75bcc feat(reminders): add DB-backed per-task reminders with web push and offline recovery`
sits on this branch, directly on top of the merge-base with `main` (`6a87c9c`). Findings:

- **introduced by this branch: YES** — it is the first commit after the merge-base and exists on
  no other remote branch; it is not an ancestor of `origin/main`.
- **required by AI Daily Plan: NO** — no file in the AI Daily Plan surface imports any reminder or
  push module (the only occurrence is a comment in `app/api/planner/plan/route.ts`).
- **conflicts with main: YES** — `main` carries its own separate notifications implementation
  (`f5f182d`, merged via PR #8). Merging produces conflicts in 8 files: `AppShell.tsx`,
  `DailyTaskList.tsx`, `TaskCard.tsx`, `offline.ts`, `services/errors.ts`, `package.json`,
  `prisma/schema.prisma`, `public/sw.js`.
- **action taken: none.** No history was rewritten. The AI plan and the reminder work share
  several touched files (`DailyTaskList.tsx`, `AppShell.tsx`, `package.json`, `schema.prisma`),
  so removing the commit is a scope decision for the owner, not a mechanical step. The feature
  itself has no dependency on it.

## 20. Merge readiness

| Area | Status |
|---|---|
| Feature core (generate/apply/proposal/modal) | Implemented |
| Concurrent Generate safety | Implemented (behavior was already correct; now test-locked) |
| AI `reason` surfaced to the user | Implemented |
| Stale proposal UX (both client and 409 paths) | Implemented |
| Integration coverage of the spec §24 lifecycle | Implemented |
| Browser E2E | Requires separate test-framework decision (none in repo) |
| Time Slot (§12) | Requires product/spec decision |
| Reminder commit scope on this branch | Requires separate branch cleanup (owner decision) |
| `REAL_POSTGRESQL_UNAVAILABLE` test failures | Known unrelated baseline failure |
