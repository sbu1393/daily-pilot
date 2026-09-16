// فاز ۲ — گام ۴: تست‌های persistError (سند فاز ۲)
// پوشش: درج موفق، DB down → fallback، timeout → fallback، late rejection،
// حد رشته‌ها، row-shaping، گارد محیط تست، fail-open بودن خود fallback.

import { afterEach, describe, expect, it, vi } from "vitest"

import {
    PERSIST_LIMITS,
    persistError,
    structuredConsoleFallback,
    toErrorLogRow,
} from "../persistError"
import type { NormalizedErrorRecord } from "../normalizeError"
import type { ObservabilityContext } from "../types"

const CONTEXT: ObservabilityContext = {
    requestId: "req-persist-test",
    endpoint: "POST /api/test",
    userId: 7,
    feature: "observability",
}

const RECORD: NormalizedErrorRecord = {
    errorCode: "INTERNAL",
    statusCode: 500,
    category: "INTERNAL",
    severity: "ERROR",
    safeMessage: "boom",
    stack: "Error: boom\n    at f ()",
}

const fallbackCalls = (spy: { mock: { calls: unknown[][] } }, reason: string) =>
    spy.mock.calls.filter((c) => String(c[0]).includes(reason)).length

afterEach(() => {
    vi.clearAllMocks()
})

describe("persistError — happy path", () => {
    it("inserts via injected create and resolves without console output", async () => {
        const create = vi.fn().mockResolvedValue({ id: "e1" })
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        await persistError(RECORD, CONTEXT, { create })

        expect(create).toHaveBeenCalledTimes(1)
        const data = create.mock.calls[0]![0].data as Record<string, unknown>
        expect(data.requestId).toBe("req-persist-test")
        expect(data.userId).toBe(7)
        expect(data.endpoint).toBe("POST /api/test")
        expect(data.errorCode).toBe("INTERNAL")
        expect(data.statusCode).toBe(500)
        expect(spy).not.toHaveBeenCalled()
    })

    it("maps userId/feature to null when absent from context", async () => {
        const create = vi.fn().mockResolvedValue({})
        await persistError(RECORD, { requestId: "r", endpoint: "e" }, { create })
        const data = create.mock.calls[0]![0].data as Record<string, unknown>
        expect(data.userId).toBeNull()
        expect(data.feature).toBeNull()
    })

    it("uses the test guard when no create is injected (no real DB I/O in tests)", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})
        await expect(persistError(RECORD, CONTEXT)).resolves.toBeUndefined()
        expect(spy).not.toHaveBeenCalled()
    })
})

describe("persistError — DB down (fail-open)", () => {
    it("never throws on rejection and prints fallback (skipTimeoutGuard path)", async () => {
        const create = vi.fn().mockRejectedValue(new Error("db down"))
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        await expect(
            persistError(RECORD, CONTEXT, { create }, { skipTimeoutGuard: true }),
        ).resolves.toBeUndefined()

        expect(spy).toHaveBeenCalledTimes(1)
        const parsed = JSON.parse(spy.mock.calls[0]![0] as string) as Record<string, unknown>
        expect(parsed.channel).toBe("persistError.fallback")
        expect(parsed.reason).toBe("db_insert_failed")
        expect(parsed.requestId).toBe("req-persist-test")
        expect(parsed.errorCode).toBe("INTERNAL")
    })

    it("prints db_insert_failed through the guarded race path too", async () => {
        const create = vi.fn().mockRejectedValue(new Error("db down"))
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        await persistError(RECORD, CONTEXT, { create })

        expect(fallbackCalls(spy, "db_insert_failed")).toBe(1)
    })

    it("never calls the fallback twice on the race path", async () => {
        const create = vi.fn().mockRejectedValue(new Error("db down"))
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        await persistError(RECORD, CONTEXT, { create })

        expect(spy).toHaveBeenCalledTimes(1)
    })
})

describe("persistError — timeout (fail-open)", () => {
    it("prints persist_timeout fallback when insert never settles", async () => {
        const create = vi.fn().mockImplementation(() => new Promise(() => {}))
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        await persistError(RECORD, CONTEXT, { create }, { timeoutMs: 20 })

        expect(spy).toHaveBeenCalledTimes(1)
        const parsed = JSON.parse(spy.mock.calls[0]![0] as string) as Record<string, unknown>
        expect(parsed.reason).toBe("persist_timeout")
    })

    it("prints nothing when insert wins the race", async () => {
        const create = vi.fn().mockResolvedValue({})
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        await persistError(RECORD, CONTEXT, { create }, { timeoutMs: 5_000 })

        expect(spy).not.toHaveBeenCalled()
    })

    it("swallows late rejection after timeout without double fallback", async () => {
        let rejectNow: ((reason: unknown) => void) | undefined
        const create = vi.fn().mockImplementation(
            () =>
                new Promise((_resolve, reject) => {
                    rejectNow = reject
                }),
        )
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        await persistError(RECORD, CONTEXT, { create }, { timeoutMs: 10 })

        expect(JSON.parse(spy.mock.calls[0]![0] as string).reason).toBe("persist_timeout")

        rejectNow!(new Error("late db failure"))
        await new Promise((r) => setTimeout(r, 10))
        expect(fallbackCalls(spy, "db_insert_failed")).toBe(0)
        expect(spy).toHaveBeenCalledTimes(1)
    })
})

describe("persistError — row shaping / limits", () => {
    it("truncates message to 2KB and stack to 4KB (defense in depth)", async () => {
        const create = vi.fn().mockResolvedValue({})
        await persistError(
            { ...RECORD, safeMessage: "a".repeat(3000), stack: "s".repeat(5000) },
            CONTEXT,
            { create },
            { skipTimeoutGuard: true },
        )

        const data = create.mock.calls[0]![0].data as { message: string; stack: string }
        expect(data.message.length).toBeLessThanOrEqual(PERSIST_LIMITS.message)
        expect(data.stack.length).toBeLessThanOrEqual(PERSIST_LIMITS.stack)
    })

    it("toErrorLogRow maps every ErrorLog column from record + context", () => {
        const row = toErrorLogRow(
            {
                ...RECORD,
                errorCode: "QUOTA_UNAVAILABLE",
                statusCode: 503,
                category: "DATABASE",
                severity: "ERROR",
                safeMessage: "quota db unavailable",
                stack: "st",
                metadata: { prismaCode: "P2002" },
            },
            CONTEXT,
        )

        expect(row).toEqual({
            requestId: "req-persist-test",
            userId: 7,
            endpoint: "POST /api/test",
            feature: "observability",
            errorCode: "QUOTA_UNAVAILABLE",
            statusCode: 503,
            category: "DATABASE",
            severity: "ERROR",
            message: "quota db unavailable",
            stack: "st",
            metadata: { prismaCode: "P2002" },
        })
    })

    it("metadata undefined stays undefined (not null)", () => {
        const row = toErrorLogRow(RECORD, CONTEXT)
        expect(row.metadata).toBeUndefined()
    })
})

describe("structuredConsoleFallback", () => {
    it("survives JSON.stringify throwing (fail-open even in fallback)", () => {
        const spy = vi.spyOn(JSON, "stringify").mockImplementation(() => {
            throw new Error("stringify exploded")
        })
        expect(() => structuredConsoleFallback(RECORD, CONTEXT, "test")).not.toThrow()
        spy.mockRestore()
    })

    it("survives console.error throwing (fail-open even in fallback)", () => {
        vi.spyOn(console, "error").mockImplementation(() => {
            throw new Error("console exploded")
        })
        expect(() => structuredConsoleFallback(RECORD, CONTEXT, "test")).not.toThrow()
    })

    it("survives a throwing Date.toISOString", () => {
        vi.spyOn(Date.prototype, "toISOString").mockImplementation(() => {
            throw new Error("clock exploded")
        })
        expect(() => structuredConsoleFallback(RECORD, CONTEXT, "test")).not.toThrow()
    })
})
