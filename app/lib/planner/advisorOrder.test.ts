import { describe, expect, it } from "vitest"
import type { TaskItem } from "@/app/components/task/taskTypes"
import { orderTasksByAdvisor } from "./advisorOrder"

/* ------------------------------------------------------------------ */
/* advisorOrder — تست‌های منطقِ PURE ترتیب نمایش (Phase 1)               */
/* بدون DB/AI/شبکه — فقط ترتیب و immutability                          */
/* ------------------------------------------------------------------ */

const DAY = "2026-09-13"

const task = (id: number, overrides: Partial<TaskItem> = {}): TaskItem => ({
    id,
    title: `کار ${id}`,
    category: null,
    priority: null,
    score: null,
    reason: null,
    status: "TODO",
    dayKey: DAY,
    estimatedTime: null,
    allocatedMinutes: null,
    spentMinutes: null,
    completedOn: null,
    reminderAt: null,
    createdAt: `${DAY}T00:00:00.000Z`,
    updatedAt: `${DAY}T00:00:00.000Z`,
    ...overrides,
})

const ids = (tasks: TaskItem[]) => tasks.map((t) => t.id)

describe("orderTasksByAdvisor — planned tasks", () => {
    it("returns an empty array for an empty task list", () => {
        expect(orderTasksByAdvisor([], [])).toEqual([])
        expect(orderTasksByAdvisor([], [1, 2])).toEqual([])
    })

    it("orders tasks exactly according to plannedTaskIds", () => {
        const tasks = [task(1), task(2), task(3), task(4)]

        const result = orderTasksByAdvisor(tasks, [3, 1])

        expect(ids(result)).toEqual([3, 1, 2, 4])
    })

    it("keeps the original relative order of tasks that are not planned", () => {
        const tasks = [task(10), task(20), task(30), task(40)]

        const result = orderTasksByAdvisor(tasks, [30])

        expect(ids(result)).toEqual([30, 10, 20, 40])
    })

    it("returns every task even when plannedTaskIds is empty", () => {
        const tasks = [task(5), task(6)]

        expect(ids(orderTasksByAdvisor(tasks, []))).toEqual([5, 6])
    })

    it("ignores unknown and duplicated ids in plannedTaskIds", () => {
        const tasks = [task(1), task(2)]

        const result = orderTasksByAdvisor(tasks, [99, 2, 2, 1])

        // ۹۹ ناشناخته است؛ ۲ تکراری است و فقط یک‌بار می‌آید
        expect(ids(result)).toEqual([2, 1])
    })

    it("supports IN_PROGRESS tasks being planned before TODO tasks", () => {
        const tasks = [task(1, { status: "TODO" }), task(2, { status: "IN_PROGRESS" })]

        expect(ids(orderTasksByAdvisor(tasks, [2]))).toEqual([2, 1])
    })
})

describe("orderTasksByAdvisor — DONE tasks", () => {
    it("pushes DONE tasks to the bottom even when they are in plannedTaskIds", () => {
        const tasks = [
            task(1, { status: "DONE" }),
            task(2, { status: "TODO" }),
            task(3, { status: "IN_PROGRESS" }),
        ]

        const result = orderTasksByAdvisor(tasks, [1, 3])

        // کار ۱ با اینکه در plannedTaskIds است، چون DONE است آخر می‌رود
        expect(ids(result)).toEqual([3, 2, 1])
    })

    it("keeps the original relative order among DONE tasks", () => {
        const tasks = [
            task(1, { status: "DONE" }),
            task(2, { status: "TODO" }),
            task(3, { status: "DONE" }),
        ]

        expect(ids(orderTasksByAdvisor(tasks, [2]))).toEqual([2, 1, 3])
    })

    it("handles a list where every task is DONE", () => {
        const tasks = [task(1, { status: "DONE" }), task(2, { status: "DONE" })]

        expect(ids(orderTasksByAdvisor(tasks, [2, 1]))).toEqual([1, 2])
    })
})

describe("orderTasksByAdvisor — purity", () => {
    it("never mutates the input array or its order", () => {
        const tasks = [task(2), task(1, { status: "DONE" }), task(3)]
        const before = ids(tasks)
        const snapshot = JSON.stringify(tasks)

        orderTasksByAdvisor(tasks, [3, 2, 1])

        expect(ids(tasks)).toEqual(before)
        expect(JSON.stringify(tasks)).toBe(snapshot)
    })

    it("never mutates the plannedTaskIds array", () => {
        const planned = [3, 1]

        orderTasksByAdvisor([task(1), task(2), task(3)], planned)

        expect(planned).toEqual([3, 1])
    })

    it("always returns a new array reference", () => {
        const tasks = [task(1)]

        const result = orderTasksByAdvisor(tasks, [])

        expect(result).not.toBe(tasks)
        expect(result).toEqual(tasks)
    })
})
