// فاز ۲ — گام ۴/۵: تست‌های integration اتصال recordError به pipeline (سند فاز ۲ §14/§15/§16/§17)
// پوشش: ترتیب normalize→redact→policy→persist، **await شدن persistence پیش از resolve** (A3/§14)،
// policy صریح (A1 + A2 برای P2002)، redaction قبل از persist، fail-open کل زنجیره،
// و حفظ قرارداد فاز صفر (امضا + console envelope + فیلد الزامی level).
//
// persistError مرز I/O است و در این فایل mock می‌شود تا قرارداد خالص pipeline قابل اثبات باشد؛
// I/O واقعی همان pipeline در `errorLog.persistence.db.test.ts` روی PostgreSQL واقعی تست می‌شود.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../persistError", () => ({
    persistError: vi.fn(async () => {}),
    structuredConsoleFallback: vi.fn(),
    setRealPersistenceEnabled: vi.fn(),
    isRealPersistenceEnabled: () => false,
    toErrorLogRow: vi.fn(),
}))

import { recordError } from "../recordError"
import { persistError } from "../persistError"
import { ServiceError } from "@/app/lib/services/errors"

const persistMock = vi.mocked(persistError)

const CONTEXT = {
    requestId: "req-pipeline-test",
    endpoint: "POST /api/test",
    userId: 3,
    feature: "observability",
}

const lastRecord = () => persistMock.mock.calls[persistMock.mock.calls.length - 1]![0]
const lastContext = () => persistMock.mock.calls[persistMock.mock.calls.length - 1]![1]

beforeEach(() => {
    persistMock.mockReset()
    persistMock.mockResolvedValue(undefined)
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe("recordError — Phase 2 pipeline (normalize → redact → policy → persist)", () => {
    it("awaits the persistence attempt before resolving and persists the redacted record (A3/§14)", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {})

        let release: (() => void) | undefined
        persistMock.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve
                }),
        )

        let settled = false
        const pending = recordError(new Error("boom"), CONTEXT).then(() => {
            settled = true
        })

        // یک تیک: pipeline باید persist را صدا زده باشد ولی هنوز resolve نشده باشد
        await Promise.resolve()
        expect(persistMock).toHaveBeenCalledTimes(1)
        expect(settled).toBe(false)

        release!()
        await pending
        expect(settled).toBe(true)

        // رکورد سالم و کامل به لایه‌ی persistence می‌رسد
        expect(lastRecord()).toMatchObject({
            errorCode: "INTERNAL",
            statusCode: 500,
            category: "INTERNAL",
            severity: "ERROR",
        })
    })

    it("never rejects even if persistence rejects (fail-open §15)", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {})
        persistMock.mockRejectedValue(new Error("db exploded"))

        await expect(recordError(new Error("boom"), CONTEXT)).resolves.toBeUndefined()
        expect(persistMock).toHaveBeenCalledTimes(1)
    })

    it("forwards the correlation context to the persistence layer", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {})

        await recordError(new Error("boom"), CONTEXT)

        expect(lastContext()).toMatchObject({
            requestId: "req-pipeline-test",
            endpoint: "POST /api/test",
            userId: 3,
        })
    })

    it("passes the redacted record — inline secrets never reach the persistence layer", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {})

        await recordError(
            new ServiceError(503, "QUOTA_UNAVAILABLE", "quota db down password=hunter2"),
            CONTEXT,
        )

        const persisted = JSON.stringify(lastRecord())
        expect(persisted).not.toContain("hunter2")
        expect(lastRecord().safeMessage).toContain("[REDACTED]")
    })
})

describe("recordError — persistence policy (A1/A2)", () => {
    const persisted = async (error: unknown) => {
        vi.spyOn(console, "error").mockImplementation(() => {})
        await recordError(error, CONTEXT)
        return persistMock.mock.calls.length
    }

    it("persists operational failures: QUOTA_UNAVAILABLE, AI_PROVIDER_UNAVAILABLE, INTERNAL", async () => {
        expect(await persisted(new ServiceError(503, "QUOTA_UNAVAILABLE", "q"))).toBe(1)
        expect(await persisted(new ServiceError(503, "AI_PROVIDER_UNAVAILABLE", "p"))).toBe(2)
        expect(await persisted(new Error("boom"))).toBe(3)
    })

    it("ignores expected user errors — validation, not-found, rate limit, conflict (no ErrorLog noise)", async () => {
        expect(await persisted(new ServiceError(400, "VALIDATION_ERROR", "v"))).toBe(0)
        expect(await persisted(new ServiceError(404, "TASK_NOT_FOUND", "n"))).toBe(0)
        expect(await persisted(new ServiceError(429, "QUOTA_EXCEEDED", "q"))).toBe(0)
        expect(await persisted(new ServiceError(401, "UNAUTHORIZED", "u"))).toBe(0)
        expect(await persisted({ code: "CONFLICT", message: "expected user conflict" })).toBe(0)
        expect(await persisted({ code: "EMAIL_TAKEN", message: "taken" })).toBe(0)
    })

    it("persists Prisma P2002 as a database infrastructure failure (A2)", async () => {
        expect(await persisted({ code: "P2002", message: "Unique constraint failed" })).toBe(1)
        expect(lastRecord()).toMatchObject({
            errorCode: "CONFLICT",
            statusCode: 409,
            category: "CONFLICT",
            severity: "WARNING",
        })
        expect(lastRecord().metadata).toEqual({ prismaCode: "P2002" })
    })

    it("still ignores the expected Prisma not-found (P2025) — the policy is not globally conflict-persistent", async () => {
        expect(await persisted({ code: "P2025", message: "Record not found" })).toBe(0)
    })
})

describe("recordError — fail-open (Phase 2 hardening)", () => {
    it("never throws when the whole pipeline misbehaves (evil throwing getter)", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {})
        const evil = {
            get message(): string {
                throw new Error("getter exploded")
            },
        }
        await expect(recordError(evil, CONTEXT)).resolves.toBeUndefined()
    })

    it("never throws for undefined/null/primitive error values", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {})
        await expect(recordError(undefined, CONTEXT)).resolves.toBeUndefined()
        await expect(recordError(null, CONTEXT)).resolves.toBeUndefined()
        await expect(recordError(42, CONTEXT)).resolves.toBeUndefined()
    })

    it("tolerates a missing context (defaults to unknown correlation, still fail-open)", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        // @ts-expect-error — قرارداد فاز صفر: context اختیاری/خراب نباید مسیر پاسخ را بشکند
        await expect(recordError(new Error("boom"), undefined)).resolves.toBeUndefined()

        const parsed = JSON.parse(spy.mock.calls[0]![0] as string) as Record<string, unknown>
        expect(parsed.requestId).toBe("unknown")
        expect(parsed.endpoint).toBe("unknown")
        expect(lastRecord().errorCode).toBe("INTERNAL")
    })
})

describe("recordError — Phase 0 contract preservation", () => {
    it("keeps the exact console envelope for a plain Error (plus the required level field)", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        await recordError(new Error("boom"), CONTEXT)

        const parsed = JSON.parse(spy.mock.calls[0]![0] as string) as Record<string, unknown>
        expect(parsed.requestId).toBe("req-pipeline-test")
        expect(parsed.endpoint).toBe("POST /api/test")
        expect(parsed.userId).toBe(3)
        expect(parsed.name).toBe("Error")
        expect(parsed.message).toBe("boom")
        expect(parsed.category).toBe("UNKNOWN")
        expect(parsed.severity).toBe("ERROR")
        // §16 (A5)
        expect(parsed.level).toBe("error")
        expect(typeof parsed.stack).toBe("string")
    })

    it("keeps meta category/severity override behavior (and derives level from it)", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        await recordError(new Error("db down"), CONTEXT, { category: "DATABASE", severity: "CRITICAL" })

        const parsed = JSON.parse(spy.mock.calls[0]![0] as string) as Record<string, unknown>
        expect(parsed.category).toBe("DATABASE")
        expect(parsed.severity).toBe("CRITICAL")
        expect(parsed.level).toBe("critical")
    })

    it("keeps inline-secret message redaction in console output", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        await recordError(new Error("login failed with password=hunter2"), CONTEXT)

        const parsed = JSON.parse(spy.mock.calls[0]![0] as string) as Record<string, unknown>
        expect(String(parsed.message)).not.toContain("hunter2")
        expect(String(parsed.message)).toContain("[REDACTED]")
    })

    it("keeps the ServiceError → BUSINESS_RULE/WARNING console behavior", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        await recordError(new ServiceError(400, "VALIDATION_ERROR", "bad input"), CONTEXT)

        const parsed = JSON.parse(spy.mock.calls[0]![0] as string) as Record<string, unknown>
        expect(parsed.category).toBe("BUSINESS_RULE")
        expect(parsed.severity).toBe("WARNING")
        expect(parsed.level).toBe("warn")
        expect(parsed.code).toBe("VALIDATION_ERROR")
        expect(parsed.status).toBe(400)
    })

    it("never throws when console.error itself throws (Phase 0 fail-open kept)", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {
            throw new Error("console is broken")
        })
        await expect(recordError(new Error("boom"), CONTEXT)).resolves.toBeUndefined()
    })
})
