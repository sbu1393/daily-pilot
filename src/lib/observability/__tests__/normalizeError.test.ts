// فاز ۲ — گام ۲: تست‌های normalizeError (سند فاز ۲ §10/§27)
// پوشش: ServiceError normalization، P2002/P2025 mapping، provider/quota mapping،
// unknown mapping، category/severity derivation، purity (بدون side effect)، serialization failure.

import { describe, expect, it, vi } from "vitest"

import { normalizeError } from "../normalizeError"
import { ServiceError } from "@/app/lib/services/errors"

describe("normalizeError — ServiceError normalization", () => {
    it("maps VALIDATION_ERROR to VALIDATION/INFO with its own status", () => {
        const err = new ServiceError(400, "VALIDATION_ERROR", "اطلاعات نامعتبر است")
        const out = normalizeError(err)

        expect(out.errorCode).toBe("VALIDATION_ERROR")
        expect(out.statusCode).toBe(400)
        expect(out.category).toBe("VALIDATION")
        expect(out.severity).toBe("INFO")
        expect(out.safeMessage).toBe("اطلاعات نامعتبر است")
    })

    it("maps UNAUTHORIZED to AUTHENTICATION/WARNING with 401", () => {
        const err = new ServiceError(401, "UNAUTHORIZED", "Unauthorized")
        const out = normalizeError(err)

        expect(out.category).toBe("AUTHENTICATION")
        expect(out.severity).toBe("WARNING")
        expect(out.statusCode).toBe(401)
    })

    it("maps TASK_NOT_FOUND to NOT_FOUND/INFO with 404", () => {
        const err = new ServiceError(404, "TASK_NOT_FOUND", "پیدا نشد")
        const out = normalizeError(err)

        expect(out.category).toBe("NOT_FOUND")
        expect(out.severity).toBe("INFO")
        expect(out.statusCode).toBe(404)
    })

    it("maps PLAN_STALE to CONFLICT/WARNING with 409", () => {
        const err = new ServiceError(409, "PLAN_STALE", "کهنه است")
        const out = normalizeError(err)

        expect(out.category).toBe("CONFLICT")
        expect(out.severity).toBe("WARNING")
        expect(out.statusCode).toBe(409)
    })

    it("maps TASK_ALREADY_DONE to BUSINESS_RULE/WARNING", () => {
        const err = new ServiceError(400, "TASK_ALREADY_DONE", "قبلاً تمام شده")
        const out = normalizeError(err)

        expect(out.category).toBe("BUSINESS_RULE")
        expect(out.severity).toBe("WARNING")
        expect(out.statusCode).toBe(400)
    })

    it("preserves the safe message and does not include raw details in the record", () => {
        const err = new ServiceError(400, "VALIDATION_ERROR", "پیام امن", { password: "x" })
        const out = normalizeError(err)

        expect(out.safeMessage).toBe("پیام امن")
        // قرارداد §10: جزئیات خام ServiceError به خروجی normalize وارد نمی‌شود (redaction گام ۳)
        expect(out.metadata).toBeUndefined()
    })
})

describe("normalizeError — quota/provider mapping (Phase 1 taxonomy §6)", () => {
    it("QUOTA_EXCEEDED → RATE_LIMIT/WARNING, 429", () => {
        const err = new ServiceError(429, "QUOTA_EXCEEDED", "سهمیه تمام شد")
        const out = normalizeError(err)

        expect(out.errorCode).toBe("QUOTA_EXCEEDED")
        expect(out.statusCode).toBe(429)
        expect(out.category).toBe("RATE_LIMIT")
        expect(out.severity).toBe("WARNING")
    })

    it("QUOTA_UNAVAILABLE → DATABASE/ERROR, 503 (persist-worthy)", () => {
        const err = new ServiceError(503, "QUOTA_UNAVAILABLE", "کووتا در دسترس نیست")
        const out = normalizeError(err)

        expect(out.statusCode).toBe(503)
        expect(out.category).toBe("DATABASE")
        expect(out.severity).toBe("ERROR")
    })

    it("AI_PROVIDER_UNAVAILABLE → EXTERNAL_SERVICE/ERROR, 503 (persist-worthy)", () => {
        const err = new ServiceError(503, "AI_PROVIDER_UNAVAILABLE", "provider در دسترس نیست")
        const out = normalizeError(err)

        expect(out.statusCode).toBe(503)
        expect(out.category).toBe("EXTERNAL_SERVICE")
        expect(out.severity).toBe("ERROR")
    })

    it("IDEMPOTENCY_CONFLICT → CONFLICT/INFO, 409", () => {
        const err = new ServiceError(409, "IDEMPOTENCY_CONFLICT", "تکراری")
        const out = normalizeError(err)

        expect(out.category).toBe("CONFLICT")
        expect(out.severity).toBe("INFO")
        expect(out.statusCode).toBe(409)
    })
})

describe("normalizeError — billing/entitlement taxonomy (Phase 5 §20/§21 — Step 14)", () => {
    const CASES: Array<[string, number, string, string]> = [
        ["PAYMENT_PROVIDER_UNAVAILABLE", 503, "EXTERNAL_SERVICE", "ERROR"],
        ["PAYMENT_PROVIDER_REJECTED", 503, "EXTERNAL_SERVICE", "ERROR"],
        ["PAYMENT_PROVIDER_INVALID_RESPONSE", 503, "EXTERNAL_SERVICE", "ERROR"],
        ["PAYMENT_STATE_UNRESOLVED", 503, "EXTERNAL_SERVICE", "ERROR"],
        ["PAYMENT_VERIFICATION_FAILED", 402, "EXTERNAL_SERVICE", "ERROR"],
        ["PAYMENT_INVALID_AMOUNT", 409, "CONFLICT", "CRITICAL"],
        ["PAYMENT_CONFIGURATION_ERROR", 500, "INTERNAL", "CRITICAL"],
        ["ENTITLEMENT_CONFLICT", 409, "CONFLICT", "WARNING"],
        ["PAYMENT_IDEMPOTENCY_CONFLICT", 409, "CONFLICT", "INFO"],
        ["PAYMENT_NOT_FOUND", 404, "NOT_FOUND", "INFO"],
    ]

    for (const [code, status, category, severity] of CASES) {
        it(`${code} → ${category}/${severity} with ${status} (no INTERNAL fallback)`, () => {
            const out = normalizeError(new ServiceError(status, code, "safe message"))

            expect(out.errorCode).toBe(code)
            expect(out.statusCode).toBe(status)
            expect(out.category).toBe(category)
            expect(out.severity).toBe(severity)
        })
    }

    it("keeps the billing message safe and never derives it from provider details", () => {
        const out = normalizeError(new ServiceError(503, "PAYMENT_PROVIDER_UNAVAILABLE", "سرویس پرداخت در دسترس نیست"))
        expect(out.safeMessage).toBe("سرویس پرداخت در دسترس نیست")
    })
})

describe("normalizeError — Prisma mapping (duck-typed, §9.11 boundary)", () => {
    it("P2002 → CONFLICT/CONFLICT/WARNING/409 with prismaCode metadata", () => {
        const out = normalizeError({ code: "P2002", message: "Unique constraint failed" })

        expect(out.errorCode).toBe("CONFLICT")
        expect(out.statusCode).toBe(409)
        expect(out.category).toBe("CONFLICT")
        expect(out.severity).toBe("WARNING")
        expect(out.metadata).toEqual({ prismaCode: "P2002" })
        // پیام امن پروژه — پیام خام Prisma وارد خروجی نمی‌شود
        expect(out.safeMessage).not.toContain("Unique constraint")
    })

    it("P2025 → NOT_FOUND/NOT_FOUND/INFO/404 with prismaCode metadata", () => {
        const out = normalizeError({ code: "P2025", message: "Record not found" })

        expect(out.errorCode).toBe("NOT_FOUND")
        expect(out.statusCode).toBe(404)
        expect(out.category).toBe("NOT_FOUND")
        expect(out.severity).toBe("INFO")
        expect(out.metadata).toEqual({ prismaCode: "P2025" })
    })

    // A6 — allowlist-first metadata: هیچ پراپرتی دلبخواهی از آبجکت خطا کپی نمی‌شود
    it("allowlist-first: only approved keys enter metadata (arbitrary primitives excluded)", () => {
        const out = normalizeError({
            code: "P2002",
            message: "Unique constraint failed",
            clientVersion: "5.22.0",
            batchRequestIdx: 2,
            secret: "should-never-appear",
            connectionString: "postgres://u:p@h/db",
            prompt: "internal system prompt",
        })

        expect(out.metadata).toEqual({
            clientVersion: "5.22.0",
            batchRequestIdx: 2,
            prismaCode: "P2002",
        })
        // سقف مرز normalization (≤10 پراپرتی) — خود allowlist به‌مراتب کوچک‌تر است
        expect(Object.keys(out.metadata!).length).toBeLessThanOrEqual(10)
    })

    it("allowlist-first: non-approved properties are absent, not merely redacted afterwards", () => {
        const out = normalizeError({
            code: "P2025",
            message: "Record not found",
            secret: "s3cr3t",
            userId: 42,
        })

        expect(out.metadata).not.toHaveProperty("secret")
        expect(out.metadata).not.toHaveProperty("userId")
        expect(JSON.stringify(out.metadata)).not.toContain("s3cr3t")
    })

    it("allowlist-first: object/array values are never copied into metadata", () => {
        const out = normalizeError({
            code: "P2002",
            message: "Unique constraint failed",
            clientVersion: { nested: "value" },
            batchRequestIdx: [1, 2, 3],
        })

        expect(out.metadata).toEqual({ prismaCode: "P2002" })
    })

    it("does not import @prisma/client (boundary — duck-typing only)", async () => {
        const src = await import("node:fs").then((fs) =>
            fs.promises.readFile("src/lib/observability/normalizeError.ts", "utf-8"),
        )
        expect(src).not.toMatch(/from\s+["']@prisma\/client/)
    })
})

describe("normalizeError — unknown/unmapped errors", () => {
    it("plain Error without code → INTERNAL/500/ERROR with generic safe message", () => {
        const out = normalizeError(new Error("db down with password=hunter2"))

        expect(out.errorCode).toBe("INTERNAL")
        expect(out.statusCode).toBe(500)
        expect(out.category).toBe("INTERNAL")
        expect(out.severity).toBe("ERROR")
        // پیام خام با جزئیات بالقوه حساس وارد خروجی نمی‌شود
        expect(out.safeMessage).not.toContain("db down")
        expect(out.safeMessage).not.toContain("hunter2")
    })

    it("plain string → INTERNAL with generic safe message", () => {
        const out = normalizeError("just a string")
        expect(out.errorCode).toBe("INTERNAL")
        expect(out.statusCode).toBe(500)
        expect(out.safeMessage).not.toBe("just a string")
    })

    it("plain number/boolean → INTERNAL", () => {
        expect(normalizeError(42).errorCode).toBe("INTERNAL")
        expect(normalizeError(false).statusCode).toBe(500)
    })

    it("unknown object → INTERNAL without leaking its content", () => {
        const out = normalizeError({ weird: "payload", token: "abc" })
        expect(out.errorCode).toBe("INTERNAL")
        expect(JSON.stringify(out)).not.toContain("payload")
        expect(JSON.stringify(out)).not.toContain("abc")
    })

    it("null/undefined → INTERNAL", () => {
        expect(normalizeError(null).errorCode).toBe("INTERNAL")
        expect(normalizeError(undefined).statusCode).toBe(500)
    })

    it("unmapped ServiceError-like code falls back to INTERNAL/ERROR", () => {
        const out = normalizeError(new ServiceError(500, "SOMETHING_ELSE", "ناشناخته"))
        expect(out.category).toBe("INTERNAL")
        expect(out.severity).toBe("ERROR")
        // کد اصلی حفظ می‌شود (correlation) ولی دسته امن fallback است
        expect(out.errorCode).toBe("SOMETHING_ELSE")
    })
})

describe("normalizeError — stack handling", () => {
    it("includes the stack when it is a string", () => {
        const err = new Error("boom")
        const out = normalizeError(err)
        expect(typeof out.stack).toBe("string")
    })

    it("omits stack when absent", () => {
        const out = normalizeError({ code: "P2002" })
        expect(out.stack).toBeUndefined()
    })
})

describe("normalizeError — purity & serialization failure", () => {
    it("never calls console or persistence (pure function)", async () => {
        const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {})
        const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})

        normalizeError(new Error("boom"))
        normalizeError(new ServiceError(429, "QUOTA_EXCEEDED", "x"))
        normalizeError({ code: "P2002" })

        expect(consoleSpy).not.toHaveBeenCalled()
        expect(consoleLogSpy).not.toHaveBeenCalled()
        consoleSpy.mockRestore()
        consoleLogSpy.mockRestore()
    })

    it("survives a throwing message getter and returns a minimal safe INTERNAL record", () => {
        const evil = {
            get message(): string {
                throw new Error("getter exploded")
            },
        }
        const out = normalizeError(evil)

        expect(out.errorCode).toBe("INTERNAL")
        expect(out.statusCode).toBe(500)
        expect(typeof out.safeMessage).toBe("string")
    })

    it("is deterministic: same input → same output", () => {
        const err = new ServiceError(409, "PLAN_STALE", "کهنه")
        const a = normalizeError(err)
        const b = normalizeError(err)
        expect(a).toEqual(b)
    })

    it("accepts the ObservabilityContext without leaking it into the record", () => {
        const err = new ServiceError(429, "QUOTA_EXCEEDED", "تمام شد")
        const out = normalizeError(err, {
            requestId: "req-123",
            endpoint: "POST /api/tasks/5/analyze",
            userId: 7,
        })
        // context فقط برای مراحل بعدی correlation است — در رکورد normalized تکرار نمی‌شود
        expect(JSON.stringify(out)).not.toContain("req-123")
        expect(JSON.stringify(out)).not.toContain("/api/tasks/5/analyze")
    })
})
