import { describe, expect, it } from "vitest"

/* ------------------------------------------------------------------ */
/* Phase 4.3 — buildPlanProposalView (pure)                            */
/* پوشش منطق رندر مودال بدون DOM (زیرساخت تست repo فقط pure-logic است). */
/* ------------------------------------------------------------------ */

import { buildPlanProposalView, priorityLabel } from "./planProposalView"
import type { PlanProposal } from "@/app/lib/planner/planProposalFlow"
import type { TaskItem } from "./taskTypes"

const DAY = "2026-09-27"

const task = (id: number, overrides: Partial<TaskItem> = {}): TaskItem => ({
    id,
    title: `کار ${id}`,
    category: null,
    priority: "MEDIUM",
    score: 50,
    reason: null,
    status: "TODO",
    dayKey: DAY,
    estimatedTime: null,
    allocatedMinutes: null,
    spentMinutes: null,
    completedOn: null,
    reminderAt: null,
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
    ...overrides,
})

const proposal = (overrides: Partial<PlanProposal> = {}): PlanProposal => ({
    basis: {
        dayKey: DAY,
        planVersion: 5,
        rebalancedVersion: 5,
        availableMinutes: 120,
        taskCount: 3,
        state: "fresh",
    },
    planned: [
        {
            taskId: 1,
            estimatedMinutes: 40,
            suggestedMinutes: 35,
            order: 1,
            aiOrder: 2,
            priority: "HIGH",
            score: 80,
            weight: 100,
            partial: false,
        },
        {
            taskId: 2,
            estimatedMinutes: 30,
            suggestedMinutes: 15,
            order: 2,
            aiOrder: 1,
            priority: "MEDIUM",
            score: 50,
            weight: 60,
            partial: true,
        },
    ],
    unfitted: [{ taskId: 3, estimatedMinutes: 90, weight: 120, aiOrder: 3, priority: "LOW", score: 20 }],
    plannedMinutes: 50,
    remainingMinutes: 70,
    aiUnscheduledTaskIds: [],
    source: "1xai",
    ...overrides,
})

describe("buildPlanProposalView — capacity summary (Test 11)", () => {
    it("uses proposal values directly without recalculating", () => {
        // مقادیر عمداً با جمع‌های سادهٔ frontend فرق دارند؛ باید عیناً از proposal بیایند
        const view = buildPlanProposalView(proposal({ plannedMinutes: 999, remainingMinutes: 7 }), [])
        expect(view.summary.availableMinutes).toBe(120)
        expect(view.summary.plannedMinutes).toBe(999)
        expect(view.summary.remainingMinutes).toBe(7)
        expect(view.summary.plannedCount).toBe(2)
        expect(view.summary.unfittedCount).toBe(1)
        expect(view.summary.taskCount).toBe(3)
    })
})

describe("buildPlanProposalView — planned tasks (Test 9)", () => {
    it("renders planned tasks in proposal order with resolved titles", () => {
        const view = buildPlanProposalView(proposal(), [task(1, { title: "گزارش" }), task(2, { title: "خرید" })])

        expect(view.planned.map((r) => r.taskId)).toEqual([1, 2])
        expect(view.planned[0]).toMatchObject({
            title: "گزارش",
            titleResolved: true,
            estimatedMinutes: 40,
            suggestedMinutes: 35,
            order: 1,
            aiOrder: 2, // advisory، جدا از order
            priority: "HIGH",
            score: 80,
            partial: false,
        })
        expect(view.planned[1]).toMatchObject({ partial: true, suggestedMinutes: 15 })
    })
})

describe("buildPlanProposalView — unfitted tasks (Test 10)", () => {
    it("renders unfitted tasks with score/priority", () => {
        const view = buildPlanProposalView(proposal(), [task(3, { title: "تمرین زبان" })])

        expect(view.unfitted).toHaveLength(1)
        expect(view.unfitted[0]).toMatchObject({
            taskId: 3,
            title: "تمرین زبان",
            titleResolved: true,
            estimatedMinutes: 90,
            priority: "LOW",
            score: 20,
            order: null,
            suggestedMinutes: null,
        })
    })
})

describe("buildPlanProposalView — missing task references", () => {
    it("falls back safely and reports missing ids without mutating the proposal", () => {
        const p = proposal()
        const snapshot = JSON.stringify(p)

        const view = buildPlanProposalView(p, [task(1)]) // task 2 و 3 در UI نیستند

        expect(view.planned[1].titleResolved).toBe(false)
        expect(view.unfitted[0].titleResolved).toBe(false)
        expect(view.missingTaskIds.sort()).toEqual([2, 3])
        expect(view.planned[1].title).toContain("۲")
        // proposal خودش دست‌نخورده
        expect(JSON.stringify(p)).toBe(snapshot)
    })
})

describe("priorityLabel", () => {
    it("labels priorities and the null case", () => {
        expect(priorityLabel("HIGH")).toBe("بالا")
        expect(priorityLabel("LOW")).toBe("کم")
        expect(priorityLabel(null)).toBe("بدون اولویت")
    })
})
