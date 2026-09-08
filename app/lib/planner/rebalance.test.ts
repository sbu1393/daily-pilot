import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* A3 — تست‌های موتور lazy rebalance (planner/rebalance.ts)            */
/* Prisma mock است: بدون DB زنده.                                      */
/* ------------------------------------------------------------------ */

const { prismaMock, getPrismaMock } = vi.hoisted(() => {
    const prismaMock = {
        task: { findMany: vi.fn(), update: vi.fn() },
        dailyPlan: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
        $transaction: vi.fn(async (arg: unknown) => {
            if (typeof arg === "function") return (arg as (tx: unknown) => unknown)(prismaMock)
            return arg
        }),
    }
    return { prismaMock, getPrismaMock: vi.fn(() => prismaMock) }
})

vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: getPrismaMock }))

import { ensureDayRebalanced, markDayStale, rebalanceDay } from "./rebalance"

const USER_ID = 1
const DAY_KEY = "2026-03-05"
const wherePlan = { where: { userId_dayKey: { userId: USER_ID, dayKey: DAY_KEY } } }

describe("markDayStale (A3 mutation bump)", () => {
    beforeEach(() => vi.clearAllMocks())

    it("bumps planVersion atomically on the existing row", async () => {
        prismaMock.dailyPlan.updateMany.mockResolvedValue({ count: 1 })

        await markDayStale(USER_ID, DAY_KEY)

        expect(prismaMock.dailyPlan.updateMany).toHaveBeenCalledWith({
            where: { userId: USER_ID, dayKey: DAY_KEY },
            data: { planVersion: { increment: 1 } },
        })
    })
})

describe("ensureDayRebalanced (A3 lazy trigger)", () => {
    beforeEach(() => vi.clearAllMocks())

    it("returns null when no DailyPlan exists (absence = stale, nothing to distribute)", async () => {
        prismaMock.dailyPlan.findUnique.mockResolvedValue(null)

        const result = await ensureDayRebalanced(USER_ID, DAY_KEY)

        expect(result).toBeNull()
        expect(prismaMock.task.findMany).not.toHaveBeenCalled()
    })

    it("runs rebalance when rebalancedVersion is null (never rebalanced)", async () => {
        prismaMock.dailyPlan.findUnique.mockResolvedValue({
            availableMinutes: 120,
            planVersion: 3,
            rebalancedVersion: null,
        })
        prismaMock.task.findMany.mockResolvedValue([])

        const result = await ensureDayRebalanced(USER_ID, DAY_KEY)

        expect(result).not.toBeNull()
        expect(result?.dayKey).toBe(DAY_KEY)
    })

    it("runs rebalance when planVersion > rebalancedVersion (stale)", async () => {
        prismaMock.dailyPlan.findUnique.mockResolvedValue({
            availableMinutes: 120,
            planVersion: 5,
            rebalancedVersion: 3,
        })
        prismaMock.task.findMany.mockResolvedValue([])

        const result = await ensureDayRebalanced(USER_ID, DAY_KEY)

        expect(result).not.toBeNull()
    })

    it("skips rebalance when planVersion == rebalancedVersion (fresh)", async () => {
        prismaMock.dailyPlan.findUnique.mockResolvedValue({
            availableMinutes: 120,
            planVersion: 3,
            rebalancedVersion: 3,
        })

        const result = await ensureDayRebalanced(USER_ID, DAY_KEY)

        expect(result).toBeNull()
        expect(prismaMock.task.findMany).not.toHaveBeenCalled()
    })
})

describe("rebalanceDay (A3 Rebalance Completion)", () => {
    beforeEach(() => vi.clearAllMocks())

    it("persists allocations and syncs rebalancedVersion = planVersion in the same transaction", async () => {
        prismaMock.dailyPlan.findUnique.mockResolvedValue({
            availableMinutes: 240,
            planVersion: 4,
            rebalancedVersion: 3,
        })
        prismaMock.task.findMany.mockResolvedValue([
            {
                id: 7,
                status: "TODO",
                estimatedTime: 60,
                score: 80,
                priority: "HIGH",
                allocatedMinutes: null,
            },
        ])

        const out = await rebalanceDay(USER_ID, DAY_KEY)

        // ظرفیت کافی است → تخصیص = تخمین (60)
        expect(prismaMock.task.update).toHaveBeenCalledWith({
            where: { id: 7 },
            data: { allocatedMinutes: 60 },
        })
        // §6.3.2: rebalancedVersion در همان transaction ذخیره‌ی تخصیص‌ها sync می‌شود
        expect(prismaMock.dailyPlan.update).toHaveBeenCalledWith({
            ...wherePlan,
            data: { rebalancedVersion: 4 },
        })
        expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
        expect(out.dayKey).toBe(DAY_KEY)
    })

    it("syncs rebalancedVersion even with zero budget (nothing to distribute)", async () => {
        prismaMock.dailyPlan.findUnique.mockResolvedValue({
            availableMinutes: 0,
            planVersion: 2,
            rebalancedVersion: null,
        })
        prismaMock.task.findMany.mockResolvedValue([
            {
                id: 7,
                status: "TODO",
                estimatedTime: 60,
                score: 80,
                priority: "HIGH",
                allocatedMinutes: null,
            },
        ])

        const out = await rebalanceDay(USER_ID, DAY_KEY)

        expect(prismaMock.dailyPlan.update).toHaveBeenCalledWith({
            ...wherePlan,
            data: { rebalancedVersion: 2 },
        })
        expect(prismaMock.task.update).not.toHaveBeenCalled()
        expect(out.availableMinutes).toBe(0)
    })

    it("does not write anything when no plan exists", async () => {
        prismaMock.dailyPlan.findUnique.mockResolvedValue(null)
        prismaMock.task.findMany.mockResolvedValue([])

        const out = await rebalanceDay(USER_ID, DAY_KEY)

        expect(out.availableMinutes).toBe(0)
        expect(prismaMock.task.update).not.toHaveBeenCalled()
        expect(prismaMock.dailyPlan.update).not.toHaveBeenCalled()
    })
})