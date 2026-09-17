import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* فاز ۴ — Step 5: admin.query — read-only foundation                  */
/* الگوی repository: Prisma client تزریق‌شده mock می‌شود (no real DB).   */
/* ------------------------------------------------------------------ */

vi.mock("./getPrisma", () => ({ getPrisma: () => ({}) }))

import {
    getAdminActivity,
    getAdminActivityStats,
    getAdminAiUsage,
    getAdminErrors,
    getAdminErrorStats,
    getAdminOverview,
    ADMIN_QUERY_MAX_PAGE_SIZE,
} from "./admin.query"

const NOW = new Date("2026-09-17T10:00:00.000Z")

function makePrisma() {
    return {
        aiUsage: { findMany: vi.fn().mockResolvedValue([]) },
        aiUsageEvent: {
            findMany: vi.fn().mockResolvedValue([]),
            count: vi.fn().mockResolvedValue(0),
        },
    }
}

describe("getAdminActivity (ProductEvent source — Phase 3 primitive only)", () => {
    it("delegates to listProductEvents with a valid bounded userId filter", async () => {
        const result = await getAdminActivity({ userId: 5, page: 2, pageSize: 10 })

        expect(result).toEqual({ events: [], page: 2, pageSize: 10, total: 0 })
    })

    it("returns empty for a global (userId-less) history request — per-user primitive", async () => {
        const result = await getAdminActivity({})

        expect(result).toEqual({ events: [], page: 1, pageSize: 20, total: 0 })
    })

    it("clamps pageSize above 100 to 100 (bounded pagination)", async () => {
        const result = await getAdminActivity({ userId: 5, pageSize: 5000 })

        expect(result.pageSize).toBe(100)
    })

    it("stats delegate to getEventUsageStats (global event usage, not DAU source)", async () => {
        const result = await getAdminActivityStats(48)

        expect(result.windowHours).toBe(48)
        expect(result.byEventName).toEqual([])
    })
})

describe("getAdminAiUsage (AiUsage + AiUsageEvent — read-only)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("issues only read calls (findMany/count) — never mutations", async () => {
        const prisma = makePrisma()

        await getAdminAiUsage({ userId: 3 }, { prisma, now: NOW })

        expect(prisma.aiUsage.findMany).toHaveBeenCalledTimes(1)
        expect(prisma.aiUsageEvent.findMany).toHaveBeenCalledTimes(1)
        expect(prisma.aiUsageEvent.count).toHaveBeenCalledTimes(1)
        // هیچ reserve/complete/release/update/create در سطح این mock وجود ندارد —
        // خود client فقط findMany/count را expose می‌کند؛ تایپ آن mutation را ناممکن می‌کند.
    })

    it("returns allowlisted DTOs only — no raw model, no prompt/response, deterministic ordering", async () => {
        const prisma = makePrisma()
        prisma.aiUsage.findMany.mockResolvedValue([
            {
                id: 1,
                userId: 3,
                periodType: "MONTHLY",
                periodStart: new Date("2026-09-01T00:00:00.000Z"),
                reservedUnits: 10,
                consumedUnits: 4,
                // فیلد خارج از allowlist — هرگز نباید در خروجی باشد
                internalNote: "secret",
            },
        ])
        prisma.aiUsageEvent.findMany.mockResolvedValue([
            {
                id: 7,
                requestId: "req_abc",
                userId: 3,
                feature: "analyze",
                model: "mock",
                units: 1,
                status: "CONSUMED",
                attempts: 1,
                failureCode: null,
                durationMs: 120,
                createdAt: new Date("2026-09-16T08:00:00.000Z"),
            },
        ])
        prisma.aiUsageEvent.count.mockResolvedValue(1)

        const result = await getAdminAiUsage({ userId: 3 }, { prisma, now: NOW })

        expect(result.quota[0]).toEqual({
            id: 1,
            userId: 3,
            periodType: "MONTHLY",
            periodStart: "2026-09-01T00:00:00.000Z",
            reservedUnits: 10,
            consumedUnits: 4,
        })
        expect(result.events[0]).toEqual({
            id: 7,
            requestId: "req_abc",
            userId: 3,
            feature: "analyze",
            model: "mock",
            units: 1,
            status: "CONSUMED",
            attempts: 1,
            failureCode: null,
            durationMs: 120,
            createdAt: "2026-09-16T08:00:00.000Z",
        })
        // ordering arguments deterministic: createdAt desc, id desc
        const findArgs = prisma.aiUsageEvent.findMany.mock.calls[0][0] as {
            orderBy: Record<string, string>[]
            take: number
            skip: number
        }
        expect(findArgs.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }])
        expect(findArgs.take).toBe(20)
        expect(findArgs.skip).toBe(0)
    })

    it("clamps pageSize to the 100 cap and skips negative pages", async () => {
        const prisma = makePrisma()

        const over = await getAdminAiUsage({ pageSize: 1000 }, { prisma, now: NOW })
        const neg = await getAdminAiUsage({ page: -5 }, { prisma, now: NOW })

        expect(over.pageSize).toBe(ADMIN_QUERY_MAX_PAGE_SIZE)
        expect(neg.page).toBe(1)
    })

    it("fails open — DB rejection yields empty result with the requested page shape", async () => {
        const prisma = makePrisma()
        prisma.aiUsageEvent.findMany.mockRejectedValue(new Error("db down"))

        const result = await getAdminAiUsage({ userId: 3, page: 2, pageSize: 5 }, { prisma, now: NOW })

        expect(result).toEqual({ quota: [], events: [], page: 2, pageSize: 5, total: 0 })
    })

    it("drops malformed rows instead of crashing (allowlist projection guard)", async () => {
        const prisma = makePrisma()
        prisma.aiUsageEvent.findMany.mockResolvedValue([{ broken: true }, null])

        const result = await getAdminAiUsage({}, { prisma, now: NOW })

        expect(result.events).toEqual([])
    })
})

describe("getAdminErrors (Phase 2 primitive — redaction preserved)", () => {
    it("delegates to listErrorLogs and returns the stack-free view shape", async () => {
        const result = await getAdminErrors({ pageSize: 7 })

        expect(result.pageSize).toBe(7)
        expect(result.logs).toEqual([])
        expect(result.total).toBe(0)
    })

    it("delegates stats to getErrorStats (fail-open zeros)", async () => {
        const result = await getAdminErrorStats({ windowHours: 24 })

        expect(result.totalInWindow).toBe(0)
    })
})

describe("getAdminOverview — independent widgets (§12)", () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("users widget delegates to getActiveUserStats with the injected client and now", async () => {
        const count = vi.fn().mockResolvedValue(4)

        const result = await getAdminOverview({
            now: NOW,
            prismaClient: { user: { count } },
        })

        expect(result.users).toEqual({ dau: 4, wau: 4, mau: 4 })
        // window boundaries از now تزریق‌شده مشتق می‌شوند (dau = 24h)
        expect(count.mock.calls[0][0].where.lastSeenAt.gte.toISOString()).toBe(
            "2026-09-16T10:00:00.000Z",
        )
    })

    it("users widget fails open to zeros when the underlying read fails (widget isolation)", async () => {
        const count = vi.fn().mockRejectedValue(new Error("db down"))

        const result = await getAdminOverview({
            now: NOW,
            prismaClient: { user: { count } },
        })

        expect(result.users).toEqual({ dau: 0, wau: 0, mau: 0 })
    })

    it("aiQuota widget aggregates the current period — read-only aggregate only", async () => {
        const aggregate = vi.fn().mockResolvedValue({
            _sum: { reservedUnits: 30, consumedUnits: 12 },
        })

        const result = await getAdminOverview({
            now: NOW,
            prisma: { aiUsage: { aggregate } },
            prismaClient: { user: { count: vi.fn().mockResolvedValue(0) } },
        })

        expect(result.aiQuota).toEqual({
            periodStart: "2026-09-01T00:00:00.000Z",
            reservedUnits: 30,
            consumedUnits: 12,
        })
        const args = aggregate.mock.calls[0][0] as { where: Record<string, unknown> }
        expect(args.where).toEqual({ periodType: "MONTHLY", periodStart: new Date("2026-09-01T00:00:00.000Z") })
    })

    it("aiQuota widget failure leaves only that widget unavailable (§12)", async () => {
        const aggregate = vi.fn().mockRejectedValue(new Error("db down"))

        const result = await getAdminOverview({
            now: NOW,
            prisma: { aiUsage: { aggregate } },
            prismaClient: { user: { count: vi.fn().mockResolvedValue(2) } },
        })

        expect(result.aiQuota).toBeNull()
        expect(result.users).toEqual({ dau: 2, wau: 2, mau: 2 })
        expect(result.errors.totalInWindow).toBe(0)
    })

    it("activity and errors widgets come from Phase 2/3 primitives (fail-open)", async () => {
        const result = await getAdminOverview({
            now: NOW,
            prismaClient: { user: { count: vi.fn().mockResolvedValue(0) } },
        })

        expect(result.activity.windowHours).toBe(24)
        expect(result.errors.totalInWindow).toBe(0)
    })
})
