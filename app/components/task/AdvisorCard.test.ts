import { describe, expect, it } from "vitest"
import { buildAdvisorCardView } from "./AdvisorCard"
import { buildAdvisor, type AdvisorTaskInput } from "@/app/lib/planner/advisor"
import { type TaskItem } from "./taskTypes"

/* ------------------------------------------------------------------ */
/* AdvisorCard (Part 3/3) — تست ویومدل خالص کارت مشاور.                 */
/* محیط node بدون DOM/jsdom (قانون بدون وابستگی جدید) — همان الگوی       */
/* SettingsContext.test.ts: منطقِ نمایش pure استخراج و تست می‌شود.        */
/* ------------------------------------------------------------------ */

const advisorTask = (
    id: number,
    overrides: Partial<AdvisorTaskInput> = {},
): AdvisorTaskInput => ({
    id,
    title: `کار ${id}`,
    status: "TODO",
    priority: null,
    score: null,
    estimatedTime: 30,
    allocatedMinutes: null,
    ...overrides,
})

const taskItem = (id: number, overrides: Partial<TaskItem> = {}): TaskItem => ({
    id,
    title: `کار ${id}`,
    category: null,
    priority: null,
    score: null,
    reason: null,
    status: "TODO",
    dayKey: "2026-01-01",
    estimatedTime: 30,
    allocatedMinutes: null,
    spentMinutes: null,
    completedOn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
})

describe("buildAdvisorCardView — fallbacks", () => {
    it("returns hidden when advisor is null or undefined", () => {
        expect(buildAdvisorCardView(null, [taskItem(1)])).toEqual({ kind: "hidden" })
        expect(buildAdvisorCardView(undefined, [taskItem(1)])).toEqual({ kind: "hidden" })
    })

    it("returns hidden when the task list is empty", () => {
        const advisor = buildAdvisor([advisorTask(1)], {
            displayName: "مهدی",
            availableMinutes: null,
        })
        expect(buildAdvisorCardView(advisor, [])).toEqual({ kind: "hidden" })
    })

    it("returns hidden when nextTaskId points at a task missing from the list (defensive)", () => {
        const advisor = buildAdvisor([advisorTask(1)], {
            displayName: "مهدی",
            availableMinutes: null,
        })
        // لیست شامل کارِ بعدی نیست → کارت محتوای ناقص نشان نمی‌دهد
        expect(buildAdvisorCardView(advisor, [taskItem(999)])).toEqual({ kind: "hidden" })
    })

    it("returns the all-done state with the advisor's own message when every task is DONE", () => {
        const advisor = buildAdvisor(
            [advisorTask(1, { status: "DONE" }), advisorTask(2, { status: "DONE" })],
            { displayName: "مهدی", availableMinutes: null },
        )
        const view = buildAdvisorCardView(advisor, [
            taskItem(1, { status: "DONE" }),
            taskItem(2, { status: "DONE" }),
        ])

        expect(view.kind).toBe("allDone")
        if (view.kind === "allDone") {
            expect(view.message).toContain("همه‌ی کارها انجام شده")
        }
    })
})

describe("buildAdvisorCardView — ready state", () => {
    it("maps the next task with emoji, estimate and focus/pace insight", () => {
        const advisor = buildAdvisor(
            [
                advisorTask(1, { priority: "HIGH", estimatedTime: 120, title: "پروژه دانشگاه" }),
                advisorTask(2, { priority: "LOW", estimatedTime: 15 }),
            ],
            { displayName: "مهدی", availableMinutes: null },
        )
        const view = buildAdvisorCardView(advisor, [
            taskItem(1, { title: "پروژه دانشگاه", priority: "HIGH", estimatedTime: 120 }),
            taskItem(2, { priority: "LOW", estimatedTime: 15 }),
        ])

        expect(view.kind).toBe("ready")
        if (view.kind !== "ready") return

        // HIGH اول — همان ترتیب موتور
        expect(view.next.taskId).toBe(1)
        expect(view.next.title).toBe("پروژه دانشگاه")
        expect(view.next.emoji).toBe("🔴")
        expect(view.next.estimatedMinutes).toBe(120)
        expect(view.next.focusMinutes).toBe(90) // clamp بالا
        expect(view.next.pauseAfterMinutes).toBe(120) // clamp بالا
        expect(view.next.reason).toBe("اولویت بالا")
        expect(view.greeting).toBe("مهدی جان، پیشنهاد من اینه که با تسک «پروژه دانشگاه» شروع کنی.")
        expect(view.focusNote).toContain("تمرکز")
        expect(view.focusNote).toContain("استراحت")
    })

    it("uses the neutral emoji for a task without priority", () => {
        const advisor = buildAdvisor([advisorTask(1, { priority: null })], {
            displayName: "مهدی",
            availableMinutes: null,
        })
        const view = buildAdvisorCardView(advisor, [taskItem(1, { priority: null })])

        expect(view.kind).toBe("ready")
        if (view.kind === "ready") {
            expect(view.next.emoji).toBe("⚪")
        }
    })
})
