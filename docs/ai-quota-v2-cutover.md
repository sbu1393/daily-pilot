# AI Quota v2 — Cutover & Implementation Record

**Status:** Phase 1 (schema) + Phase 2 (services) implemented.
**Runtime status:** the three existing AI routes are **not** rewired yet — legacy `AiUsage` remains the only authoritative source at runtime until cutover. See §7.
**No migration has been applied to any database.** All migrations are additive and unapplied.

---

## 1. Decisions (locked)

| # | Decision | Where it lives |
|---|---|---|
| D1 | **Cutover happens at a period boundary**, never mid-period. `AiUsage` stays authoritative until then. | `AiQuotaCutover` + rule in §2. **No backfill** — no historical usage is attributed to ANALYZE/PLAN. |
| D2 | Consumption order is **PROMO → BASE**. | `aiQuotaV2.service.ts` → `reserveFromLedger`; locked by tests. |
| D3 | `validFrom`/`expiresAt` control the **redemption window only**. | `PromoRedemption` snapshots the bonus; no `bonusExpiresAt` exists. |
| D4 | Concurrent redemptions must make `grantedUnits += bonus` atomic. | `promoCode.service.ts` → `incrementPromoGrant`; real-DB test. |
| D5 | BASE capacity is read **live** from `AiQuotaPolicy`, so audit needs a snapshot. | `AiUsageEvent.policyAllowedUnits`. No policy versioning. |
| D6 | The real provider must be recorded, not hardcoded. | `AiUsageEvent.provider/.model/.fallbackUsed` via `recordProviderOutcome`. |
| D7 | Keep the in-memory rate limiter; distributed limiting is out of scope. | See §6 (explicit caveat). |

Two **independent** quotas now exist: **Task Analysis** and **AI Plan Generation**, each with its own FREE/PRO cap. Consuming ANALYZE never reduces PLAN, and vice versa. Promo bonuses are granted per feature into separate buckets.

---

## 2. Final quota values (LOCKED product decision)

| Plan | ANALYZE | PLAN |
|---|---:|---:|
| FREE | **15** / month | **2** / month |
| PRO | **270** / month | **50** / month |

Seeded by `prisma/migrations/20260929120000_add_ai_quota_policy_and_buckets/migration.sql` with `ON CONFLICT DO NOTHING`.

These four rows are the **only** source of caps. No number is hard-coded in application code: `readQuotaPolicy` fails closed if a row is missing, and the test `quotaPolicy.service.test.ts` asserts the seed values *by reading the migration file* (so the test and the migration cannot drift apart silently).

Admin can change any of the four at runtime without a deploy. Lowering a cap mid-month never crashes a bucket and never rewrites `consumedUnits` — the next reservation is simply blocked at the new capacity (tested: *"پایین آوردن سقف crash نمی‌کند"*).

### Feature cost table (server-side only)

`AI_FEATURE_SPECS` in `quotaPolicy.service.ts` is a closed map. A feature that is not in it throws `UNKNOWN_AI_FEATURE` — there is no silent default. This is what stops a new AI route from inventing a cost.

| feature | dimension | units | multiUnit |
|---|---|---:|---|
| `analyze` | ANALYZE | 1 | false |
| `plan` | PLAN | 1 | false |

That is the whole table. Two features, and consequently exactly the four product policy combinations above.

**`ai-test` is deliberately absent.** `GET /api/ai/test` is an internal diagnostic endpoint: 404 on the very first statement in production, no UI, no caller, no ProductEvent and no activity tracking. It now consumes **no user quota at all** — it keeps auth, its own 1/hour-per-user rate limit, sample execution and error logging, and nothing else. Previously it reserved 3 units per invocation, which meant that in dev with no provider key it burned three units of the user's monthly budget while making **zero** real AI calls (the mock fallback swallowed them), and it recorded `attempts = 1` with no provider/model/fallback telemetry. `AI_TEST_UNITS = 3` was only ever the number of internal samples, never a product cost.

It is not mapped to ANALYZE and no `AI_TEST` feature was invented to keep the quota: `resolveQuotaFeature("ai-test")` throws `UNKNOWN_AI_FEATURE`, so the invariant "only the four product combinations exist" holds structurally rather than by convention.

### M2 — a cost above 1 is opt-in

A future caller passing `units: 2` or `units: 500` by accident is stopped **before any DB write**, at two independent layers:

1. `assertQuotaUnitsAllowed(feature, units)` (in `quotaPolicy.service.ts`, called by `runAiOperation`) throws `AI_FEATURE_NOT_MULTI_UNIT` (400) when `units > 1` and the spec does not declare `multiUnit: true`.
2. `reserveBucketQuota` re-checks with a deny-by-default `multiUnit` flag, so even a caller that bypasses the first guard cannot record an unintended multi-unit reservation. A malformed number (NaN / 0 / negative / non-integer) still fails closed to `QuotaUnavailableError`.

The reason a multi-unit bug is treated as a **400** and not a 503: it is a programming mistake, not an infrastructure outage, and a 503 would send operators chasing a database that is perfectly healthy.

The M1 companion invariant (one reservation is never split across PROMO and BASE) is unchanged and now explicitly documented: since splitting is forbidden, the `PROMO = 1 / BASE = 15 / units = 2` case is **not redesigned** — it simply cannot be reserved from a single source, and the whole request is rejected. Because every current feature costs 1, no such product path exists today.

---

## 3. The cutover rule (single source of truth)

```
firstNewPeriodStart(cutoverAt, tz) = the first local month start that is >= cutoverAt

quotaMode = NEW    ⟺  periodStart >= firstNewPeriodStart(cutoverAt, tz)
quotaMode = LEGACY ⟺  periodStart <  firstNewPeriodStart(cutoverAt, tz)
```

Implementation: `app/lib/services/aiQuotaCutover.service.ts` (pure, no I/O for the decision itself).

**Why not `periodStart < nextPeriodStartOf(cutoverAt)`:** that formulation marked the period as LEGACY when `cutoverAt` landed *exactly* on its `periodStart`, which contradicts the product rule. The rule above is closed on the right — "a period whose start is `>= cutoverAt` is NEW".

Resulting semantics:

* `cutoverAt` strictly inside a period → that period (its start is `< cutoverAt`) is the **last LEGACY** period; the next period is NEW.
* `cutoverAt` exactly equal to a user's `periodStart` → **that** period is NEW, not a later one.
* Comparison is per-user and by **instant**, using the user's own timezone. Each user transitions at *their own* boundary; a global UTC boundary would mis-handle e.g. `Asia/Tehran`.
* DST boundaries are handled by the existing two-pass `localMonthStartUtc`, so a month start is always a valid instant (e.g. in `Europe/Berlin`, November starts at `23:00Z` because the offset is `+01:00`, not `22:00Z`).

Covered by `aiQuotaCutover.service.test.ts` (17 tests) — mid-month, exact boundary, `Asia/Tehran`, two timezones sharing one `cutoverAt`, and `Europe/Berlin` month/DST edges.

### Seeded value

`2026-10-01T00:00:00Z` — a conservative default. If activation happens **before** it, every user's containing period stays legacy. If activation is **delayed** past it, the transition is simply *later* — never earlier. The failure mode is a delay, not an over-grant.

### ⚠️ Activation checklist (before the release that switches routes to the new path)

1. Read `AiQuotaCutover.cutoverAt`.
2. If `now() >= cutoverAt`, **advance** it to the activation instant (`resolveActivationCutover`).
3. **Never move it backwards** (`setCutoverAt` throws `CUTOVER_BACKWARDS`): that would reclassify already-NEW periods as legacy and hide their bucket data.
4. Verify with the reconciliation/health read that no period switched twice.

### Rollback

Every change in Phases 1–2 is additive. No table/column/row is dropped or rewritten; **`AiUsage` and `AiUsageEvent` keep all their data**. Rolling back the deploy to the previous build is therefore safe without a DB rollback: old code reads `AiUsage` only and ignores the new tables. No migration is ever applied automatically.

---

## 4. Phase 2 (services)

| Module | Responsibility |
|---|---|
| `aiQuotaCutover.service.ts` | Cutover rule + reading/advancing the single cutover row. |
| `quotaPolicy.service.ts` | Live cap read, closed feature cost table, admin update + audit. |
| `promoCode.service.ts` | Admin create/list/toggle, user redemption (transactional, CAS). |
| `aiQuotaV2.service.ts` | Bucket ledger: PROMO-first reserve, complete, release, read. |
| `aiOperation.service.ts` | **The single entry point** for an AI operation: `resolve policy → reserve → execute → complete/release`. |
| `adminAudit.service.ts` | Append-only `AdminAuditLog` writer (best-effort, never fails an admin action). |
| `app/schema/aiQuotaSchema.ts` | Zod contracts — all `.strict()`. |

### Why the central lifecycle matters

`runAiOperation` is the only sanctioned way to run a quota-consuming AI call. It resolves the cost from the closed table (a caller cannot send `units`), picks legacy vs new ledger itself (a caller cannot pick), and always resolves the reservation. A feature not in the table throws before any reservation. Tests assert that when reserve fails, `execute` is never invoked.

### Promotions

* Redemption window is the only thing `validFrom`/`expiresAt` control. A bonus redeemed in time stays valid **for the rest of its quota period**, and the snapshot survives the code expiring. There is no `bonusExpiresAt`.
* `UNIQUE(userId, promoCodeId)` is the real anti-duplicate guarantee; the pre-check is only a fast path.
* `maxRedemptions` is enforced by a single atomic `UPDATE ... WHERE redeemedCount < max`, so the counter cannot overshoot under contention.
* `grantedUnits += bonus` is a single atomic upsert-increment, so concurrent redemptions of *different* codes by one user sum exactly.
* Redemption + initial grant are one transaction: a failure rolls back the counter too (verified against real PostgreSQL by forcing the grant to throw mid-transaction).
* Only features with a **non-zero** bonus create a bucket; a missing PROMO bucket simply means zero capacity.

### Anti-enumeration

**Every** rejection that would reveal existence returns the same `PROMO_CODE_INVALID` with the same status and the same message: not found, inactive, not yet valid, expired, **and exhausted**. `PROMO_EXHAUSTED` has been removed — "the code ran out of capacity" proved the code exists, and a single `findUnique` was enough for an attacker to tell real codes from typos.

`PROMO_ALREADY_REDEEMED` is the one deliberately distinct response: it is only reachable by a user who already redeemed that exact code, so it carries no public enumeration oracle.

The real reason is still recorded **server-side only**, in `AdminAuditLog` under `action = "promo.redeem_rejected"` with `after.reason` set to one of `INVALID | INACTIVE | NOT_YET_VALID | EXPIRED | EXHAUSTED | ALREADY_REDEEMED`. Support and admins can tell *why* a code failed; the client cannot. The write is best-effort (via `writeAdminAuditLog`), so an audit outage can never turn a rejection into a 503, and the raw code string is never stored — a rejected attacker-supplied guess must not be persisted.

Security deliberately **does not depend on codes being unpredictable**: admins may enter codes by hand, so entropy is not a control we own. The controls are the uniform response and rate limiting. The redemption endpoint must rate limit **per user and per IP** when it is wired in Phase 3. Known limitation, kept in this document on purpose: `isRateLimited` is an in-memory `Map`, so on Vercel (stateless serverless instances) the effective ceiling is the number of instances × the per-instance rate. A distributed limiter (Upstash/Redis) is deliberately deferred to a later phase — not because it is unimportant, but because this phase adds no new dependency. No timing jitter was added either; uniform responses plus rate limiting plus limiting code entropy is the intended defence, and jitter should only appear if a test or security review shows it is needed.

### 4b. What the wiring changed (Phase 4)

Both product callers now resolve their cost, ledger and reservation through one function. Concretely:

| Before | After |
|---|---|
| each route read `resolvePlanPolicy` + `getMonthlyPeriod` itself | `runAiOperation` does it; routes pass only the user and the feature name |
| each route hand-wrote reserve/complete/release (≈70 lines each) | one `runAiOperation` call per route |
| each route decided nothing about legacy vs V2 | the service picks the ledger, so the cutover rule has exactly one implementation |
| `recordProviderOutcome` was never called ⇒ `provider`/`fallbackUsed` always `null` | the real provider and fallback flag are written on the same event |
| `units` was a literal in the route (`1`, or `resolveFeatureUnits`) | `units` comes from the closed `AI_FEATURE_SPECS` table and cannot be sent by a client |

Two behaviours were **kept exactly as they were**, because they are deliberate and not bugs:

- **`plan` releases on post-AI validation failure.** `validateBatchPlan` and the `planProposalSchema` producer/consumer guard run *inside* `execute`, so an unusable AI response releases the reservation instead of consuming it. Moving them after `runAiOperation` would have silently charged users for a plan that was never produced.
- **`plan` and `analyze` still differ in `failureCode`.** Only a provider failure is labelled for `analyze`; `plan` additionally labels an unusable AI result as `AI_PLAN_INVALID`. The rule lives in the service (`releaseFailureCode`), not in the route, so it stays centralised.

Nothing about `AI_MAX_ATTEMPTS` or `AI_FALLBACK_MAX_ATTEMPTS` changed: retries and fallback still happen inside `runAiOperation`, and still cost **one** logical unit.

### Audit

`AiUsageEvent` records `quotaSource` + `bucketId` (a paired invariant enforced by a DB CHECK), and `policyAllowedUnits` snapshotted **at reservation time**, so changing 15 → 5 mid-month does not corrupt the record of what an earlier operation was allowed. `provider` / `model` / `fallbackUsed` are written from the real provider client result via `recordProviderOutcome` — nothing is hardcoded to `"1xai"`.

---

## 5. Data model & invariants

| Object | Purpose |
|---|---|
| `AiQuotaPolicy` (4 rows) | FREE/PRO × ANALYZE/PLAN caps, admin-editable. |
| `AiQuotaBucket` | Consumption ledger per `(user, feature, source, period)`. `BASE` ⇒ `grantedUnits IS NULL` (live policy); `PROMO` ⇒ `grantedUnits` = sum of bonuses. |
| `AiQuotaCutover` | Single row; the boundary in §3. |
| `PromoCode` / `PromoRedemption` | Promo system with DB-level uniqueness and CAS. |
| `AdminAuditLog` | Append-only; no FK to `User` on purpose. |
| `AiUsageEvent` (+5 cols) | Audit metadata (D5/D6) and the `(status, createdAt)` index for the orphan-reservation job. |

DB-level invariants: `allowedUnits >= 0` · `reserved/consumed >= 0` · `grantedUnits IS NULL OR >= 0` · `source_shape` (BASE ⇔ `grantedUnits IS NULL`) · `AiQuotaCutover.id = 1` · PromoCode bonuses `>= 0`, total `>= 1`, `redeemedCount >= 0`, `maxRedemptions IS NULL OR >= 1`, `expiresAt > validFrom` · PromoRedemption bonuses `>= 0`, total `>= 1` · `AiUsageEvent`: `(bucketId IS NULL) = (quotaSource IS NULL)`, `policyAllowedUnits IS NULL OR >= 0`.

---

## 6. Rate limiting — explicit caveat

The project's rate limiter (`app/lib/rateLimit.ts`) is an **in-process `Map`**. On a multi-instance/serverless deployment (Vercel) it is **not** a security boundary: each instance keeps its own counters, so the effective limit multiplies with instance count.

* It is still useful as a cheap per-instance throttle and it is **not** the quota enforcement mechanism — quota is enforced in the database and cannot be bypassed by the limiter's weakness.
* It must **not** be relied on as the only defence against distributed brute-forcing of promo codes.
* A distributed limiter (Redis/DB-backed) is **out of scope for Phases 1–2**; if promo brute-force resistance becomes a requirement it must be added as its own change.
* Consequence for the promotion flow specifically: the uniform `PROMO_CODE_INVALID` response (§4) removes the *signal*, and this limiter is the only remaining brake on *volume*. When the redemption route is wired in Phase 3 it must apply both a per-user and a per-IP limit. Until a distributed limiter exists, treat that endpoint as rate-limit-approximate, not rate-limit-enforced.

---

## 6b. Provider client — two defects fixed in Phase 2

Both were confirmed by a throwaway probe against the real client, not by reading the code alone.

### `attempts` counted every failure twice

`totalAttempts` was incremented after a successful `provider.complete()` **and** again as the first line of `catch`. A successful first call reported `attempts: 2`, and a parse failure on the second call reported `attempts: 3` after only two real calls. The probe measured it directly: 2 real provider calls, `attempts` reported as 3.

The increment now happens **once, immediately before `provider.complete()`**, and the one in `catch` is gone. `attempts` therefore means *actual provider calls* — not the number of exceptions and not the number of retry decisions. `AiUsageEvent.attempts` and the provider/model/fallback audit fields are only meaningful under this definition.

### A parse/schema failure no longer falls back to the next provider

Inside the `if (!isTransportError)` branch, `continue` after the last retry walked the outer chain loop and **called the next provider anyway**. The probe confirmed it: OpenRouter returned HTTP 200 with a body that failed `transform`, and the paid 1xai provider was then called with the same schema it could not satisfy. A local parsing problem was being paid for.

The behaviour is now: retry the same provider up to its policy budget, then stop the whole chain and throw the **original** parse/schema error. `stopChain` exists because a bare `break` only leaves the inner attempt loop — the outer `for … of chain.entries()` would still have reached the fallback. `primaryError` is what surfaces, so the caller sees the parse error rather than anything the second provider said.

This is the only semantic change to that branch, and all pre-existing transport-fallback tests still pass unchanged. Tests added: a first-call success reports `attempts: 1`; a transport error then a success reports `2` (not `3`); a parse failure with a retry reports the real call count; a fallback reports the sum across both providers; and, with fallback explicitly enabled, a primary that always returns HTTP 200 but always throws in `transform` results in the second provider being called **zero** times while the primary is retried per policy and the final error is still the parse error.

---

## 6c. Running the database tests

Four suites require a real, isolated PostgreSQL and **fail closed** — there is no mock, no in-memory substitute and no fake green. `assertTestDatabase()` (in `app/lib/testing/dbTestEnv.ts`) runs *before the first write* and rejects any target that is not provably a test database, which is why a production Neon URL cannot be used even by accident.

| Suite | Covers |
|---|---|
| `app/lib/services/aiQuotaV2.concurrency.db.test.ts` | **V2 quota CAS under real contention** (new in Phase 2). |
| `app/lib/services/promoCode.concurrency.db.test.ts` | 5 promotion scenarios: duplicate redemption, `maxRedemptions` across users, several codes at once for one user, atomic `grantedUnits +=`, real transaction rollback. |
| `app/lib/services/aiQuota.concurrency.db.test.ts` | Legacy `AiUsage` ledger. |
| `src/lib/observability/__tests__/errorLog.persistence.db.test.ts` | ErrorLog persistence and route integration. |

```bash
# 1. an isolated test database (never the production URL)
DATABASE_URL="postgresql://user:pass@127.0.0.1:5433/aiquota_test" npx prisma migrate deploy

# 2. only the DB suites
DATABASE_URL="postgresql://user:pass@127.0.0.1:5433/aiquota_test" npx vitest run \
  app/lib/services/aiQuotaV2.concurrency.db.test.ts \
  app/lib/services/promoCode.concurrency.db.test.ts \
  app/lib/services/aiQuota.concurrency.db.test.ts \
  src/lib/observability/__tests__/errorLog.persistence.db.test.ts
```

The four `2026092912*` migrations are still **unapplied everywhere**. They are additive, and they were applied only to the throwaway test database above — never to production.

**Why the promotion codes are run-scoped.** `PromoCode.code` is globally unique, and the codes used to be fixed literals (`"SEQ-DUP"`, `"CONC-CAP"`, …). A run that was killed halfway left those rows behind and every later run then died on `P2002` — permanently, until cleaned by hand. Each run now appends its own suffix (`codeFor("CONC-CAP")` → `CONC-CAP-<run id>`), so a fresh run never collides and cleanup stays targeted. The suffix is alphanumeric and short because codes are normalised (trim + upper) and constrained to 3–64 characters.

**What the V2 CAS test proves against real PostgreSQL:** `consumedUnits + reservedUnits` never exceeds capacity; `reservedUnits` never goes negative; the number of successes is exactly the capacity — not fewer (no false denial) and not more (no overspend); a count of reserved events equals `reservedUnits` exactly (no lost update); and completing/releasing concurrently never pushes the counters past the cap. One nuance worth recording: under heavy contention a request can exhaust the bounded retry budget and receive `QUOTA_UNAVAILABLE` (503) rather than `QUOTA_EXCEEDED` (429). That is deliberate — "I don't know" must not be reported as "you are out of quota" — and the test asserts the invariant that survives it, namely that every unit held is backed by a real reservation.

---

## 7. What is NOT done yet

* **Routes ARE rewired (Phase 4).** Both `/api/tasks/[id]/analyze` and `/api/planner/plan` now go through `runAiOperation`; neither calls `reserveQuota`/`completeQuota`/`releaseQuota` any more. The legacy *ledger* is still what serves them while their period is LEGACY — only the call site moved.
* **The redemption endpoint still does not exist.** `AdminUi` has no promo mutation UI and no promo HTTP route; the services are ready.
* **`recordProviderOutcome` is now called.** Before Phase 4 nobody invoked it, so `provider`/`model`/`fallbackUsed` were `null` on every real `AiUsageEvent`. `model` is deliberately still not recorded — see §4b.
* **No Admin UI and no Promo UI.** `AdminUi.tsx` nav is unchanged.
* **No new API routes.** Services exist; the thin HTTP layer (incl. `requireAdmin()` guards on any admin mutation) comes later.
* **No reconciliation job** for orphan reservations, and no admin mutation endpoint yet.
* **No migration applied** anywhere. Rollout order is: apply migrations → ship the wiring → flip/advance `cutoverAt`.
