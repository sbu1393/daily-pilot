// فاز صفر Observability — تست‌های یونیت پوشه‌ی observability
// ابزار تست: همان vitest موجود پروژه (بدون پکیج جدید).
// این فایل فقط API عمومی observability را مصرف می‌کند و هیچ فایل سورسی را تغییر نمی‌دهد.

import { afterEach, describe, expect, it, vi } from "vitest"

import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import type { ObservabilityContext } from "@/src/lib/observability/types"
import { ServiceError } from "@/app/lib/services/errors"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function makeContext(): ObservabilityContext {
    return { requestId: "req-test", endpoint: "POST /api/test", userId: 7 }
}

/** آخرین فراخوانی console.error را به‌صورت JSON پارس‌شده برمی‌گرداند. */
function lastLog(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
    const calls = spy.mock.calls
    expect(calls.length).toBeGreaterThan(0)
    const raw = calls[calls.length - 1][0]
    expect(typeof raw).toBe("string")
    return JSON.parse(raw as string) as Record<string, unknown>
}

afterEach(() => {
    vi.restoreAllMocks()
})

describe("createObservabilityContext", () => {
    it("produces a non-empty, valid UUID requestId", () => {
        const ctx = createObservabilityContext("POST /api/tasks")
        expect(typeof ctx.requestId).toBe("string")
        expect(ctx.requestId.length).toBeGreaterThan(0)
        expect(ctx.requestId).toMatch(UUID_RE)
    })

    it("never repeats requestId across consecutive calls", () => {
        const a = createObservabilityContext("GET /api/tasks")
        const b = createObservabilityContext("GET /api/tasks")
        const c = createObservabilityContext("GET /api/tasks")
        expect(a.requestId).not.toBe(b.requestId)
        expect(b.requestId).not.toBe(c.requestId)
        expect(a.requestId).not.toBe(c.requestId)
    })

    it("sets endpoint and passes feature through when given", () => {
        const ctx = createObservabilityContext("POST /api/tasks", "tasks")
        expect(ctx.endpoint).toBe("POST /api/tasks")
        expect(ctx.feature).toBe("tasks")
    })

    it("leaves feature undefined when omitted", () => {
        const ctx = createObservabilityContext("GET /api/tasks")
        expect(ctx.endpoint).toBe("GET /api/tasks")
        expect(ctx.feature).toBeUndefined()
        expect("feature" in ctx).toBe(false)
    })
})

describe("recordError — normalization", () => {
    it("logs a structured JSON envelope with required fields for a plain Error", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})
        const ctx = makeContext()

        expect(() => recordError(new Error("boom"), ctx)).not.toThrow()

        const parsed = lastLog(spy)
        for (const key of [
            "timestamp",
            "requestId",
            "endpoint",
            "userId",
            "category",
            "severity",
            "message",
            "stack",
        ]) {
            expect(parsed).toHaveProperty(key)
        }
        expect(new Date(parsed.timestamp as string).getTime()).not.toBeNaN()
        expect(parsed.requestId).toBe("req-test")
        expect(parsed.endpoint).toBe("POST /api/test")
        expect(parsed.userId).toBe(7)
        expect(parsed.name).toBe("Error")
        expect(parsed.message).toBe("boom")
        expect(typeof parsed.stack).toBe("string")
        expect(parsed.category).toBe("UNKNOWN")
        expect(parsed.severity).toBe("ERROR")
    })

    it("maps ServiceError to code/status with BUSINESS_RULE/WARNING defaults", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})
        const ctx = makeContext()

        const err = new ServiceError(409, "PLAN_STALE", "برنامه کهنه است")
        expect(() => recordError(err, ctx)).not.toThrow()

        const parsed = lastLog(spy)
        expect(parsed.name).toBe("ServiceError")
        expect(parsed.message).toBe("برنامه کهنه است")
        expect(parsed.code).toBe("PLAN_STALE")
        expect(parsed.status).toBe(409)
        expect(parsed.category).toBe("BUSINESS_RULE")
        expect(parsed.severity).toBe("WARNING")
    })

    it("normalizes a plain string without crashing", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        expect(() => recordError("just a string", makeContext())).not.toThrow()

        const parsed = lastLog(spy)
        expect(parsed.name).toBe("UnknownError")
        expect(parsed.message).toBe("just a string")
        expect(parsed.severity).toBe("ERROR")
    })

    it("normalizes an unknown object without crashing (rest goes to details)", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        expect(() => recordError({ foo: 1, bar: "baz" }, makeContext())).not.toThrow()

        const parsed = lastLog(spy)
        expect(parsed.name).toBe("UnknownError")
        expect(parsed.message).toBe("[non-Error object]")
        expect(parsed.details).toEqual({ foo: 1, bar: "baz" })
    })

    it("honors valid meta category/severity and rejects invalid ones", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})
        const ctx = makeContext()

        recordError(new Error("db down"), ctx, { category: "DATABASE", severity: "CRITICAL" })
        const valid = lastLog(spy)
        expect(valid.category).toBe("DATABASE")
        expect(valid.severity).toBe("CRITICAL")

        recordError(new Error("db down"), ctx, { category: "NOT_A_CATEGORY", severity: "LOUD" })
        const invalid = lastLog(spy)
        expect(invalid.category).toBe("UNKNOWN")
        expect(invalid.severity).toBe("ERROR")
    })
})

describe("recordError — redaction", () => {
    it("redacts sensitive keys (password/token/authorization/cookie/secret) in details", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})
        const ctx = makeContext()

        const err = new ServiceError(400, "VALIDATION_ERROR", "invalid payload", {
            password: "hunter2",
            token: "jwt-abc",
            authorization: "Bearer x.y.z",
            cookie: "sid=1",
            apiKey: "key-123",
            username: "ali",
            nested: { secret: "s", visible: "v" },
        })
        expect(() => recordError(err, ctx)).not.toThrow()

        const parsed = lastLog(spy)
        const details = parsed.details as Record<string, unknown>
        expect(details.password).toBe("[REDACTED]")
        expect(details.token).toBe("[REDACTED]")
        expect(details.authorization).toBe("[REDACTED]")
        expect(details.cookie).toBe("[REDACTED]")
        expect(details.apiKey).toBe("[REDACTED]")
        expect(details.username).toBe("ali")
        expect(details.nested).toEqual({ secret: "[REDACTED]", visible: "v" })
    })

    it("redacts inline secrets inside the message text", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        recordError(
            new Error('login failed with password=hunter2 token="abc123"'),
            makeContext(),
        )

        const parsed = lastLog(spy)
        expect(String(parsed.message)).not.toContain("hunter2")
        expect(String(parsed.message)).not.toContain("abc123")
        expect(String(parsed.message)).toContain("[REDACTED]")
    })

    it("keeps non-sensitive fields intact", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        recordError(
            new ServiceError(404, "TASK_NOT_FOUND", "پیدا نشد", { taskId: 5 }),
            makeContext(),
        )

        const parsed = lastLog(spy)
        const details = parsed.details as Record<string, unknown>
        expect(details.taskId).toBe(5)
        expect(parsed.code).toBe("TASK_NOT_FOUND")
    })
})

describe("recordError — fail-open", () => {
    it("never throws when console.error itself throws", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {
            throw new Error("console is broken")
        })

        expect(() => recordError(new Error("boom"), makeContext())).not.toThrow()
        expect(spy).toHaveBeenCalledTimes(1) // تلاش لاگ انجام شد؛ خطای داخلی بلعیده شد
    })

    it("never throws when the environment misbehaves (Date.toISOString throws)", () => {
        vi.spyOn(Date.prototype, "toISOString").mockImplementation(() => {
            throw new Error("clock exploded")
        })

        expect(() => recordError(new Error("boom"), makeContext())).not.toThrow()
    })

    it("never throws when the error object has a throwing getter", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})
        const evil = {
            get message(): string {
                throw new Error("getter exploded")
            },
        }

        expect(() => recordError(evil, makeContext())).not.toThrow()
        // لاگ منتشر نشد (normalize در try اصلی افتاد) — اما هیچ استثنایی به بیرون نرفت
        expect(spy).not.toHaveBeenCalled()
    })

    it("never throws for undefined/null/number error values", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        expect(() => recordError(undefined, makeContext())).not.toThrow()
        expect(() => recordError(null, makeContext())).not.toThrow()
        expect(() => recordError(42, makeContext())).not.toThrow()

        const parsed = lastLog(spy)
        expect(parsed.message).toBe("42")
    })
})
