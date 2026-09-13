import { describe, expect, it } from "vitest"
import { buildAdvisor, type AdvisorTaskInput } from "./advisor"

/* ------------------------------------------------------------------ */
/* Advisor — تست‌های منطقِ PURE (بدون DB/AI) — Part 1/3                 */
/* سناریوهای الزامی: ترتیب وضعیت/اولویت، clamp، nextTaskId، عدم mutate  */
/* ------------------------------------------------------------------ */

const task = (id: number, overrides: Partial<AdvisorTaskInput> = {}): AdvisorTaskInput => ({
    id,
    title: `کار ${id}`,
    status: "TODO",
    priority: null,
    score: null,
    estimatedTime: 30,
    allocatedMinutes: null,
    ...overrides,
})

describe("buildAdvisor — ordering", () => {
    it("puts IN_PROGRESS before TODO and DONE always last", () => {
        const result = buildAdvisor(
            [
                task(1, { status: "DONE" }),
                task(2, { status: "TODO" }),
                task(3, { status: "IN_PROGRESS" }),
            ],
            { displayName: "مهدی", availableMinutes: null },
        )

        expect(result.orderedTaskIds).toEqual([3, 2, 1])
        expect(result.items.map((i) => i.rank)).toEqual([1, 2, 3])
    })

    it("orders HIGH > MEDIUM > LOW > null within the same status", () => {
        const result = buildAdvisor(
            [
                task(1, { priority: null }),
                task(2, { priority: "LOW" }),
                task(3, { priority: "HIGH" }),
                task(4, { priority: "MEDIUM" }),
            ],
            { displayName: "مهدی", availableMinutes: null },
        )

        expect(result.orderedTaskIds).toEqual([3, 4, 2, 1])
    })

    it("breaks full ties by id ascending", () => {
        const result = buildAdvisor(
            [task(7), task(2), task(5)],
            { displayName: "مهدی", availableMinutes: null },
        )

        expect(result.orderedTaskIds).toEqual([2, 5, 7])
    })

    it("prefers higher score and then larger estimatedTime", () => {
        const result = buildAdvisor(
            [
                task(1, { score: 40, estimatedTime: 120 }),
                task(2, { score: 80, estimatedTime: 10 }),
                task(3, { score: 80, estimatedTime: 60 }),
            ],
            { displayName: "مهدی", availableMinutes: null },
        )

        expect(result.orderedTaskIds).toEqual([3, 2, 1])
    })
})

describe("buildAdvisor — clamping", () => {
    it("clamps focusMinutes into [25, 90]", () => {
        const result = buildAdvisor(
            [task(1, { estimatedTime: 5 }), task(2, { estimatedTime: 300 })],
            { displayName: "مهدی", availableMinutes: null },
        )

        const focus = new Map(result.items.map((i) => [i.taskId, i.focusMinutes]))
        expect(focus.get(1)).toBe(25) // ۵ → حد پایین
        expect(focus.get(2)).toBe(90) // ۳۰۰ → حد بالا
    })

    it("clamps pauseAfterMinutes into [60, 120] and clamps estimatedMinutes into [5, 480]", () => {
        const result = buildAdvisor(
            [task(1, { estimatedTime: 1 }), task(2, { estimatedTime: 1000 })],
            { displayName: "مهدی", availableMinutes: null },
        )

        const byId = new Map(result.items.map((i) => [i.taskId, i]))
        // ۱ دقیقه → تخمین امن ۵ → فوکوس ۲۵ → توقف ۵۵ → به ۶۰ بالا کشیده می‌شود
        expect(byId.get(1)?.estimatedMinutes).toBe(5)
        expect(byId.get(1)?.pauseAfterMinutes).toBe(60)
        // ۱۰۰۰ دقیقه → تخمین امن ۴۸۰ → فوکوس ۹۰ → توقف ۱۲۰
        expect(byId.get(2)?.estimatedMinutes).toBe(480)
        expect(byId.get(2)?.pauseAfterMinutes).toBe(120)
    })

    it("falls back to the 30-minute default estimate when estimatedTime is null", () => {
        const result = buildAdvisor([task(1, { estimatedTime: null })], {
            displayName: "مهدی",
            availableMinutes: null,
        })

        expect(result.items[0].estimatedMinutes).toBe(30)
        expect(result.items[0].focusMinutes).toBe(30)
        expect(result.items[0].pauseAfterMinutes).toBe(60)
    })
})

describe("buildAdvisor — nextTaskId", () => {
    it("ignores DONE tasks and picks the first non-DONE in order", () => {
        const result = buildAdvisor(
            [task(1, { status: "DONE", priority: "HIGH" }), task(2, { status: "TODO" })],
            { displayName: "مهدی", availableMinutes: null },
        )

        expect(result.nextTaskId).toBe(2)
    })

    it("returns null when every task is DONE or the list is empty", () => {
        const allDone = buildAdvisor([task(1, { status: "DONE" })], {
            displayName: "مهدی",
            availableMinutes: null,
        })
        const empty = buildAdvisor([], { displayName: "مهدی", availableMinutes: null })

        expect(allDone.nextTaskId).toBe(null)
        expect(empty.nextTaskId).toBe(null)
        expect(allDone.message).toContain("انجام شده")
        expect(empty.message).toContain("کاری برای پیشنهاد ندارم")
    })
})

describe("buildAdvisor — overflow", () => {
    it("marks tasks that no longer fit the remaining capacity, in order", () => {
        const result = buildAdvisor(
            [
                task(1, { estimatedTime: 60 }),
                task(2, { estimatedTime: 60 }),
                task(3, { estimatedTime: 30 }),
            ],
            { displayName: "مهدی", availableMinutes: 120 },
        )

        // ۶۰ + ۶۰ = ۱۲۰ پر می‌شود؛ کار ۳ (۳۰ دقیقه) دیگر جا نمی‌شود
        expect(result.overflowTaskIds).toEqual([3])
        expect(result.totalEstimatedMinutes).toBe(150)
    })

    it("reports no overflow when capacity is null and skips DONE tasks when counting", () => {
        const unconstrained = buildAdvisor([task(1, { estimatedTime: 600 })], {
            displayName: "مهدی",
            availableMinutes: null,
        })
        expect(unconstrained.overflowTaskIds).toEqual([])

        const withDone = buildAdvisor(
            [task(1, { status: "DONE", estimatedTime: 60 }), task(2, { estimatedTime: 120 })],
            { displayName: "مهدی", availableMinutes: 90 },
        )
        // DONE ظرفیت مصرف نمی‌کند؛ کار ۲ (۱۲۰ > ۹۰) سرریز است
        expect(withDone.overflowTaskIds).toEqual([2])
    })
})

describe("buildAdvisor — purity & message", () => {
    it("never mutates the input array", () => {
        const input = [
            task(2, { priority: "LOW" }),
            task(1, { priority: "HIGH" }),
            task(3, { status: "DONE" as const }),
        ]
        const before = JSON.stringify(input)

        buildAdvisor(input, { displayName: "مهدی", availableMinutes: 120 })

        expect(JSON.stringify(input)).toBe(before)
    })

    it("greets the user by name and mentions the next task title, without deadlines", () => {
        const result = buildAdvisor([task(1, { title: "پروژه دانشگاه" })], {
            displayName: "مهدی",
            availableMinutes: null,
        })

        expect(result.message).toBe("مهدی جان، پیشنهاد من اینه که با تسک «پروژه دانشگاه» شروع کنی.")
        expect(result.message).not.toMatch(/موعد|ددلاین|deadline/i)
    })
})
