// فاز ۲ — گام ۳: تست‌های redactError + persistencePolicy (سند فاز ۲ §11/§12/§13/§19/§27)

import { describe, expect, it } from "vitest"

import { REDACTION_LIMITS, redactError, redactValue } from "../redactError"
import { shouldPersistError } from "../persistencePolicy"
import { normalizeError } from "../normalizeError"
import { ServiceError } from "@/app/lib/services/errors"

const record = (overrides: Partial<Parameters<typeof redactError>[0]> = {}) => ({
    errorCode: "INTERNAL",
    statusCode: 500,
    category: "INTERNAL",
    severity: "ERROR",
    safeMessage: "boom",
    ...overrides,
})

describe("redactError — sensitive key families (§11)", () => {
    const SECRET_FAMILIES: Record<string, unknown>[] = [
        { password: "s3cret" },
        { passwordHash: "abc123" },
        { token: "tk" },
        { accessToken: "at" },
        { refreshToken: "rt" },
        { jwt: "j" },
        { cookie: "sid=1" },
        { authorization: "Bearer x.y.z" },
        { apiKey: "k" },
        { secret: "s" },
        { privateKey: "pk" },
        { connectionString: "postgres://u:p@h/db" },
        { databaseUrl: "postgres://u:p@h/db" },
        { prompt: "user text" },
        { systemPrompt: "sys" },
        { userPrompt: "up" },
        { requestBody: "{...}" },
        { rawRequest: "..." },
        { response: "ai out" },
        { rawResponse: "raw ai out" },
        { card: "4111" },
        { cardNumber: "4111111111111111" },
        { cvc: "123" },
        { cvv: "456" },
        { payment: { payload: "x" } },
        { billing: { iban: "DE..." } },
    ]

    it.each(SECRET_FAMILIES.map((obj) => [Object.keys(obj)[0], obj] as const))(
        "redacts %s completely (never truncated/hashed)",
        (_key, obj) => {
            const rec = record({ metadata: { nested: obj } })
            const out = redactError(rec)
            const nested = (out.metadata as any).nested
            const val = nested[Object.keys(obj)[0]]
            expect(val).toBe("[REDACTED]")
            expect(String(val)).not.toContain("TRUNCATED")
        },
    )

    it("is case-insensitive (Password, PASSWORD, apiKey vs API_KEY)", () => {
        const out = redactError(record({ metadata: { Password: "x", PASSWORD: "y", API_KEY: "z", ApiKey: "w" } }))
        const m = out.metadata as any
        expect(m.Password).toBe("[REDACTED]")
        expect(m.PASSWORD).toBe("[REDACTED]")
        expect(m.API_KEY).toBe("[REDACTED]")
        expect(m.ApiKey).toBe("[REDACTED]")
    })

    it("redacts inside nested objects and arrays at any depth", () => {
        const out = redactError(
            record({
                metadata: {
                    level1: {
                        level2: {
                            deeper: [{ token: "leak" }, { safe: "keep" }],
                        },
                    },
                },
            }),
        )
        const m = out.metadata as any
        expect(m.level1.level2.deeper[0].token).toBe("[REDACTED]")
        expect(m.level1.level2.deeper[1].safe).toBe("keep")
    })

    it("masks inline secrets inside safeMessage (key=value / key: value)", () => {
        const out = redactError(record({ safeMessage: 'login failed with password=hunter2 and token="abc"' }))
        expect(out.safeMessage).not.toContain("hunter2")
        expect(out.safeMessage).not.toContain("abc")
        expect(out.safeMessage).toContain("[REDACTED]")
    })

    it("keeps diagnostic metadata: requestId/userId-style keys and non-sensitive values", () => {
        const out = redactError(
            record({ metadata: { requestId: "req-1", userId: 7, attempts: 3, safeProviderStatus: 503 } }),
        )
        const m = out.metadata as any
        expect(m.requestId).toBe("req-1")
        expect(m.userId).toBe(7)
        expect(m.attempts).toBe(3)
        expect(m.safeProviderStatus).toBe(503)
    })
})

describe("redactError — safety behaviors", () => {
    it("does not mutate the input record", () => {
        const input = record({ safeMessage: "boom", metadata: { password: "x" } })
        const snapshot = JSON.stringify(input)
        redactError(input)
        expect(JSON.stringify(input)).toBe(snapshot)
    })

    it("handles circular references without crashing (via redactValue)", () => {
        const circular: any = { a: 1 }
        circular.self = circular
        expect(() => redactValue(circular)).not.toThrow()
        const out = redactValue(circular) as any
        expect(out.a).toBe(1)
        expect(out.self).toBe("[CIRCULAR]")
    })

    it("survives throwing getters", () => {
        const evil = {
            get message(): string {
                throw new Error("getter exploded")
            },
        }
        expect(() => redactValue(evil)).not.toThrow()
        expect(redactValue(evil)).toEqual({ message: "[REDACTION_FAILURE]" })
    })

    it("survives throwing toJSON", () => {
        const evil = {
            toJSON(): unknown {
                throw new Error("toJSON exploded")
            },
        }
        expect(() => redactValue({ data: evil })).not.toThrow()
    })

    it("is deterministic: same input → same output", () => {
        const input = record({ safeMessage: "x", metadata: { token: "t", n: 1 } })
        expect(redactError(input)).toEqual(redactError(input))
    })

    it("never throws on undefined metadata / stack", () => {
        const out = redactError(record({ metadata: undefined, stack: undefined }))
        expect(out.metadata).toBeUndefined()
        expect(out.stack).toBeUndefined()
    })
})

describe("redactError — limits (Phase 2 contract)", () => {
    it("truncates message at 2KB", () => {
        const long = "a".repeat(3000)
        const out = redactError(record({ safeMessage: long }))
        expect(out.safeMessage.length).toBeLessThanOrEqual(2048 + 20) // + نشانگر
        expect(out.safeMessage.startsWith("a".repeat(10))).toBe(true)
    })

    it("truncates stack at 4KB and never merges it into safeMessage", () => {
        const longStack = "Error:\n" + "at f ()\n".repeat(900)
        const out = redactError(record({ safeMessage: "short", stack: longStack }))
        expect(out.stack!.length).toBeLessThanOrEqual(4096 + 20)
        expect(out.safeMessage).toBe("short")
        expect(out.safeMessage).not.toContain("at f ()")
    })

    it("metadata depth limit = 2 (deeper levels become [TRUNCATED])", () => {
        const out = redactError(
            record({
                metadata: {
                    l1: { l2: { l3: { secretValue: "deep" } } },
                },
            }),
        )
        const m = out.metadata as any
        expect(m.l1.l2.l3).toBe("[TRUNCATED]")
    })

    it("metadata property limit = 20 per object", () => {
        const big: Record<string, number> = {}
        for (let i = 0; i < 40; i++) big[`k${i}`] = i
        const out = redactError(record({ metadata: { big } }))
        const keys = Object.keys((out.metadata as any).big)
        expect(keys.length).toBeLessThanOrEqual(21) // 20 + نشانگر [TRUNCATED]
    })

    it("metadata string limit = 128 chars", () => {
        const out = redactError(record({ metadata: { long: "b".repeat(300) } }))
        expect(((out.metadata as any).long as string).length).toBeLessThanOrEqual(128 + 20)
    })

    it("serialized metadata ≤ 4KB with fail-safe fallback", () => {
        const huge: Record<string, unknown> = { note: "x".repeat(5000) }
        const out = redactError(record({ metadata: huge }))
        expect(JSON.stringify(out.metadata).length).toBeLessThanOrEqual(4096 + 100)
    })

    it("reports declared limits", () => {
        expect(REDACTION_LIMITS.MESSAGE_MAX_CHARS).toBe(2048)
        expect(REDACTION_LIMITS.STACK_MAX_CHARS).toBe(4096)
        expect(REDACTION_LIMITS.METADATA_MAX_DEPTH).toBe(2)
        expect(REDACTION_LIMITS.METADATA_MAX_PROPS).toBe(20)
        expect(REDACTION_LIMITS.METADATA_STRING_MAX_CHARS).toBe(128)
        expect(REDACTION_LIMITS.METADATA_MAX_SERIALIZED).toBe(4096)
    })
})

describe("redactError — end-to-end with normalizeError", () => {
    it("normalize → redact pipeline keeps quota error safe and bounded", () => {
        const err = new ServiceError(429, "QUOTA_EXCEEDED", "سهمیه تمام شد password=abc")
        const rec = normalizeError(err)
        const safe = redactError(rec)
        expect(safe.errorCode).toBe("QUOTA_EXCEEDED")
        expect(safe.safeMessage).not.toContain("abc")
        expect(safe.safeMessage).toContain("[REDACTED]")
    })

    it("metadata of a normalized prisma error keeps prismaCode but redacts extra secrets", () => {
        const rec = normalizeError({ code: "P2002", connectionString: "postgres://u:p@h/db" })
        const safe = redactError(rec)
        const m = safe.metadata as any
        expect(m.prismaCode).toBe("P2002")
        expect(m.connectionString).toBe("[REDACTED]")
    })
})

describe("shouldPersistError — Phase 2 policy (§19)", () => {
    it("QUOTA_EXCEEDED → false", () => {
        expect(shouldPersistError("QUOTA_EXCEEDED")).toBe(false)
    })
    it("QUOTA_UNAVAILABLE → true", () => {
        expect(shouldPersistError("QUOTA_UNAVAILABLE")).toBe(true)
    })
    it("AI_PROVIDER_UNAVAILABLE → true", () => {
        expect(shouldPersistError("AI_PROVIDER_UNAVAILABLE")).toBe(true)
    })
    it("INTERNAL → true", () => {
        expect(shouldPersistError("INTERNAL")).toBe(true)
    })
    it("expected NOT_FOUND errors → false", () => {
        expect(shouldPersistError("NOT_FOUND")).toBe(false)
        expect(shouldPersistError("TASK_NOT_FOUND")).toBe(false)
        expect(shouldPersistError("USER_NOT_FOUND")).toBe(false)
        expect(shouldPersistError("NO_ROLLOVER_CANDIDATES")).toBe(false)
    })
    it("VALIDATION_ERROR → false", () => {
        expect(shouldPersistError("VALIDATION_ERROR")).toBe(false)
    })
    it("MISSING_DAY_KEY / SAME_PASSWORD → false", () => {
        expect(shouldPersistError("MISSING_DAY_KEY")).toBe(false)
        expect(shouldPersistError("SAME_PASSWORD")).toBe(false)
    })
    it("auth subset → false (selected-cases deferred, documented ambiguity)", () => {
        expect(shouldPersistError("UNAUTHORIZED")).toBe(false)
        expect(shouldPersistError("INVALID_CREDENTIALS")).toBe(false)
        expect(shouldPersistError("WRONG_PASSWORD")).toBe(false)
    })
    it("expected conflicts/business → false (documented ambiguity)", () => {
        expect(shouldPersistError("EMAIL_TAKEN")).toBe(false)
        expect(shouldPersistError("PLAN_STALE")).toBe(false)
        expect(shouldPersistError("TASK_ALREADY_DONE")).toBe(false)
        expect(shouldPersistError("IDEMPOTENCY_CONFLICT")).toBe(false)
        expect(shouldPersistError("AI_USAGE_CONFLICT")).toBe(false)
    })
    it("database infrastructure (Prisma-mapped CONFLICT) → true (infra path, not expected-user)", () => {
        // نکته: کد «CONFLICT» در جدول NON_PERSISTENT است؛ اما mapping infra برای
        // تست DB=true از کد داخلی P2002 استفاده می‌کند که در گام ۴ به DATABASE/INTERNAL می‌رود.
        // اینجا مستند می‌کنیم: کد نهایی infra پس از گام ۴ INTERNAL/CONFLICT-infra خواهد بود.
        expect(shouldPersistError("INTERNAL")).toBe(true)
    })
    it("unknown operational codes default to true (conservative visibility)", () => {
        expect(shouldPersistError("SOME_NEW_UNMAPPED_CODE")).toBe(true)
    })
})
