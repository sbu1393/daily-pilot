import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* C4 — ADR-03 lazy wiring در سطح service (planner.service.ts)         */
/* Read path: getDaySummary → اول ensureDayRebalanced، بعد summary.    */
/* Mutation path: setDayPlan → فقط upsert/bump؛ هرگز rebalance نمی‌زند. */
/* §6.3.3: create → planVersion از 1؛ update → increment اتمیک.        */
/* ------------------------------------------------------------------ */

const { prismaMock, ensureDayRebalancedMock } = vi.hoisted(() => ({
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
}))

vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: () => prismaMock }))
vi.mock("@/app/lib/planner/rebalance", () => ({
    ensureDayRebalanced: ensureDayRebalancedMock,
}))

import { getDaySummary, setDayPlan } from "./planner.service"

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
