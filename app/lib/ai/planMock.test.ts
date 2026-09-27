import { describe, expect, it } from "vitest"

/* ------------------------------------------------------------------ */
/* Phase 1 — AI Daily Plan: mockBatchPlan (deterministic contract)     */
/* ------------------------------------------------------------------ */

import { mockBatchPlan } from "./planMock"
import type { PlanInput } from "./planContract"
import { aiBatchPlanSchema } from "./planSchema"

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
