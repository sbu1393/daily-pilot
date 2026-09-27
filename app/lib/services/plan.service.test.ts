import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* Phase 2 — plan.service: mappers + read-only context loading         */
/* prisma mocked: no DB.                                               */
/* ------------------------------------------------------------------ */

const { prismaMock } = vi.hoisted(() => ({
    prismaMock: {
        dailyPlan: { findUnique: vi.fn() },
        task: { findMany: vi.fn() },
    },
}))

vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: () => prismaMock }))

import {
    buildPlanInput,
    getPlanGenerationContext,
    toPlanTaskInput,
    toSuggestionTaskInput,
    type PlanGenerationTask,
} from "./plan.service"
import { DayPlanNotSetError, NoPlannableTasksError } from "./errors"

const USER_ID = 7
const DAY_KEY = "2026-09-27"

const task = (overrides: Partial<PlanGenerationTask> = {}): PlanGenerationTask => ({
    id: 1,
    title: "گزارش فروش",
    category: "Work",
    estimatedTime: 45,
    score: 80,
    priority: "HIGH",
    status: "TODO",
    allocatedMinutes: 30,
    ...overrides,
})

describe("plan.service — mappers", () => {
    it("maps a Task to the AI input shape (existing* fields)", () => {
        expect(toPlanTaskInput(task())).toEqual({
            taskId: 1,
            title: "گزارش فروش",
            category: "Work",
            existingEstimatedMinutes: 45,
            existingScore: 80,
            existingPriority: "HIGH",
        })
    })

    it("maps a Task to the canonical engine input shape", () => {
        expect(toSuggestionTaskInput(task())).toEqual({
            id: 1,
            estimatedTime: 45,
            score: 80,
            priority: "HIGH",
            status: "TODO",
            allocatedMinutes: 30,
        })
    })

    it("builds a PlanInput from the full open task set", () => {
        const input = buildPlanInput(DAY_KEY, 120, [task(), task({ id: 2, title: "خرید" })])
        expect(input.dayKey).toBe(DAY_KEY)
        expect(input.availableMinutes).toBe(120)
        expect(input.tasks.map((t) => t.taskId)).toEqual([1, 2])
    })
})

describe("getPlanGenerationContext — read-only + ownership", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it("throws DayPlanNotSetError when no DailyPlan exists", async () => {
        prismaMock.dailyPlan.findUnique.mockResolvedValue(null)

        await expect(getPlanGenerationContext(USER_ID, DAY_KEY)).rejects.toBeInstanceOf(
            DayPlanNotSetError,
        )
        expect(prismaMock.task.findMany).not.toHaveBeenCalled()
    })

    it("throws DayPlanNotSetError when the plan has no usable capacity", async () => {
        prismaMock.dailyPlan.findUnique.mockResolvedValue({
            availableMinutes: 0,
            planVersion: 1,
            rebalancedVersion: null,
        })

        await expect(getPlanGenerationContext(USER_ID, DAY_KEY)).rejects.toBeInstanceOf(
            DayPlanNotSetError,
        )
    })

    it("throws NoPlannableTasksError when there are no open tasks", async () => {
        prismaMock.dailyPlan.findUnique.mockResolvedValue({
            availableMinutes: 120,
            planVersion: 1,
            rebalancedVersion: null,
        })
        prismaMock.task.findMany.mockResolvedValue([])

        await expect(getPlanGenerationContext(USER_ID, DAY_KEY)).rejects.toBeInstanceOf(
            NoPlannableTasksError,
        )
    })

    it("returns version/capacity/input for a valid day, scoped to the user and open tasks only", async () => {
        prismaMock.dailyPlan.findUnique.mockResolvedValue({
            availableMinutes: 120,
            planVersion: 4,
            rebalancedVersion: 2,
        })
        prismaMock.task.findMany.mockResolvedValue([task(), task({ id: 2 })])

        const ctx = await getPlanGenerationContext(USER_ID, DAY_KEY)

        expect(ctx.planVersion).toBe(4)
        expect(ctx.rebalancedVersion).toBe(2)
        expect(ctx.availableMinutes).toBe(120)
        expect(ctx.input.tasks.map((t) => t.taskId)).toEqual([1, 2])
        expect(ctx.suggestionTasks.map((t) => t.id)).toEqual([1, 2])

        expect(prismaMock.dailyPlan.findUnique).toHaveBeenCalledWith({
            where: { userId_dayKey: { userId: USER_ID, dayKey: DAY_KEY } },
            select: { availableMinutes: true, planVersion: true, rebalancedVersion: true },
        })

        const taskArgs = prismaMock.task.findMany.mock.calls[0][0]
        expect(taskArgs.where).toEqual({ userId: USER_ID, dayKey: DAY_KEY, status: { not: "DONE" } })
        // read-only: هیچ update/delete ای روی prisma انجام نمی‌شود (فقط دو read)
        expect(prismaMock.dailyPlan.findUnique).toHaveBeenCalledTimes(1)
        expect(prismaMock.task.findMany).toHaveBeenCalledTimes(1)
    })
})
