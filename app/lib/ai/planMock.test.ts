import { describe, expect, it } from "vitest"

/* ------------------------------------------------------------------ */
/* Phase 1 — AI Daily Plan: mockBatchPlan (deterministic contract)     */
/* ------------------------------------------------------------------ */

import { mockBatchPlan } from "./planMock"
import type { PlanInput } from "./planContract"
import { aiBatchPlanSchema } from "./planSchema"
import { buildPlanProposal } from "@/app/lib/planner/planProposal"
import { planApplyRequestSchema } from "@/app/schema/plannerSchema"
import type { SuggestionTaskInput } from "@/app/lib/planner/suggestion"

const input = (titles: string[]): PlanInput => ({
    dayKey: "2026-09-27",
    availableMinutes: 300,
    tasks: titles.map((title, index) => ({ taskId: index + 1, title })),
})

describe("mockBatchPlan", () => {
    it("returns every valid task exactly once", () => {
        const plan = mockBatchPlan(input(["خرید نان", "گزارش پروژه", "تماس با مشتری"]))
        expect(plan.items.map((i) => i.taskId).sort((a, b) => a - b)).toEqual([1, 2, 3])
        expect(plan.unscheduledTaskIds).toBeUndefined()
    })

    it("produces schema-valid output with valid ranges", () => {
        const plan = mockBatchPlan(input(["فوری دکتر", "مطالعه کتاب"]))
        expect(aiBatchPlanSchema.safeParse(plan).success).toBe(true)
        for (const item of plan.items) {
            expect(item.estimatedMinutes).toBeGreaterThanOrEqual(5)
            expect(item.estimatedMinutes).toBeLessThanOrEqual(480)
            expect(item.score).toBeGreaterThanOrEqual(0)
            expect(item.score).toBeLessThanOrEqual(100)
            expect(["HIGH", "MEDIUM", "LOW"]).toContain(item.priority)
        }
    })

    it("assigns unique orders 1..n", () => {
        const plan = mockBatchPlan(input(["الف", "ب", "ج", "د"]))
        expect(plan.items.map((i) => i.order).sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
    })

    it("is deterministic: identical input → identical output", () => {
        const a = mockBatchPlan(input(["گزارش فوری پروژه", "خرید نان"]))
        const b = mockBatchPlan(input(["گزارش فوری پروژه", "خرید نان"]))
        expect(a).toEqual(b)
    })

    it("handles an empty task list without inventing items", () => {
        const plan = mockBatchPlan(input([]))
        expect(plan.items).toEqual([])
    })
})

/* ------------------------------------------------------------------ */
/* Mock → proposal → Apply parity                                      */
/*                                                                     */
/* The mock deliberately never emits unscheduledTaskIds (see planMock's */
/* header comment), so it cannot reproduce the production overlap bug   */
/* on its own. What it CAN prove — cheaply — is that the mock path      */
/* still produces a proposal the canonical schema accepts, so CI keeps  */
/* the producer/consumer contract closed for every source.              */
/* ------------------------------------------------------------------ */
describe("mockBatchPlan — feeds a proposal that Apply accepts", () => {
    const suggestionTasks: SuggestionTaskInput[] = [1, 2, 3, 4].map((id) => ({
        id,
        estimatedTime: null,
        score: null,
        priority: null,
        status: "TODO",
        allocatedMinutes: null,
    }))

    it("produces an Apply-valid proposal for a capacity-constrained day", () => {
        // ظرفیت کم عمداً است تا موتور مجبور به ساختن unfitted شود
        const planInput = input(["الف", "ب", "ج", "د"])
        const proposal = buildPlanProposal({
            dayKey: planInput.dayKey,
            planVersion: 1,
            rebalancedVersion: 1,
            availableMinutes: 40,
            source: "mock",
            ai: mockBatchPlan(planInput),
            tasks: suggestionTasks,
        })

        expect(planApplyRequestSchema.safeParse({
            dayKey: proposal.basis.dayKey,
            expectedPlanVersion: proposal.basis.planVersion,
            proposal,
        }).success).toBe(true)
    })

    it("produces an Apply-valid proposal when everything fits", () => {
        const planInput = input(["الف", "ب"])
        const proposal = buildPlanProposal({
            dayKey: planInput.dayKey,
            planVersion: 1,
            rebalancedVersion: 1,
            availableMinutes: 600,
            source: "mock",
            ai: mockBatchPlan(planInput),
            tasks: suggestionTasks.slice(0, 2),
        })

        expect(planApplyRequestSchema.safeParse({
            dayKey: proposal.basis.dayKey,
            expectedPlanVersion: proposal.basis.planVersion,
            proposal,
        }).success).toBe(true)
    })
})
