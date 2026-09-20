# Captcha Migration — Google reCAPTCHA v3 → Cloudflare Turnstile

**Status:** implemented on branch `feature/auth-security` (not committed, not deployed).
**Scope:** captcha layer only. No schema, migration, user data, OTP logic or session change.
**Not touched:** `architecture.md` (locked source of truth), `roadmap.md`, Prisma schema/migrations, `lib/otp.ts`, session/JWT code.

> Note: this document intentionally does not claim "zero risk" or "fully secure". It records what
> was implemented, what was actually verified, and what still requires the operator.

---

## 1. Design

| Concern | Implementation |
|---|---|
| Widget | Shared client component `app/components/CaptchaWidget.tsx` (visible widget, `@marsidev/react-turnstile`) |
| Pages wired | `app/auth/register`, `app/auth/login`, `app/auth/otp` |
| Server check | `app/lib/turnstile.ts` → `verifyTurnstile()` (Cloudflare `siteverify`, server-only) |
| Actions | `app/lib/captchaActions.ts` → `register`, `login`, `send_otp`, `verify_otp` |
| Token transport | JSON request body field `turnstileToken` |
| Failure code | `400 CAPTCHA_FAILED` (same envelope, status and Persian message as before) |
| Guard position | Before every sensitive step (rate-limit → captcha → validation → DB/email) |

Widget behaviour: visible challenge; submit buttons stay disabled until a valid token exists;
loading / ready / success / expired / error states are surfaced in Persian; expired or errored
widgets show a "retry" button; after **every** protected request (success or failure) the parent
calls `captchaRef.current.reset()`, which clears the consumed token and requests a fresh challenge —
so `send-otp` and `verify-otp` never reuse a token.

### Contract changes (deliberate, in-repo only)

| Before | After | Why |
|---|---|---|
| body field `recaptchaToken` | `turnstileToken` | vendor-accurate; client and server updated together |
| error code `RECAPTCHA_FAILED` | `CAPTCHA_FAILED` | no reCAPTCHA vendor references left in the codebase |

Endpoint paths, HTTP statuses (400/429/…), response envelope and Persian messages are unchanged.
If any external (non-repo) client depends on the old field/code, it must be updated before rollout.

### Fail-closed matrix (server)

`verifyTurnstile` returns `false` — and the route answers `400 CAPTCHA_FAILED` — for: missing/blank
secret, missing/blank token, non-2xx, unparseable body, `success !== true` (invalid / expired /
already-used token → `invalid-input-response`, `timeout-or-duplicate`), request timeout (5 s default,
configurable per call), network error, hostname outside the configured allowlist, or action mismatch.
The only non-fail-closed branch is "no allowlist configured **outside** production" (local dev).
In production an unconfigured allowlist is itself a fail-closed condition — there is no production bypass.

---

## 2. Environment variables

| Name | Side | Required | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | client | yes | public site key; ends up in the client bundle |
| `TURNSTILE_SECRET_KEY` | server | yes | **never** prefix with `NEXT_PUBLIC_`; never commit |
| `TURNSTILE_ALLOWED_HOSTNAMES` | server | **required in production** | comma-separated allowlist of hostnames returned by siteverify, e.g. `daysaz.example.com,*.preview.example.com,localhost`. Exact hostnames, or `*.` wildcard for subdomains. |

- `.env.example` could **not** be created/updated in this workspace (the platform blocks writes to
  `.env*` files). The variable list above is the authoritative reference; add the names manually to
  the Keys/Environment UI.
- Cloudflare's published test keys (site `1x00000000000000000000AA`, secret
  `1x0000000000000000000000000000000AA`) are for local dev/CI only — never in production.

### CSP

No Content-Security-Policy is configured in this repository (`next.config.js` only sets cache
headers). Nothing had to change. If a CSP is added later, Turnstile needs at minimum
`script-src https://challenges.cloudflare.com` and `frame-src https://challenges.cloudflare.com`
(per Cloudflare's official docs). Do not add a policy that is broader than needed.

---

## 3. Files

**Added**
- `app/lib/turnstile.ts` — server verification (fail-closed, action + hostname allowlist).
- `app/lib/captchaActions.ts` — shared action constants (single source for client + server).
- `app/components/CaptchaWidget.tsx` — visible widget + token lifecycle + Persian states.
- `app/lib/turnstile.test.ts` — 21 unit tests for the siteverify contract.
- `docs/captcha-turnstile-migration.md` — this document.

**Changed**
- `app/api/auth/{register,login,send-otp,verify-otp}/route.ts` — swapped verifier, `turnstileToken`, `CAPTCHA_FAILED`.
- `app/auth/{register,login,otp}/page.tsx` — widget + token state + disabled-until-verified submit + reset per request.
- `app/layout.tsx` — removed the old global captcha provider (widgets are per page now).
- `app/api/auth/{register,login,send-otp,verify-otp}/route.test.ts` — re-pointed at the Turnstile verifier.
- `package.json` / `package-lock.json` — added `@marsidev/react-turnstile@^1.6.1`, removed `react-google-recaptcha-v3`.

**Removed**
- `app/lib/recaptcha.ts`, `app/lib/recaptcha.test.ts`, `app/components/providers/RecaptchaWrapper.tsx` (and the now-empty `app/components/providers/`).

---

## 4. Verification actually performed

| Check | Result |
|---|---|
| `npx vitest run` (full suite) | 74 files / **1319 tests passed** |
| `npx tsc --noEmit` | clean (exit 0) |
| `npx next lint` | clean (only the 2 pre-existing `<img>` warnings) |
| Pages `/`, `/auth/register`, `/auth/login`, `/auth/otp` over HTTP | **200** |
| `POST /api/auth/{register,login,send-otp,verify-otp}` without a token | **400 `CAPTCHA_FAILED`** each — no DB write, no OTP email |
| Widget bundled for the 3 protected pages | present in `.next/static/chunks/app/auth/*/page.js` |

**Automated tests are mock-based / API-contract level**, not browser or live-service level:
- `app/lib/turnstile.test.ts` stubs `fetch` (and env) — it locks the HTTP contract, timeouts and
  fail-closed branches, but never talks to Cloudflare.
- The 4 route tests mock `verifyTurnstile` — they assert ordering and that a captcha failure blocks
  DB work / OTP sending, but do not exercise the real verifier.

**Not verified (and not claimed):**
- No real browser run, so no live Turnstile challenge was solved, and no real token was validated
  end-to-end against Cloudflare. Client-side states (expiry, retry) are covered by code review only —
  the test environment is Node with no DOM/test-renderer setup, so there are no component tests.
- Production deployability was not exercised (no deploy was run, per instructions).

---

## 5. Release checklist (code + keys must ship together)

1. In the Cloudflare Turnstile dashboard: confirm the widget exists and its hostnames include
   production, the preview domain and `localhost` (dev).
2. In Settings → Environment (and the production env of the hosting target) set:
   `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `TURNSTILE_ALLOWED_HOSTNAMES`.
3. **Remove the legacy keys** `NEXT_PUBLIC_RECAPTCHA_SITE_KEY` and `RECAPTCHA_SECRET_KEY` from every
   environment (they are unused after this change). This was **not** done here — `freebuff-deploy`
   is not on this shell's PATH, so the production env could not be inspected or edited.
4. Google reCAPTCHA console keys can be deleted once no environment references them.
5. Deploy, then smoke-test on the deployed origin: the widget renders, register/login/OTP work, and
   an aborted challenge returns `400 CAPTCHA_FAILED` instead of letting the request through.
6. If `TURNSTILE_ALLOWED_HOSTNAMES` is missing in production, every protected request fails closed —
   this is intentional, but it means step 2 is a hard prerequisite, not a nicety.

**Rollback:** revert this branch's changes (single migration commit) and re-add the two legacy
reCAPTCHA env values. The DB has no captcha-related objects, so no data rollback is involved.

## 6. Out of scope / remaining work

- No rate limiting on `send-otp` / `verify-otp` and no attempt counter on `verify-otp`; captcha alone
  does not fully prevent OTP bombing or brute force (unchanged from before this migration).
- Threshold-style tuning does not exist for Turnstile (no score) — Cloudflare's dashboard controls
  widget mode (managed / non-interactive / invisible).
