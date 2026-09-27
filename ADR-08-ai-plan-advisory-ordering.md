# ADR-08 — AI Daily Plan: AI Ordering Is Advisory; the Deterministic Planner Remains the Sole Scheduler

**Status:** ACCEPTED — 2026-09-27
**Reference:** Records the architectural decision made while implementing the AI Daily Plan
feature (Phase 1 contracts + Phase 2 backend/API).
**Related:** `architecture.md` §2 (Rebalance Engine as a contract), §3.5 (AI is optional / not
authority), §3.6 (Rebalance is lazy/on-demand), §3.7 (idempotent rebalance), ADR-03 (Lazy
Rebalance), ADR-05 (AI Is Optional), ADR-06 (Change Password), ADR-07 (Per-Task Notification).
**Supersedes:** none

> **Governance note.** `architecture.md` remains the authoritative source of truth and is **not**
> modified by this ADR. Sections 1–13 stay locked; this document records a new, additive decision
> following the same separate-file convention as `ADR-06-change-password.md` and
> `ADR-07-task-notification.md`.

---

## Context

The AI Daily Plan feature lets the user send the **complete current task set for one day** to the
AI and receive a structured proposal: the AI estimates task durations, scores relative importance,
and suggests an execution order (`order`). A proposal is returned before anything is applied.

The existing system already has **one** scheduler: the deterministic engine
(`app/lib/planner/rebalance.ts` — `weightOf()` / `distribute()`) surfaced through
`app/lib/planner/suggestion.ts` (`suggestDay()`). `architecture.md` §3.5 states that the AI is a
suggestion layer, not the decision authority, and ADR-05 ("AI Is Optional") locks that the final
scheduling decision is made by business rules / the Rebalance Engine / the user — never by the AI.

The feature therefore raised one architectural question: **does the AI's proposed `order` become
authoritative, creating a second scheduling path, or stay advisory?**

## Decision

1. **The AI order is advisory, never authoritative.** The AI's `order` is carried through the
   proposal as informational `aiOrder`. It does **not** override, replace, or re-rank the
   deterministic engine's output.
2. **The existing deterministic scheduler remains the sole scheduler.** `suggestDay()` /
   `distribute()` (the Rebalance Engine) is the only component that decides allocation, minimum
   allocation (15 min), granularity (5 min), partial allocation, and unfitted detection. No second
   scheduler, planner, or ordering algorithm is introduced.
3. **The AI feeds the engine's inputs, not its decisions.** The batch output contributes
   `estimatedMinutes` and `score` (and `priority` as metadata); those flow into the engine, which
   then computes the final plan. Capacity fitting is never delegated to the AI.
4. **`aiOrder` is informational/advisory.** The proposal exposes both: a deterministic `order`
   (the engine's rank — authority) and `aiOrder` (the AI's suggestion — advisory). The two may
   legitimately differ.
5. **This is Option A of the Phase 1 analysis** ("AI influences scheduler weights"): it satisfies
   both the product requirement (the AI recommends an order) and the architectural requirement
   (exactly one scheduler) with the smallest possible change and zero behavior change to the
   deterministic engine.

## Consequences

**Positive**
- No new scheduling path exists; `suggestDay()` behavior is unchanged and remains fully
  deterministic and idempotent (§3.7).
- The AI remains an optional, replaceable layer (§3.5 / ADR-05): swapping or degrading the AI
  cannot corrupt allocation, because allocation is computed downstream by the engine.
- The proposal is a pure, ephemeral artifact: no persistence and no mutation of `DailyPlan` or
  `Task` allocation.

**Trade-offs / limits**
- The AI's explicit `order` may not match the final planned order. This is intentional and
  documented; users see the engine's order, with the AI order available as a suggestion.
- If a future product decision wants the AI order to be authoritative, that is a **new**
  architectural decision requiring its own ADR (it would risk introducing a second scheduler) and
  is explicitly out of scope here.

## Non-goals (explicitly not authorized)

Creating a second scheduler/planner; moving capacity enforcement into the AI prompt; persisting
the AI ordering; changing `rebalance.ts`, `suggestDay()`, or `distribute()`; changing the lazy
Rebalance contract (ADR-03).
