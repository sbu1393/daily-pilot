// فاز ۲ — گام ۴: تست‌های persistError (سند فاز ۲)
// پوشش: درج موفق، DB down → fallback، timeout → fallback، late rejection،
// حد رشته‌ها، row-shaping، گارد محیط تست، fail-open بودن خود fallback.

import { afterEach, describe, expect, it, vi } from "vitest"

import {
    PERSIST_LIMITS,
    isRealPersistenceEnabled,
    persistError,
    setRealPersistenceEnabled,
    structuredConsoleFallback,
    toErrorLogRow,
} from "../persistError"
import { resolveEnvironment } from "../environment"
import { severityToConsoleLevel } from "../severityLevel"
import type { NormalizedErrorRecord } from "../normalizeError"
import type { ObservabilityContext } from "../types"

// کلاینت Prisma واقعی هرگز در unit tests لمس نمی‌شود؛ مسیر «بدون create تزریق‌شده»
// با یک create قابل‌مشاهده جایگزین می‌شود تا گارد محیط تست قابل اثبات باشد.
const prismaCreate = vi.hoisted(() => vi.fn(async () => ({ id: "prisma-row" })))
vi.mock("@/app/lib/getPrisma", () => ({
    getPrisma: () => ({ errorLog: { create: prismaCreate } }),
}))

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
        expect(prismaCreate).not.toHaveBeenCalled()
    })
})

// F10 (integration harness): تست‌های واقعی PostgreSQL باید بتوانند مسیر default را روشن کنند.
describe("persistError — real-persistence switch (integration seam)", () => {
    it("is off by default in test env and routed through the default create when enabled", async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        expect(isRealPersistenceEnabled()).toBe(false)
        await persistError(RECORD, CONTEXT)
        expect(prismaCreate).not.toHaveBeenCalled()

        setRealPersistenceEnabled(true)
        try {
            expect(isRealPersistenceEnabled()).toBe(true)
            await persistError(RECORD, CONTEXT)
            expect(prismaCreate).toHaveBeenCalledTimes(1)
            expect(spy).not.toHaveBeenCalled()
        } finally {
            setRealPersistenceEnabled(false)
        }

        expect(isRealPersistenceEnabled()).toBe(false)
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
        // §16 (A5) — فیلد قطعی level در payload ساختاریافته
        expect(parsed.level).toBe("error")
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
            // §8 — از deployment/config خوانده می‌شود (هرگز hard-code در ماژول)
            environment: resolveEnvironment(),
        })
    })

    it("never hard-codes the environment value — it comes from config only", () => {
        // در محیط تستی vitest، NODE_ENV=test است (config)، نه مقدار ثابت production/development
        expect(toErrorLogRow(RECORD, CONTEXT).environment).toBe(resolveEnvironment())
    })

    it("metadata undefined stays undefined (not null)", () => {
        const row = toErrorLogRow(RECORD, CONTEXT)
        expect(row.metadata).toBeUndefined()
    })
})

describe("structuredConsoleFallback — §16 level field (A5)", () => {
    it("emits the complete structured payload including a deterministic level", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        structuredConsoleFallback(
            { ...RECORD, severity: "CRITICAL", metadata: { prismaCode: "P2002" } },
            CONTEXT,
            "db_insert_failed",
        )

        const parsed = JSON.parse(spy.mock.calls[0]![0] as string) as Record<string, unknown>
        expect(parsed).toMatchObject({
            level: "critical",
            channel: "persistError.fallback",
            reason: "db_insert_failed",
            requestId: "req-persist-test",
            endpoint: "POST /api/test",
            userId: 7,
            feature: "observability",
            errorCode: "INTERNAL",
            statusCode: 500,
            category: "INTERNAL",
            severity: "CRITICAL",
            message: "boom",
            stack: "Error: boom\n    at f ()",
            metadata: { prismaCode: "P2002" },
        })
        expect(typeof parsed.timestamp).toBe("string")
    })

    it("maps severity deterministically to level (no per-call/hard-coded value)", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        for (const severity of ["INFO", "WARNING", "ERROR", "CRITICAL"] as const) {
            structuredConsoleFallback({ ...RECORD, severity }, CONTEXT, "probe")
        }

        const levels = spy.mock.calls.map(
            (c) => (JSON.parse(c[0] as string) as { level: string }).level,
        )
        expect(levels).toEqual(["info", "warn", "error", "critical"])
    })
})

describe("severityToConsoleLevel (§16 fallback contract)", () => {
    it("is deterministic and defaults to the most conservative level for unknown input", () => {
        expect(severityToConsoleLevel("INFO")).toBe("info")
        expect(severityToConsoleLevel("WARNING")).toBe("warn")
        expect(severityToConsoleLevel("ERROR")).toBe("error")
        expect(severityToConsoleLevel("CRITICAL")).toBe("critical")
        expect(severityToConsoleLevel("nonsense")).toBe("error")
        expect(severityToConsoleLevel(undefined)).toBe("error")
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
