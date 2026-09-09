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

import {
    distribute,
    ensureDayRebalanced,
    estimateOf,
    markDayStale,
    rebalanceDay,
    weightOf,
} from "./rebalance"

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

    it("C4.1 — protects the IN_PROGRESS allocation and distributes only the remainder", async () => {
        prismaMock.dailyPlan.findUnique.mockResolvedValue({
            availableMinutes: 120,
            planVersion: 7,
            rebalancedVersion: 5,
        })
        prismaMock.task.findMany.mockResolvedValue([
            {
                id: 10,
                status: "IN_PROGRESS",
                estimatedTime: 60,
                score: 90,
                allocatedMinutes: 50, // سهم محافظتشده
            },
            {
                id: 11,
                status: "TODO",
                estimatedTime: 60,
                score: 80,
                allocatedMinutes: null,
            },
        ])

        const out = await rebalanceDay(USER_ID, DAY_KEY)

        // TODO با بودجه‌ی باقیمانده (120 − 50 = 70) تخصیص می‌گیرد؛ سقفش 60 است
        expect(prismaMock.task.update).toHaveBeenCalledTimes(1)
        expect(prismaMock.task.update).toHaveBeenCalledWith({
            where: { id: 11 },
            data: { allocatedMinutes: 60 },
        })
        // IN_PROGRESS دست نمی‌خورد و سهمش در خروجی ثابت می‌ماند
        const allocations = Object.fromEntries(
            out.allocations.map((a) => [a.taskId, a.allocatedMinutes]),
        )
        expect(allocations[10]).toBe(50)
        expect(allocations[11]).toBe(60)
    })
})

describe("C4.1 — estimateOf (clamping rules)", () => {
    it("defaults a missing estimate to 30", () => {
        expect(estimateOf({ estimatedTime: null })).toBe(30)
    })

    it("clamps to the 5..480 range", () => {
        expect(estimateOf({ estimatedTime: 3 })).toBe(5)
        expect(estimateOf({ estimatedTime: 999 })).toBe(480)
        expect(estimateOf({ estimatedTime: 90 })).toBe(90)
    })
})

describe("C4.1 — weightOf (§5.6.1: w = estimatedTime × (0.5 + score/200))", () => {
    it("matches the architecture document examples exactly", () => {
        // مثال سند: 120 × (0.5 + 90/200) = 114 و 60 × (0.5 + 50/200) = 45
        expect(weightOf({ id: 1, estimatedTime: 120, score: 90, priority: "HIGH", status: "TODO" })).toBe(114)
        expect(weightOf({ id: 2, estimatedTime: 60, score: 50, priority: "MEDIUM", status: "TODO" })).toBe(45)
    })

    it("defaults a missing score to 50", () => {
        expect(weightOf({ id: 3, estimatedTime: 60, score: null, priority: null, status: "TODO" })).toBe(45)
    })

    it("clamps the score into 0..100", () => {
        const base = { estimatedTime: 60, priority: "HIGH" as const, status: "TODO" as const }
        expect(weightOf({ ...base, id: 4, score: 150 })).toBe(60) // 60 × (0.5 + 100/200)
        expect(weightOf({ ...base, id: 5, score: -10 })).toBe(30) // 60 × 0.5
    })

    it("orders correctly: higher score or larger estimate → larger weight", () => {
        const mk = (id: number, estimatedTime: number, score: number) =>
            ({ id, estimatedTime, score, priority: "HIGH", status: "TODO" }) as const
        expect(weightOf(mk(1, 60, 90))).toBeGreaterThan(weightOf(mk(2, 60, 40)))
        expect(weightOf(mk(3, 120, 50))).toBeGreaterThan(weightOf(mk(4, 60, 50)))
    })
})

describe("C4.1 — distribute (capacity fitting)", () => {
    it("gives every task its full estimate and returns the remainder as pool when capacity suffices", () => {
        const items = [
            { id: 1, weight: 114, cap: 120 },
            { id: 2, weight: 45, cap: 60 },
        ]

        const out = distribute(300, items)

        expect(out.allocations).toEqual({ 1: 120, 2: 60 })
        expect(out.dropped).toEqual([])
        expect(out.pool).toBe(120)
    })

    it("caps a high-weight task at its estimate and gives the leftover to the next task", () => {
        // A: w=114, B: w=45 — بودجه 100 → A سقف 60، باقیمانده 40 برای B
        const items = [
            { id: 1, weight: 114, cap: 60 },
            { id: 2, weight: 45, cap: 60 },
        ]

        const out = distribute(100, items)

        expect(out.allocations[1]).toBe(60)
        expect(out.allocations[2]).toBe(40)
        expect(out.dropped).toEqual([])
        expect(out.pool).toBe(0)
    })
})

describe("C4.1 — distribute (overflow → rollover candidates)", () => {
    it("drops a task whose share falls below the 15-minute floor and keeps it unallocated", () => {
        // بودجه 50: سهم B (w=45) حدود 14.1 < 15 → کنار گذاشته می‌شود؛ A (w=114) همه را می‌گیرد
        const items = [
            { id: 1, weight: 114, cap: 60 },
            { id: 2, weight: 45, cap: 60 },
        ]

        const out = distribute(50, items)

        expect(out.allocations[1]).toBe(50)
        expect(out.allocations[2]).toBe(0)
        expect(out.dropped).toEqual([2])
        expect(out.pool).toBe(0)
    })

    it("drops the lowest-weight task when several fall below the floor", () => {
        // قرینه‌ی تست قبل: این بار A کم‌وزن‌ترین است و باید حذف شود
        const items = [
            { id: 1, weight: 45, cap: 60 },
            { id: 2, weight: 114, cap: 60 },
        ]

        const out = distribute(50, items)

        expect(out.dropped).toEqual([1])
        expect(out.allocations[2]).toBe(50)
    })
})

describe("C4.1 — distribute (5-minute rounding)", () => {
    it("floors every final share to a multiple of 5 and returns the crumbs to the pool", () => {
        const out = distribute(73, [{ id: 1, weight: 100, cap: 200 }])

        expect(out.allocations[1]).toBe(70)
        expect(out.pool).toBe(3)
    })

    it("returns only multiples of 5 to allocations across the overbook path", () => {
        const out = distribute(137, [
            { id: 1, weight: 114, cap: 90 },
            { id: 2, weight: 45, cap: 90 },
        ])

        for (const minutes of Object.values(out.allocations)) {
            expect(minutes % 5).toBe(0)
        }
    })
})