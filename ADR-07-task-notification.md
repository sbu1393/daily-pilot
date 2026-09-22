# ADR-07 — Per-Task Notification via Web Push (Incremental Activation)

**Status:** ACCEPTED — 2026-09-22
**Reference:** Incrementally activates the "Notifications / Task Reminders" domain deferred in
`architecture.md` §5.10, §5.11 and §13.1.
**Related:** §5.10 (Notifications — Deferred), §6.2.2.1 (dayKey/timezone), ADR-04 (Standard API Response).
**Supersedes:** none

> **Governance note.** `architecture.md` remains the authoritative source of truth and is **not**
> modified by this ADR. Sections 1–13 stay locked; this document records a new decision that
> activates a previously deferred domain gradually, following the same separate-file convention
> as `ADR-06-change-password.md`.

---

## Context

Per-task reminders already exist in V1 as `Task.reminderAt` (a nullable absolute instant, converted
from the Jalali/Persian UI using `User.timezone`). Delivery today is in-app only, through
`TaskReminderWatcher`, and therefore only works while the app/tab is open. The Notification domain
is still formally Deferred.

To let a reminder reach the user while the PWA is closed, the domain is activated **incrementally**
using standards-based Web Push.

## Decision

1. **Delivery channel: Web Push.** Reminders are delivered through browser Push, not an OS alarm.
   Web Push is explicitly **not an alarm**: delivery timing is controlled by the OS/browser and is
   not guaranteed to the second.
2. **Per-task reminder stays the source of truth.** `Task.reminderAt` is unchanged; no second or
   parallel reminder model is introduced.
3. **Subscriptions are owned by the user.** A `PushSubscription` entity (User 1—N) stores
   `endpoint` (unique) plus `p256dh` and `auth`, cascade-deleted with the User. Ownership is
   resolved from the authenticated session; `userId` is never accepted from the request body.
4. **Server-side scheduler is deferred to the next phase.** This ADR authorizes subscription
   storage and registration **only**: no sending, no cron/worker, and no Service Worker `push`
   handler yet. The `web-push` dependency is not added in this phase.
5. **Native delivery is a separate layer.** A future native Android/iOS app may replace the
   delivery layer without changing reminder logic or the domain.
6. **Offline local notification is out of scope.** No Notification Triggers, Periodic Background
   Sync, IndexedDB, or offline scheduling in this decision.
7. **VAPID keys are environment configuration.** Only the public key ever reaches the client; the
   private key stays server-side.

## Phased scope

| Phase | Scope | State |
|---|---|---|
| 1 | `Task.reminderAt` + in-app `TaskReminderWatcher` | Done (earlier) |
| 2 | ADR + `PushSubscription` model + subscribe/unsubscribe API + client helper | **This phase** |
| 3 | Server-side scheduler + `web-push` sending + Service Worker `push` handler | Deferred |
| Future | Native delivery layer; offline local notification | Deferred |

## Consequences

**Positive**
- Reminders can eventually reach a closed PWA without coupling reminder logic to a delivery
  mechanism.
- Subscription data is user-scoped, additive, and requires no destructive migration.

**Trade-offs / limits**
- iOS requires the PWA to be installed to the Home Screen (iOS 16.4+); Chrome-class browsers may
  require the subscription model and `gcm_sender_id`.
- Delivery timing is not an OS alarm and can be delayed by OS/browser batching or Doze.
- Sending, the scheduler, the `push` Service Worker handler, offline local notification, and the
  `web-push` dependency are intentionally **not** part of this phase.
