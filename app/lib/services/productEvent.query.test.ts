// فاز ۳ — گام ۵: تست‌های query service (سند §16/§17)
// پوشش: history per-user، ordering، eventName/feature filter، time-window،
// empty result، usage stats/count، isolation بین کاربران، UTC boundary،
// bounded pagination، DB failure (fail-open)، عدم mutation.

import { describe, expect, it, vi } from "vitest"

import {
    getEventUsageStats,
    listProductEvents,
    PRODUCT_EVENT_QUERY_TIMEOUT_MS,
} from "./productEvent.query"

const NOW = new Date("2026-09-16T12:00:00.000Z")

interface Row {
    id: string
    userId: number
    requestId: string | null
    eventName: string
    feature: string | null
    properties: Record<string, unknown> | null
    createdAt: Date
}

function row(partial: Partial<Row> & { id: string; eventName: string }): Row {
    return {
        userId: 7,
        requestId: "req-1",
        feature: null,
        properties: { taskId: "t1" },
        createdAt: new Date("2026-09-16T10:00:00.000Z"),
        ...partial,
    }
}

function makeClient(rows: Row[], count = rows.length) {
    return {
        productEvent: {
            findMany: vi.fn().mockResolvedValue(rows),
            count: vi.fn().mockResolvedValue(count),
            groupBy: vi.fn().mockResolvedValue([]),
        },
    }
}

describe("listProductEvents", () => {
    it("returns history for a specific user (userId is required)", async () => {
        const client = makeClient([row({ id: "e1", eventName: "task.created" })])
        const result = await listProductEvents(
            { userId: 7 },
            { prisma: { productEvent: client.productEvent }, now: NOW },
        )
        expect(result.events).toHaveLength(1)
        expect(result.events[0].id).toBe("e1")
        expect(result.events[0].userId).toBe(7)
        const where = client.productEvent.findMany.mock.calls[0][0].where
        expect(where.userId).toBe(7)
    })

    it("applies eventName filter (§16: events by eventName)", async () => {
        const client = makeClient([row({ id: "e2", eventName: "task.completed" })])
        await listProductEvents(
            { userId: 7, eventName: "task.completed" },
            { prisma: { productEvent: client.productEvent }, now: NOW },
        )
        const where = client.productEvent.findMany.mock.calls[0][0].where
        expect(where.eventName).toBe("task.completed")
    })

    it("applies feature filter", async () => {
        const client = makeClient([])
        await listProductEvents(
            { userId: 7, feature: "tasks" },
            { prisma: { productEvent: client.productEvent }, now: NOW },
        )
        const where = client.productEvent.findMany.mock.calls[0][0].where
        expect(where.feature).toBe("tasks")
    })

    it("applies UTC time-window filtering (createdAt between since/until)", async () => {
        const client = makeClient([])
        const since = new Date("2026-09-10T00:00:00.000Z")
        const until = new Date("2026-09-15T23:59:59.000Z")
        await listProductEvents(
            { userId: 7, since, until },
            { prisma: { productEvent: client.productEvent }, now: NOW },
        )
        const where = client.productEvent.findMany.mock.calls[0][0].where
        expect(where.createdAt.gte).toBe(since)
        expect(where.createdAt.lte).toBe(until)
    })

    it("uses default 7-day window when no window is provided", async () => {
        const client = makeClient([])
        await listProductEvents(
            { userId: 7 },
            { prisma: { productEvent: client.productEvent }, now: NOW },
        )
        const where = client.productEvent.findMany.mock.calls[0][0].where
        expect(where.createdAt.lte).toEqual(NOW)
        expect(where.createdAt.gte).toEqual(new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000))
    })

    it("clamps window to max 30 days (bounded query)", async () => {
        const client = makeClient([])
        const since = new Date(NOW.getTime() - 90 * 24 * 60 * 60 * 1000)
        await listProductEvents(
            { userId: 7, since },
            { prisma: { productEvent: client.productEvent }, now: NOW },
        )
        const where = client.productEvent.findMany.mock.calls[0][0].where
        expect(where.createdAt.gte).toEqual(new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000))
    })

    it("orders by createdAt desc", async () => {
        const client = makeClient([])
        await listProductEvents(
            { userId: 7 },
            { prisma: { productEvent: client.productEvent }, now: NOW },
        )
        const orderBy = client.productEvent.findMany.mock.calls[0][0].orderBy
        expect(orderBy).toEqual({ createdAt: "desc" })
    })

    it("returns empty result for invalid userId (no query issued)", async () => {
        const client = makeClient([row({ id: "e1", eventName: "task.created" })])
        for (const bad of [0, -1, 2.5, NaN, "7" as unknown as number]) {
            const result = await listProductEvents(
                { userId: bad },
                { prisma: { productEvent: client.productEvent }, now: NOW },
            )
            expect(result).toEqual({ events: [], page: 1, pageSize: 20, total: 0 })
        }
        expect(client.productEvent.findMany).not.toHaveBeenCalled()
    })

    it("returns empty result set when user has no events", async () => {
        const client = makeClient([], 0)
        const result = await listProductEvents(
            { userId: 99 },
            { prisma: { productEvent: client.productEvent }, now: NOW },
        )
        expect(result).toEqual({ events: [], page: 1, pageSize: 20, total: 0 })
    })

    it("isolates users — where always contains the exact userId", async () => {
        const client = makeClient([])
        await listProductEvents(
            { userId: 42 },
            { prisma: { productEvent: client.productEvent }, now: NOW },
        )
        const where = client.productEvent.findMany.mock.calls[0][0].where
        expect(where.userId).toBe(42)
        expect(Object.keys(where)).toContain("userId")
    })

    it("paginates with bounded pageSize (1..100, default 20) and correct skip", async () => {
        const client = makeClient([])
        await listProductEvents(
            { userId: 7, page: 3, pageSize: 50 },
            { prisma: { productEvent: client.productEvent }, now: NOW },
        )
        const args = client.productEvent.findMany.mock.calls[0][0]
        expect(args.take).toBe(50)
        expect(args.skip).toBe(100)

        // clamp: pageSize > 100 → 100؛ page < 1 → 1
        await listProductEvents(
            { userId: 7, page: 0, pageSize: 5000 },
            { prisma: { productEvent: client.productEvent }, now: NOW },
        )
        const args2 = client.productEvent.findMany.mock.calls[1][0]
        expect(args2.take).toBe(100)
        expect(args2.skip).toBe(0)
    })

    it("returns DB failure as empty result (fail-open), never throws", async () => {
        const client = {
            productEvent: {
                findMany: vi.fn().mockRejectedValue(new Error("DB down")),
                count: vi.fn().mockResolvedValue(5),
                groupBy: vi.fn(),
            },
        }
        const result = await listProductEvents(
            { userId: 7 },
            { prisma: { productEvent: client.productEvent }, now: NOW },
        )
        expect(result).toEqual({ events: [], page: 1, pageSize: 20, total: 0 })
    })

    it("returns empty result when count fails after successful findMany (fail-open)", async () => {
        const client = {
            productEvent: {
                findMany: vi.fn().mockResolvedValue([row({ id: "e1", eventName: "task.created" })]),
                count: vi.fn().mockRejectedValue(new Error("DB down")),
                groupBy: vi.fn(),
            },
        }
        const result = await listProductEvents(
            { userId: 7 },
            { prisma: { productEvent: client.productEvent }, now: NOW },
        )
        expect(result).toEqual({ events: [], page: 1, pageSize: 20, total: 0 })
    })

    it("returns empty result on query timeout (bounded read)", async () => {
        const client = {
            productEvent: {
                findMany: vi.fn().mockImplementation(() => new Promise(() => {})),
                count: vi.fn(),
                groupBy: vi.fn(),
            },
        }
        const result = await listProductEvents(
            { userId: 7 },
            { prisma: { productEvent: client.productEvent }, now: NOW, timeoutMs: 20 },
        )
        expect(result).toEqual({ events: [], page: 1, pageSize: 20, total: 0 })
    })

    it("drops malformed rows instead of crashing (fail-open projection)", async () => {
        const client = makeClient([
            row({ id: "e1", eventName: "task.created" }),
            { id: "e2", eventName: "task.created", userId: "not-a-number" } as unknown as Row,
            null as unknown as Row,
        ])
        const result = await listProductEvents(
            { userId: 7 },
            { prisma: { productEvent: client.productEvent }, now: NOW },
        )
        expect(result.events).toHaveLength(1)
        expect(result.events[0].id).toBe("e1")
    })

    it("maps createdAt to UTC ISO string", async () => {
        const client = makeClient([
            row({ id: "e1", eventName: "task.created", createdAt: new Date("2026-09-16T10:30:00.000Z") }),
        ])
        const result = await listProductEvents(
            { userId: 7 },
            { prisma: { productEvent: client.productEvent }, now: NOW },
        )
        expect(result.events[0].createdAt).toBe("2026-09-16T10:30:00.000Z")
    })

    it("never mutates — client exposes only read methods used, no write calls", async () => {
        const client = makeClient([row({ id: "e1", eventName: "task.created" })])
        await listProductEvents(
            { userId: 7 },
            { prisma: { productEvent: client.productEvent }, now: NOW },
        )
        expect(client.productEvent.findMany).toHaveBeenCalledTimes(1)
        expect(client.productEvent.count).toHaveBeenCalledTimes(1)
        expect(client.productEvent.groupBy).not.toHaveBeenCalled()
    })
})

describe("getEventUsageStats", () => {
    it("returns usage counts grouped by eventName and feature", async () => {
        const client = {
            productEvent: {
                findMany: vi.fn(),
                count: vi.fn().mockResolvedValue(12),
                groupBy: vi
                    .fn()
                    .mockResolvedValueOnce([
                        { eventName: "task.created", _count: { _all: 7 } },
                        { eventName: "task.completed", _count: { _all: 5 } },
                    ])
                    .mockResolvedValueOnce([
                        { feature: "tasks", _count: { _all: 9 } },
                        { feature: null, _count: { _all: 3 } },
                    ]),
            },
        }
        const result = await getEventUsageStats(
            { windowHours: 24 },
            { prisma: { productEvent: client.productEvent }, now: NOW },
        )
        expect(result.totalInWindow).toBe(12)
        expect(result.byEventName).toEqual([
            { eventName: "task.created", count: 7 },
            { eventName: "task.completed", count: 5 },
        ])
        expect(result.byFeature).toEqual([
            { feature: "tasks", count: 9 },
            { feature: null, count: 3 },
        ])
        expect(result.windowHours).toBe(24)
    })

    it("scopes stats to userId when provided (isolation)", async () => {
        const client = {
            productEvent: {
                findMany: vi.fn(),
                count: vi.fn().mockResolvedValue(0),
                groupBy: vi.fn().mockResolvedValue([]),
            },
        }
        await getEventUsageStats(
            { windowHours: 24, userId: 42 },
            { prisma: { productEvent: client.productEvent }, now: NOW },
        )
        const where = client.productEvent.count.mock.calls[0][0].where
        expect(where.userId).toBe(42)
    })

    it("global stats omit userId filter when not provided", async () => {
        const client = {
            productEvent: {
                findMany: vi.fn(),
                count: vi.fn().mockResolvedValue(0),
                groupBy: vi.fn().mockResolvedValue([]),
            },
        }
        await getEventUsageStats(
            { windowHours: 24 },
            { prisma: { productEvent: client.productEvent }, now: NOW },
        )
        const where = client.productEvent.count.mock.calls[0][0].where
        expect(where.userId).toBeUndefined()
    })

    it("clamps windowHours to 1..720 with default 24", async () => {
        const client = {
            productEvent: {
                findMany: vi.fn(),
                count: vi.fn().mockResolvedValue(0),
                groupBy: vi.fn().mockResolvedValue([]),
            },
        }
        const opts = { prisma: { productEvent: client.productEvent }, now: NOW }
        const r1 = await getEventUsageStats({ windowHours: 0 }, opts)
        expect(r1.windowHours).toBe(1) // finite → clamp به کف (convention clampInt فاز ۲)
        const r2 = await getEventUsageStats({ windowHours: 5000 }, opts)
        expect(r2.windowHours).toBe(720) // clamp به سقف
        const r3 = await getEventUsageStats({}, opts)
        expect(r3.windowHours).toBe(24)
    })

    it("builds UTC window from injected now", async () => {
        const client = {
            productEvent: {
                findMany: vi.fn(),
                count: vi.fn().mockResolvedValue(0),
                groupBy: vi.fn().mockResolvedValue([]),
            },
        }
        await getEventUsageStats(
            { windowHours: 24 },
            { prisma: { productEvent: client.productEvent }, now: NOW },
        )
        const where = client.productEvent.count.mock.calls[0][0].where
        expect(where.createdAt.gte).toEqual(new Date(NOW.getTime() - 24 * 60 * 60 * 1000))
        expect(where.createdAt.lte).toEqual(NOW)
    })

    it("fails open to empty stats on DB error", async () => {
        const client = {
            productEvent: {
                findMany: vi.fn(),
                count: vi.fn().mockRejectedValue(new Error("DB down")),
                groupBy: vi.fn(),
            },
        }
        const result = await getEventUsageStats(
            {},
            { prisma: { productEvent: client.productEvent }, now: NOW },
        )
        expect(result).toEqual({
            totalInWindow: 0,
            byEventName: [],
            byFeature: [],
            windowHours: 24,
        })
    })

    it("fails open when a groupBy query fails mid-way", async () => {
        const client = {
            productEvent: {
                findMany: vi.fn(),
                count: vi.fn().mockResolvedValue(3),
                groupBy: vi
                    .fn()
                    .mockResolvedValueOnce([{ eventName: "task.created", _count: { _all: 3 } }])
                    .mockRejectedValueOnce(new Error("DB down")),
            },
        }
        const result = await getEventUsageStats(
            {},
            { prisma: { productEvent: client.productEvent }, now: NOW },
        )
        expect(result).toEqual({
            totalInWindow: 0,
            byEventName: [],
            byFeature: [],
            windowHours: 24,
        })
    })

    it("handles malformed groupBy rows safely", async () => {
        const client = {
            productEvent: {
                findMany: vi.fn(),
                count: vi.fn().mockResolvedValue(2),
                groupBy: vi
                    .fn()
                    .mockResolvedValueOnce([null, { _count: { _all: 2 } }])
                    .mockResolvedValueOnce([{ feature: "tasks", _count: { _all: 1 } }]),
            },
        }
        const result = await getEventUsageStats(
            {},
            { prisma: { productEvent: client.productEvent }, now: NOW },
        )
        expect(result.byEventName).toEqual([{ eventName: "UNKNOWN", count: 2 }])
        expect(result.byFeature).toEqual([{ feature: "tasks", count: 1 }])
    })

    it("uses bounded query timeout constant matching the Phase 2/3 pattern", () => {
        expect(PRODUCT_EVENT_QUERY_TIMEOUT_MS).toBe(2000)
    })
})
