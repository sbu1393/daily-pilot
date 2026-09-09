# ADR-06 — Change Password in V1 with Stateless JWT

**Status:** ACCEPTED (Ratified) — 2026-09-09
**Ratifies / resolves:** the Pending ADR recorded in `architecture.md` §8.12.1 ("POST /api/auth/change-password — انحراف عمدی مستند")
**Related:** ADR-01 … ADR-05 (`architecture.md` §3.12), §8.12 (Deferred Authentication Features), §8.14 (Authentication & Security V1 Contract)
**Supersedes:** none

> **Governance note.** `architecture.md` remains the authoritative source of truth and is **not**
> modified by this ADR. §8.12.1 is preserved verbatim as historical record of the pending state;
> this document formalizes the decision it explicitly left open. It does not reinterpret or
> override any locked section.

---

## Context

DailyPilot V1 uses stateless JWT authentication: the JWT lives in an httpOnly cookie with a
7-day expiry; there is no server-side session store, no refresh tokens, and no revocation
mechanism (§8.14). Because of this design, the classic security model "password change
invalidates all existing sessions" was **not** implemented.

The Change Password feature nonetheless shipped early in V1 and was subsequently hardened:
it is actively used by the current UI flow, and its contract was tightened (schema moved to
`app/schema/formSchema.ts`, malformed-JSON handling, full ADR-04 error envelope, route test
coverage). `architecture.md` §8.12.1 therefore recorded it as an **intentional, documented
deviation** from §8.12's original "Password Change deferred" list — but explicitly as a
*Pending ADR*, not a final architectural decision.

This ADR closes that pending state.

## Decision

The Change Password feature is **KEPT** as an intentional, ratified V1 deviation:

1. **Change Password remains available in V1** (`POST /api/auth/change-password`,
   Active & Hardened), despite §8.12 originally deferring it.
2. **JWT authentication remains stateless.** No server-side session store is introduced.
3. **Password change does NOT invalidate already-issued JWTs.** A token issued before the
   change remains valid until its natural expiry (≤ 7 days, per §8.14). The flow issues no
   new session/cookie.
4. **No token revocation mechanism is introduced.**
5. **No refresh-token system is introduced.**
6. **Session invalidation / revocation is explicitly NOT part of this decision.** Any future
   session-invalidation or revocation capability (e.g. token versioning, `iat`-based
   invalidation, refresh tokens, or a server-side session store) is out of scope here and
   **requires a separate, dedicated ADR**.
7. The rest of §8.12's deferred list is unchanged by this decision.

### Ratified implementation contract (verified at ratification)

| Aspect | Behavior |
|---|---|
| Endpoint | `POST /api/auth/change-password` (`app/api/auth/change-password/route.ts`) |
| Authentication | `getCurrentUser()` — stateless JWT httpOnly cookie; 401 `UNAUTHORIZED` if absent |
| Validation | Zod `changePasswordSchema` (`app/schema/formSchema.ts`); malformed/absent JSON → 400 `VALIDATION_ERROR` |
| Unknown user | `USER_NOT_FOUND` → 404 |
| Wrong current password | `WRONG_PASSWORD` → 401 |
| New = current password | `SAME_PASSWORD` → 400 |
| Success | 200 `{ ok: true, message }` — rehash with bcrypt cost 12, update `User.password`; **no cookie issued or cleared** |
| Session effect | None. Previously issued JWTs stay valid until natural expiry |

Tests: `app/api/auth/change-password/route.test.ts` (envelope, validation, 401/400/404
propagation) lock this contract.

## Consequences

**Positive**

- The hardened, UI-used feature is no longer an unratified architectural loose end.
- The stateless-JWT design (§8.14) is preserved intact — no new infrastructure, no schema
  changes, no new endpoints.
- The pending-ADR ambiguity in §8.12.1 / §8.14 is resolved without touching the locked
  architecture document.

**Accepted risks / limitations**

- A JWT obtained before a password change (e.g. via a compromised client) remains usable for
  up to its remaining ≤ 7-day lifetime; the user cannot force-invalidate it by changing the
  password. This risk is **explicitly accepted for V1**; the 7-day expiry is the effective
  bound.
- This endpoint has **no dedicated rate limit** in V1 (§8.14 defines limits only for
  register/login). Adding one is out of scope of this decision.
- If revocation is ever required, it cannot be retrofitted silently: it needs its own ADR
  (per decision item 6), which should weigh token versioning vs. refresh tokens vs. a
  server-side session store against §8.12's deferred-features rationale.

**Non-goals of this decision** (explicitly not authorized): rate limiting, token revocation,
session invalidation, server-side session store, refresh tokens, email change, password
reset, any redesign of the password-change flow.
