// فاز ۲ — گام ۵: تست‌های Monitoring & Reporting (سند فاز ۲)
// پوشش: pagination، فیلتر severity/feature/errorCode، پنجره زمانی، fail-open خواندن
// (DB down/timeout/shaped-return)، whitelist projection (stack حذف)، redact مجدد
// (secret هرگز در خروجی)، getErrorStats (کل/توزیع/top-5)، گارد محیط تست.

import { afterEach, describe, expect, it, vi } from "vitest"

import {
    getErrorStats,
    listErrorLogs,
    type ReportingOptions,
} from "../errorReporting"

afterEach(() => {
    vi.restoreAllMocks()
})

// ---------- fake row factory ----------

const ROW = {
    id: "e1",
    requestId: "req-1",
    userId: 7,
    endpoint: "POST /api/tasks",
    feature: "tasks",
    errorCode: "INTERNAL",
    statusCode: 500,
    category: "INTERNAL",
    severity: "ERROR",
    message: "boom",
    stack: "Error: boom\n    at f ()",
    metadata: { prismaCode: "P2002" },
    environment: "production",
    createdAt: new Date("2026-09-16T10:00:00Z"),
}

const makeRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
        ...ROW,
        id: `e${i + 1}`,
        createdAt: new Date(ROW.createdAt.getTime() + i * 1000),
    }))

interface MockClient {
    findMany: ReturnType<typeof vi.fn>
    count: ReturnType<typeof vi.fn>
    groupBy: ReturnType<typeof vi.fn>
}

function makeClient(overrides: Partial<Record<keyof MockClient, unknown>> = {}): {
    prisma: ReportingOptions["prisma"]
    mock: MockClient
} {
    const mock: MockClient = {
        findMany: vi.fn().mockResolvedValue(makeRows(3)),
        count: vi.fn().mockResolvedValue(3),
        groupBy: vi.fn().mockResolvedValue([]),
    }
    for (const [key, impl] of Object.entries(overrides)) {
        if (impl === undefined) continue
        mock[key as keyof MockClient] = impl as never
    }
    return {
        prisma: { errorLog: mock } as unknown as NonNullable<ReportingOptions["prisma"]>,
        mock,
    }
}

// ---------- listErrorLogs ----------

describe("listErrorLogs — happy path & query shape", () => {
    it("returns whitelisted views (no stack field) with pagination meta", async () => {
        const { prisma } = makeClient()

        const out = await listErrorLogs({ page: 1, pageSize: 20 }, { prisma })

        expect(out.logs).toHaveLength(3)
        expect(out.total).toBe(3)
        expect(out.page).toBe(1)
        expect(out.pageSize).toBe(20)
        const first = out.logs[0]!
        expect(first.id).toBe("e1")
        expect(first.errorCode).toBe("INTERNAL")
        expect(first.message).toBe("boom")
        expect(first.metadata).toEqual({ prismaCode: "P2002" })
        expect(first.createdAt).toBe(ROW.createdAt.toISOString())
        expect("stack" in first).toBe(false) // stack هرگز در خروجی نیست
    })

    it("passes pagination + filters + time window into the where clause", async () => {
        const { prisma, mock } = makeClient()
        const since = new Date("2026-09-01T00:00:00Z")
        const until = new Date("2026-09-02T00:00:00Z")

        await listErrorLogs(
            { page: 2, pageSize: 10, severity: "ERROR", feature: "tasks", errorCode: "INTERNAL", since, until },
            { prisma },
        )

        const args = mock.findMany.mock.calls[0]![0] as {
            where: Record<string, unknown>
            skip: number
            take: number
            orderBy: unknown
        }
        expect(args.skip).toBe(10)
        expect(args.take).toBe(10)
        expect(args.where.severity).toBe("ERROR")
        expect(args.where.feature).toBe("tasks")
        expect(args.where.errorCode).toBe("INTERNAL")
        expect((args.where.createdAt as { gte: Date }).gte).toBe(since)
        expect((args.where.createdAt as { lte: Date }).lte).toBe(until)
        expect(mock.count.mock.calls[0]![0]).toMatchObject({ where: args.where })
    })

    it("defaults to page 1 / pageSize 20 / 7-day window and desc order", async () => {
        const { prisma, mock } = makeClient()

        const out = await listErrorLogs({}, { prisma })

        expect(out.page).toBe(1)
        expect(out.pageSize).toBe(20)
        const args = mock.findMany.mock.calls[0]![0] as {
            where: { createdAt: { gte: Date; lte: Date } }
            orderBy: unknown
        }
        expect(args.orderBy).toEqual({ createdAt: "desc" })
        const spanMs = args.where.createdAt.lte.getTime() - args.where.createdAt.gte.getTime()
        expect(spanMs).toBe(7 * 24 * 60 * 60 * 1000)
    })

    it("clamps invalid page/pageSize (0 → 1, 1000 → 100, NaN → defaults)", async () => {
        const { prisma } = makeClient()

        const out = await listErrorLogs({ page: 0, pageSize: 1000 }, { prisma })
        expect(out.page).toBe(1)
        expect(out.pageSize).toBe(100)

        const out2 = await listErrorLogs(
            { page: Number.NaN, pageSize: Number.NaN },
            { prisma },
        )
        expect(out2.page).toBe(1)
        expect(out2.pageSize).toBe(20)
    })

    it("caps the time window at 30 days even when a longer range is requested", async () => {
        const { prisma, mock } = makeClient()
        const until = new Date("2026-09-16T00:00:00Z")
        const since = new Date("2026-01-01T00:00:00Z") // خیلی قدیمی — باید بریده شود

        await listErrorLogs({ since, until }, { prisma })

        const args = mock.findMany.mock.calls[0]![0] as {
            where: { createdAt: { gte: Date; lte: Date } }
        }
        const spanMs = args.where.createdAt.lte.getTime() - args.where.createdAt.gte.getTime()
        expect(spanMs).toBe(30 * 24 * 60 * 60 * 1000)
    })

    it("skips DB I/O in test env when no prisma is injected (test guard)", async () => {
        const out = await listErrorLogs({})
        expect(out).toEqual({ logs: [], page: 1, pageSize: 20, total: 0 })
    })
})

describe("listErrorLogs — fail-open reading", () => {
    it("returns empty result (not throw) when the DB is down", async () => {
        const { prisma } = makeClient({
            findMany: vi.fn().mockRejectedValue(new Error("db down")),
        })
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        await expect(
            listErrorLogs({ page: 2, pageSize: 5 }, { prisma }),
        ).resolves.toEqual({ logs: [], page: 2, pageSize: 5, total: 0 })
        expect(spy).not.toHaveBeenCalled() // silent fail-open
    })

    it("returns empty result when the count query fails", async () => {
        const { prisma } = makeClient({ count: vi.fn().mockRejectedValue(new Error("count fail")) })

        await expect(listErrorLogs({}, { prisma })).resolves.toMatchObject({
            logs: [],
            total: 0,
        })
    })

    it("returns empty result on timeout (never hangs the caller)", async () => {
        const { prisma } = makeClient({
            findMany: vi.fn().mockImplementation(() => new Promise(() => {})),
        })

        await expect(
            listErrorLogs({}, { prisma, timeoutMs: 20 }),
        ).resolves.toMatchObject({ logs: [], total: 0 })
    })

    it("drops malformed rows instead of crashing (partial fail-open)", async () => {
        const { prisma } = makeClient({
            findMany: vi.fn().mockResolvedValue([null, "junk", 42, { id: "ok1", errorCode: "INTERNAL", message: "m" }, ROW]),
        })

        const out = await listErrorLogs({}, { prisma })

        expect(out.logs).toHaveLength(2) // فقط رکوردهای معتبر
        expect(out.logs[0]!.id).toBe("ok1")
        expect(out.logs[1]!.id).toBe("e1")
    })
})

describe("listErrorLogs — security (whitelist + re-redaction)", () => {
    it("re-redacts secrets that somehow reached the DB row", async () => {
        const leaked = {
            ...ROW,
            metadata: { connectionString: "postgres://u:p@h/db", requestId: "keep-me" },
            message: "failed with password=hunter2",
        }
        const { prisma } = makeClient({ findMany: vi.fn().mockResolvedValue([leaked]) })

        const out = await listErrorLogs({}, { prisma })

        expect(out.logs).toHaveLength(1)
        const json = JSON.stringify(out.logs[0])
        expect(json).not.toContain("postgres://u:p@h/db")
        expect(json).not.toContain("hunter2")
        expect((out.logs[0]!.metadata as Record<string, unknown>).connectionString).toBe("[REDACTED]")
        // requestId تشخیصی حفظ می‌شود
        expect((out.logs[0]!.metadata as Record<string, unknown>).requestId).toBe("keep-me")
        expect(out.logs[0]!.message).toContain("[REDACTED]")
    })

    it("never includes stack in any log view", async () => {
        const { prisma } = makeClient()

        const out = await listErrorLogs({}, { prisma })

        for (const log of out.logs) {
            expect("stack" in log).toBe(false)
            expect(JSON.stringify(log)).not.toContain("at f ()")
        }
    })
})

// ---------- getErrorStats ----------

describe("getErrorStats — happy path", () => {
    it("computes total, severity distribution and top-5 codes", async () => {
        const { prisma, mock } = makeClient({
            count: vi.fn().mockResolvedValue(12),
            groupBy: vi
                .fn()
                .mockImplementation((args: unknown) => {
                    const a = args as { by: string[] }
                    if (a.by[0] === "severity") {
                        return Promise.resolve([
                            { severity: "ERROR", _count: { _all: 9 } },
                            { severity: "WARNING", _count: { _all: 3 } },
                        ])
                    }
                    return Promise.resolve([
                        { errorCode: "INTERNAL", _count: { _all: 6 } },
                        { errorCode: "QUOTA_UNAVAILABLE", _count: { _all: 4 } },
                        { errorCode: "AI_PROVIDER_UNAVAILABLE", _count: { _all: 2 } },
                    ])
                }),
        })

        const out = await getErrorStats({ windowHours: 24 }, { prisma })

        expect(out.totalInWindow).toBe(12)
        expect(out.bySeverity).toEqual([
            { severity: "ERROR", count: 9 },
            { severity: "WARNING", count: 3 },
        ])
        expect(out.topErrors).toHaveLength(3)
        expect(out.topErrors[0]).toEqual({ errorCode: "INTERNAL", count: 6 })
        expect(out.windowHours).toBe(24)

        // where مشترک با پنجره ۲۴ ساعت
        const countArgs = mock.count.mock.calls[0]![0] as {
            where: { createdAt: { gte: Date; lte: Date } }
        }
        const spanMs = countArgs.where.createdAt.lte.getTime() - countArgs.where.createdAt.gte.getTime()
        expect(spanMs).toBe(24 * 60 * 60 * 1000)
    })

    it("sorts topErrors by count desc and slices to 5", async () => {
        const codes = Array.from({ length: 9 }, (_, i) => ({
            errorCode: `CODE_${i}`,
            _count: { _all: 10 - i },
        }))
        const { prisma } = makeClient({
            groupBy: vi.fn().mockResolvedValue(codes),
            count: vi.fn().mockResolvedValue(45),
        })

        const out = await getErrorStats({}, { prisma })

        expect(out.topErrors).toHaveLength(5)
        const counts = out.topErrors.map((t) => t.count)
        expect(counts).toEqual([...counts].sort((a, b) => b - a))
        expect(out.topErrors[0]!.count).toBe(10)
    })

    it("skips DB I/O in test env when no prisma is injected (test guard)", async () => {
        const out = await getErrorStats()
        expect(out).toEqual({ totalInWindow: 0, bySeverity: [], topErrors: [], windowHours: 24 })
    })

    it("clamps windowHours to [1..720]", async () => {
        const { prisma, mock } = makeClient({
            count: vi.fn().mockResolvedValue(0),
            groupBy: vi.fn().mockResolvedValue([]),
        })

        await getErrorStats({ windowHours: 5000 }, { prisma })
        const args = mock.count.mock.calls[0]![0] as {
            where: { createdAt: { gte: Date; lte: Date } }
        }
        const spanMs = args.where.createdAt.lte.getTime() - args.where.createdAt.gte.getTime()
        expect(spanMs).toBe(30 * 24 * 60 * 60 * 1000) // سقف ۳۰ روز

        await getErrorStats({ windowHours: 0 }, { prisma })
        const args2 = mock.count.mock.calls[1]![0] as {
            where: { createdAt: { gte: Date; lte: Date } }
        }
        const span2 = args2.where.createdAt.lte.getTime() - args2.where.createdAt.gte.getTime()
        expect(span2).toBe(1 * 60 * 60 * 1000) // کف ۱ ساعت
    })
})

describe("getErrorStats — fail-open reading", () => {
    it("returns zeroed stats when the DB is down (never throws)", async () => {
        const { prisma } = makeClient({ count: vi.fn().mockRejectedValue(new Error("db down")) })

        await expect(getErrorStats({}, { prisma })).resolves.toEqual({
            totalInWindow: 0,
            bySeverity: [],
            topErrors: [],
            windowHours: 24,
        })
    })

    it("returns zeroed stats when a groupBy fails or times out", async () => {
        const { prisma } = makeClient({
            groupBy: vi.fn().mockRejectedValue(new Error("group fail")),
        })
        await expect(getErrorStats({}, { prisma })).resolves.toMatchObject({
            totalInWindow: 0,
            bySeverity: [],
            topErrors: [],
        })

        const { prisma: prisma2 } = makeClient({
            groupBy: vi.fn().mockImplementation(() => new Promise(() => {})),
        })
        await expect(getErrorStats({}, { prisma: prisma2, timeoutMs: 20 })).resolves.toMatchObject({
            bySeverity: [],
            topErrors: [],
        })
    })

    it("survives malformed groupBy rows (safe mapping)", async () => {
        const { prisma } = makeClient({
            count: vi.fn().mockResolvedValue(2),
            groupBy: vi
                .fn()
                .mockResolvedValue([{ severity: 123, _count: { _all: "x" } }, null, 5]),
        })

        const out = await getErrorStats({}, { prisma })

        expect(out.bySeverity).toEqual([{ severity: "UNKNOWN", count: 0 }])
        expect(out.totalInWindow).toBe(2)
    })
})
