# AI Provider Fallback — OpenRouter (primary) → 1xAI (fallback)

**Status:** implemented in code, **disabled in production** (`AI_ALLOW_FALLBACK` defaults to off).
**Scope:** AI transport/orchestration only. No schema, no migration, no change to quota accounting.
**Not touched:** `AiUsage` / `AiUsageEvent`, reserve/complete/release, `AiSource` (`"1xai" | "mock"`),
prompts, Zod schemas, repair/contract pipeline.

> This document records what is implemented and what the operator must do to activate it.
> It makes no claim about the upstream providers' data-retention or training policies.

---

## 1. Roles

| Provider | Role | Model | Base URL |
|---|---|---|---|
| **OpenRouter** | primary — the provider used in normal operation | `qwen/qwen3.8-27b:free` | `https://openrouter.ai/api/v1` |
| **1xAI** | fallback — used **only** after the primary has failed | `gpt-4o-mini` | `https://1xai.ir/v1` |

The order is fixed and deterministic: `OpenRouter → 1xAI`. It is never reversed.
The goal is cost: while OpenRouter answers, **no request is sent to the paid 1xAI service**.
Both are OpenAI-compatible, so both use the same `POST /chat/completions` transport.

---

## 2. Environment variables

All of these are **server-side only**. None of them may ever be exposed to the client bundle.
Copy the names into Settings → Environment (or a local `.env`); fill the values yourself.

```bash
# ── Primary provider ───────────────────────────────────────────────────
OPENROUTER_API_KEY=
# OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
# OPENROUTER_MODEL=qwen/qwen3.8-27b:free

# ── Fallback provider (paid; optional) ──────────────────────────────────
AIXAI_API_KEY=
# AIXAI_BASE_URL=https://1xai.ir/v1
# AIXAI_MODEL=gpt-4o-mini

# Optional attribution headers — only sent when set, never hardcoded.
# OPENROUTER_REFERER=
# OPENROUTER_TITLE=

# ── Feature flag (controls everything) ─────────────────────────────────
# Only the exact string "true" enables fallback. Anything else is OFF.
AI_ALLOW_FALLBACK=false

# ── Budgets ────────────────────────────────────────────────────────────
# AI_MAX_ATTEMPTS=3
# AI_TIMEOUT_MS=12000
# AI_FALLBACK_MAX_ATTEMPTS=1
# AI_OPERATION_TIMEOUT_MS=   # optional; derived when omitted
```

**Never commit a real key.** Only the variable names belong in the repository.

---

## 3. What the flag does

`AI_ALLOW_FALLBACK` is **fail-closed**: only the exact string `"true"` turns fallback on.
`"1"`, `"TRUE"`, `"yes"`, or a missing value all mean **off**.

With the flag off, only the primary (OpenRouter) is used, with `AI_MAX_ATTEMPTS`
attempts and no operation-level deadline.

Two conditions must both hold before a fallback call is ever issued:
1. the flag is `"true"`, and
2. `AIXAI_API_KEY` is set (otherwise the fallback is simply not in the chain —
   the primary is unaffected).

---

## 4. Fallback policy

| Failure | Retry same provider | Try 1xAI |
|---|---|---|
| 408 / 429 / 5xx, network error, timeout, empty content | yes, up to its budget | after the budget is spent |
| 401 / 403, missing API key | no | yes, immediately |
| 400 / 404 (bad request) | no | **no** — switching provider would only add cost and delay |
| parse/schema rejection of the reply | yes (strict prompt) | **no** — this is not a transport failure |

The parse row above was documented before it was actually true. It used to `continue`
after the last retry, which walked the chain loop and called the next provider anyway —
so a body that failed `transform` still got sent to the paid provider. The chain is now
stopped explicitly and the original parse/schema error is thrown.

**`attempts` means actual provider calls.** It is incremented once, immediately before
`provider.complete()`, so a call that fails in `transform` still counts exactly once.
(An earlier version incremented after the call *and* again in `catch`, which reported 3
attempts after 2 real calls.) `attempts` is not the number of exceptions and not the
number of retry decisions.

**Quota is unaffected.** One logical AI operation = one unit, regardless of how many
providers were called. `reserveQuota` / `completeQuota` / `releaseQuota` live in the
route and run exactly once; the AI layer never calls them.

---

## 5. Attempt and time budgets

| Setting | Default | Meaning |
|---|---|---|
| `AI_MAX_ATTEMPTS` | 3 | attempts for the **primary** |
| `AI_FALLBACK_MAX_ATTEMPTS` | 1 | attempts for the **fallback** (hard-capped at 2) |
| `AI_TIMEOUT_MS` | 12000 | per-attempt timeout (floor 3000) |
| `AI_OPERATION_TIMEOUT_MS` | derived | **total** budget for the whole operation |

The operation budget is only created when the fallback is actually in the chain, so the
default (flag off) path keeps its exact previous timing.

When unset, it is derived from the other settings so it never contradicts them:

```
(AI_MAX_ATTEMPTS + AI_FALLBACK_MAX_ATTEMPTS) * AI_TIMEOUT_MS + 5000   → capped at 60000
```

With the defaults this yields `53000` ms. A malformed value is ignored and the derived
default is used. An explicit value is floored at one full attempt (so the fallback is never
starved) and capped at 60 s.

Once the budget is spent the operation stops immediately — 1xAI is **not** called.

---

## 6. Observability

`ai.analysis_succeeded` records `aiProvider` (`"1xai" | "openrouter"`) and `fallbackUsed`
(boolean) alongside the existing fields. Both are on a strict allowlist: no API key, no
prompt, no raw model response, and no user content is ever stored. `props` is a JSON column,
so this required **no migration**.

`AiSource` is deliberately unchanged: it still means "real AI vs. mock", and
`aiProvider` carries the provider detail separately.

---

## 7. Activating in production

1. Add `OPENROUTER_API_KEY` in Settings → Environment (it is now required — the primary).
2. Optionally set `OPENROUTER_BASE_URL` / `OPENROUTER_MODEL` if the defaults should change.
3. Start with `AI_ALLOW_FALLBACK=false` and confirm OpenRouter-only behaviour is as expected.
4. Set `AI_ALLOW_FALLBACK=true`, then watch the `fallbackUsed` rate on
   `ai.analysis_succeeded` before leaving it on.
5. Tune `AI_OPERATION_TIMEOUT_MS` to stay inside the platform's request limit.

⚠️ The privacy policy already discloses the fallback: when the primary service is
unavailable, the same limited data may be sent to another AI processing service.
That wording is in `app/lib/privacyContent.ts` and must stay in place while the
fallback is enabled.
