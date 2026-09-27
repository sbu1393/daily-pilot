import { describe, expect, it } from "vitest"

/* ------------------------------------------------------------------ */
/* Phase 1 — AI Daily Plan: validateBatchPlan (input-relative)         */
/* ------------------------------------------------------------------ */

import { validateBatchPlan, type AnalyzeBatchPlan } from "./planContract"
import type { AiBatchPlan } from "./planSchema"

const plan = (overrides: Partial<AiBatchPlan> = {}): AiBatchPlan => ({
    items: [
        { taskId: 1, estimatedMinutes: 30, score: 50, priority: "MEDIUM", order: 1 },
        { taskId: 2, estimatedMinutes: 45, score: 60, priority: "HIGH", order: 2 },
    ],
    ...overrides,
})

describe("validateBatchPlan — completeness vs input", () => {
    it("returns no issues when every input task appears exactly once", () => {
        expect(validateBatchPlan(plan(), [1, 2])).toEqual([])
    })

    it("accepts tasks split across items and unscheduledTaskIds", () => {
        const output = plan({
            items: [{ taskId: 1, estimatedMinutes: 30, score: 50, priority: "MEDIUM", order: 1 }],
            unscheduledTaskIds: [2],
        })
        expect(validateBatchPlan(output, [1, 2])).toEqual([])
    })

    it("flags an unknown taskId in items", () => {
        const output = plan({
            items: [{ taskId: 99, estimatedMinutes: 30, score: 50, priority: "MEDIUM", order: 1 }],
        })
        const issues = validateBatchPlan(output, [1])
        expect(issues).toContainEqual({ code: "UNKNOWN_TASK_ID", taskId: 99 })
        // تسک ۱ هیچ‌گاه در خروجی نیامده → تکمیل‌نبودن هم گزارش می‌شود
        expect(issues).toContainEqual({ code: "MISSING_TASK_ID", taskId: 1 })
    })

    it("flags an unknown taskId in unscheduledTaskIds", () => {
        const output = plan({ items: [
            { taskId: 1, estimatedMinutes: 30, score: 50, priority: "MEDIUM", order: 1 },
            { taskId: 2, estimatedMinutes: 30, score: 50, priority: "MEDIUM", order: 2 },
        ], unscheduledTaskIds: [42] })
        const issues = validateBatchPlan(output, [1, 2])
        expect(issues).toEqual([{ code: "UNKNOWN_TASK_ID", taskId: 42 }])
    })

    it("flags a missing input task (completeness)", () => {
        const output = plan({
            items: [{ taskId: 1, estimatedMinutes: 30, score: 50, priority: "MEDIUM", order: 1 }],
        })
        expect(validateBatchPlan(output, [1, 2])).toEqual([
            { code: "MISSING_TASK_ID", taskId: 2 },
        ])
    })
})

describe("AnalyzeBatchPlan contract", () => {
    it("is a callable async shape returning source + plan + attempts", async () => {
        const fake: AnalyzeBatchPlan = async () => ({
            source: "mock",
            plan: plan(),
            attempts: 1,
        })
        const result = await fake({ dayKey: "2026-09-27", availableMinutes: 120, tasks: [] })
        expect(result.source).toBe("mock")
        expect(result.plan.items).toHaveLength(2)
    })
})
