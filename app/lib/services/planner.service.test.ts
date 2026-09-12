import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* C4 — ADR-03 lazy wiring در سطح service (planner.service.ts)         */
/* Read path: getDaySummary → اول ensureDayRebalanced، بعد summary.    */
/* Mutation path: setDayPlan → فقط upsert/bump؛ هرگز rebalance نمی‌زند. */
/* §6.3.3: create → planVersion از 1؛ update → increment اتمیک.        */
/* ------------------------------------------------------------------ */

const { prismaMock, ensureDayRebalancedMock, suggestDayMock } = vi.hoisted(() => ({
    prismaMock: {
        dailyPlan: {
            upsert: vi.fn(),
            findUnique: vi.fn(),
        },
        task: {
            findMany: vi.fn(),
        },
    },
    ensureDayRebalancedMock: vi.fn(),
    suggestDayMock: vi.fn(),
}))

vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: () => prismaMock }))
vi.mock("@/app/lib/planner/rebalance", () => ({
    ensureDayRebalanced: ensureDayRebalancedMock,
}))
vi.mock("@/app/lib/planner/suggestion", () => ({ suggestDay: suggestDayMock }))

import { getDaySuggestion, getDaySummary, setDayPlan } from "./planner.service"

const USER_ID = 1
const DAY_KEY = "2026-03-05"

describe("getDaySummary (read path — ADR-03)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        ensureDayRebalancedMock.mockResolvedValue(null)
        prismaMock.dailyPlan.findUnique.mockResolvedValue(null)
        prismaMock.task.findMany.mockResolvedValue([])
    })

    it("invokes the lazy trigger before computing the summary", async () => {
        await getDaySummary(USER_ID, DAY_KEY)

        expect(ensureDayRebalancedMock).toHaveBeenCalledWith(USER_ID, DAY_KEY)
    })
})

describe("setDayPlan (mutation — no eager rebalance)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it("upserts the plan and never calls the rebalance engine", async () => {
        prismaMock.dailyPlan.upsert.mockResolvedValue({
            userId: USER_ID,
            dayKey: DAY_KEY,
            availableMinutes: 180,
            planVersion: 3,
        })

        await setDayPlan(USER_ID, DAY_KEY, 180)

        expect(ensureDayRebalancedMock).not.toHaveBeenCalled()
    })

    it("creates the plan with planVersion starting at 1 (§6.3.3 creation path 1)", async () => {
        prismaMock.dailyPlan.upsert.mockResolvedValue({
            userId: USER_ID,
            dayKey: DAY_KEY,
            availableMinutes: 180,
            planVersion: 1,
            rebalancedVersion: null,
        })

        await setDayPlan(USER_ID, DAY_KEY, 180)

        expect(prismaMock.dailyPlan.upsert).toHaveBeenCalledWith({
            where: { userId_dayKey: { userId: USER_ID, dayKey: DAY_KEY } },
            create: { userId: USER_ID, dayKey: DAY_KEY, availableMinutes: 180, planVersion: 1 },
            update: { availableMinutes: 180, planVersion: { increment: 1 } },
        })
    })

    it("updates an existing plan with an atomic planVersion increment (§6.3.2)", async () => {
        prismaMock.dailyPlan.upsert.mockResolvedValue({
            userId: USER_ID,
            dayKey: DAY_KEY,
            availableMinutes: 240,
            planVersion: 4,
        })

        await setDayPlan(USER_ID, DAY_KEY, 240)

        const args = prismaMock.dailyPlan.upsert.mock.calls[0][0]
        expect(args.update).toEqual({
            availableMinutes: 240,
            planVersion: { increment: 1 },
        })
    })
})

/* ------------------------------------------------------------------ */
/* A1 Phase 1 — getDaySuggestion: مبنای محاسبه (basis) + وضعیت (state) */
/* ------------------------------------------------------------------ */

describe("getDaySuggestion (ADR-006 / A1 Phase 1 — basis + state)", () => {
    const TASKS = [
        {
            id: 1,
            estimatedTime: 30,
            score: 50,
            priority: null,
            status: "TODO",
            allocatedMinutes: null,
        },
    ]

    const EMPTY_SUGGESTION = {
        capacityMinutes: 120,
        planned: [],
        unfitted: [],
        plannedMinutes: 0,
        remainingMinutes: 120,
        usedDefaultEstimate: [],
        protectedTaskIds: [],
    }

    beforeEach(() => {
        vi.clearAllMocks()
        ensureDayRebalancedMock.mockResolvedValue(null)
        suggestDayMock.mockReturnValue(EMPTY_SUGGESTION)
        prismaMock.task.findMany.mockResolvedValue(TASKS)
    })

    it("triggers the lazy rebalance, then reports fresh basis when rebalancedVersion == planVersion", async () => {
        prismaMock.dailyPlan.findUnique.mockResolvedValue({
            availableMinutes: 120,
            planVersion: 2,
            rebalancedVersion: 2,
        })

        const result = await getDaySuggestion(USER_ID, DAY_KEY)

        expect(ensureDayRebalancedMock).toHaveBeenCalledWith(USER_ID, DAY_KEY)
        expect(result.dayKey).toBe(DAY_KEY)
        expect(result.state).toBe("fresh")
        expect(result.basis).toEqual({
            planVersion: 2,
            rebalancedVersion: 2,
            availableMinutes: 120,
            taskCount: 1,
        })
        expect(suggestDayMock).toHaveBeenCalledWith(120, TASKS)
    })

    it("reports stale with a zero basis when the day has no DailyPlan row (§6.3.3)", async () => {
        prismaMock.dailyPlan.findUnique.mockResolvedValue(null)

        const result = await getDaySuggestion(USER_ID, DAY_KEY)

        expect(result.state).toBe("stale")
        expect(result.basis).toEqual({
            planVersion: 0,
            rebalancedVersion: null,
            availableMinutes: 0,
            taskCount: 1,
        })
        expect(suggestDayMock).toHaveBeenCalledWith(0, TASKS)
    })

    it("reports stale when planVersion is ahead of rebalancedVersion (§6.3.2)", async () => {
        prismaMock.dailyPlan.findUnique.mockResolvedValue({
            availableMinutes: 240,
            planVersion: 5,
            rebalancedVersion: 3,
        })

        const result = await getDaySuggestion(USER_ID, DAY_KEY)

        expect(result.state).toBe("stale")
        expect(result.basis.planVersion).toBe(5)
        expect(result.basis.rebalancedVersion).toBe(3)
        expect(result.basis.availableMinutes).toBe(240)
    })

    it("reports stale when rebalancedVersion is null (plan never rebalanced)", async () => {
        prismaMock.dailyPlan.findUnique.mockResolvedValue({
            availableMinutes: 120,
            planVersion: 1,
            rebalancedVersion: null,
        })

        const result = await getDaySuggestion(USER_ID, DAY_KEY)

        expect(result.state).toBe("stale")
    })

    it("selects allocatedMinutes so feature parity with rebalanceDay is possible", async () => {
        prismaMock.dailyPlan.findUnique.mockResolvedValue({
            availableMinutes: 60,
            planVersion: 1,
            rebalancedVersion: 1,
        })

        await getDaySuggestion(USER_ID, DAY_KEY)

        const args = prismaMock.task.findMany.mock.calls[0][0]
        expect(args.select.allocatedMinutes).toBe(true)
    })
})
