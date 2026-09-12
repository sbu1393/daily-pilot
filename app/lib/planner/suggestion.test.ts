import { describe, expect, it } from "vitest"

/* ------------------------------------------------------------------ */
/* ADR-006 — Phase S1: تست‌های موتور پیشنهاد روز (pure، بدون DB/AI)     */
/* ------------------------------------------------------------------ */

import { estimateOf, weightOf, GRANULARITY } from "./rebalance"

import { suggestDay, type SuggestionTaskInput } from "./suggestion"

const task = (
    id: number,
    overrides: Partial<SuggestionTaskInput> = {},
): SuggestionTaskInput => ({
    id,
    estimatedTime: null,
    score: null,
    priority: null,
    status: "TODO",
    ...overrides,
})

describe("suggestDay — fast path (capacity fits all estimates)", () => {
    it("gives every task its full safe estimate and leaves the surplus as pool", () => {
        // ۳۰ + ۶۰ = ۹۰ ≤ ۱۲۰ → مازاد ۳۰ استخر می‌شود
        const result = suggestDay(120, [
            task(1, { estimatedTime: 30, score: 80 }),
            task(2, { estimatedTime: 60, score: 40 }),
        ])

        expect(result.capacityMinutes).toBe(120)
        expect(result.planned.map((p) => [p.taskId, p.suggestedMinutes])).toEqual([
            [2, 60], // وزن بالاتر: 60×(0.5+0.2)=54 > 30×(0.5+0.4)=27
            [1, 30],
        ])
        expect(result.unfitted).toEqual([])
        expect(result.plannedMinutes).toBe(90)
        expect(result.remainingMinutes).toBe(30)
        expect(result.planned.every((p) => !p.partial)).toBe(true)
    })

    it("returns zero capacity as an empty plan with all tasks unfitted", () => {
        const result = suggestDay(0, [
            task(1, { estimatedTime: 30 }),
            task(2, { estimatedTime: 45 }),
        ])

        expect(result.planned).toEqual([])
        expect(result.unfitted.map((u) => u.taskId).sort()).toEqual([1, 2])
        expect(result.plannedMinutes).toBe(0)
        expect(result.remainingMinutes).toBe(0)
    })

    it("handles an empty task list", () => {
        const result = suggestDay(240, [])
        expect(result.planned).toEqual([])
        expect(result.unfitted).toEqual([])
        expect(result.plannedMinutes).toBe(0)
        expect(result.remainingMinutes).toBe(240)
    })

    it("excludes DONE tasks from the suggestion entirely", () => {
        const result = suggestDay(120, [
            task(1, { estimatedTime: 30, status: "DONE" }),
            task(2, { estimatedTime: 30 }),
        ])

        expect(result.planned.map((p) => p.taskId)).toEqual([2])
        expect(result.unfitted).toEqual([])
        expect(result.remainingMinutes).toBe(90)
    })

    it("includes IN_PROGRESS tasks as candidates (they are open work)", () => {
        const result = suggestDay(60, [task(1, { estimatedTime: 30, status: "IN_PROGRESS" })])
        expect(result.planned.map((p) => p.taskId)).toEqual([1])
    })
})

describe("suggestDay — overbook (weighted proportional with caps)", () => {
    it("never allocates above a task's estimate", () => {
        // تخمین‌ها ۶۰ و ۳۰ (جمع ۹۰) ولی بودجه فقط ۴۵
        const result = suggestDay(45, [
            task(1, { estimatedTime: 60, score: 90 }),
            task(2, { estimatedTime: 30, score: 10 }),
        ])

        const a1 = result.planned.find((p) => p.taskId === 1)!
        const a2 = result.planned.find((p) => p.taskId === 2)
        if (a2) {
            expect(a2.suggestedMinutes).toBeLessThanOrEqual(30)
            expect(a2.suggestedMinutes % GRANULARITY).toBe(0)
        }
        expect(a1.suggestedMinutes).toBeLessThanOrEqual(60)
        expect(a1.suggestedMinutes % GRANULARITY).toBe(0)
        if (a2) {
            expect(a2.suggestedMinutes % GRANULARITY).toBe(0)
        }
        expect(result.plannedMinutes).toBeLessThanOrEqual(45)
    })

    it("drops shares below MIN_ALLOCATION (15) and lists them as unfitted when nothing fits", () => {
        // بودجه‌ی خیلی کم: هیچ سهمِ ≥ ۱۵ دقیقه‌ای ممکن نیست → همه unfitted، بودجه دست‌نخورده
        const result = suggestDay(20, [
            task(1, { estimatedTime: 60, score: 90 }),
            task(2, { estimatedTime: 60, score: 5 }),
            task(3, { estimatedTime: 60, score: 6 }),
        ])

        expect(result.planned).toEqual([])
        expect(result.unfitted.map((u) => u.taskId).sort((a, b) => a - b)).toEqual([1, 2, 3])
        expect(result.plannedMinutes).toBe(0)
        expect(result.remainingMinutes).toBe(20)
    })

    it("marks partially-allocated tasks (suggested < estimate)", () => {
        // ظرفیت ۱۵ فقط اجازه‌ی سهم جزئی می‌دهد
        const result = suggestDay(15, [task(1, { estimatedTime: 60, score: 90 })])

        const a1 = result.planned.find((p) => p.taskId === 1)
        expect(a1).toBeDefined()
        expect(a1!.partial).toBe(true)
        expect(a1!.suggestedMinutes).toBeLessThan(60)
    })

    it("keeps every suggestion a multiple of the engine granularity (5)", () => {
        const result = suggestDay(100, [
            task(1, { estimatedTime: 45, score: 70 }),
            task(2, { estimatedTime: 45, score: 50 }),
            task(3, { estimatedTime: 45, score: 30 }),
        ])
        for (const p of result.planned) {
            expect(p.suggestedMinutes % GRANULARITY).toBe(0)
        }
        expect(result.plannedMinutes % GRANULARITY).toBe(0)
    })

    it("allocates more weight to the higher-scored task under scarcity", () => {
        // دو کار با تخمین برابر، امتیاز متفاوت — بودجه‌ی ناکافی
        const result = suggestDay(60, [
            task(1, { estimatedTime: 60, score: 90 }),
            task(2, { estimatedTime: 60, score: 10 }),
        ])

        const a1 = result.planned.find((p) => p.taskId === 1)
        const a2 = result.planned.find((p) => p.taskId === 2)
        if (a1 && a2) {
            expect(a1.suggestedMinutes).toBeGreaterThan(a2.suggestedMinutes)
        }
    })
})

describe("suggestDay — determinism and engine parity", () => {
    it("is deterministic: same input → identical output", () => {
        const input = [task(1, { estimatedTime: 45, score: 60 }), task(2, { estimatedTime: 90, score: 20 })]
        const a = suggestDay(80, input)
        const b = suggestDay(80, input)
        expect(a).toEqual(b)
    })

    it("uses the same weight formula as the rebalance engine", () => {
        const t = task(7, { estimatedTime: 40, score: 55 })
        const result = suggestDay(20, [t])
        const planned = result.planned.find((p) => p.taskId === 7)
        // وزنِ گزارش‌شده باید همان وزنِ موتور باشد
        expect(planned?.weight ?? result.unfitted.find((u) => u.taskId === 7)!.weight).toBe(
            weightOf({ estimatedTime: 40, score: 55, priority: null, status: "TODO", id: 7 }),
        )
    })

    it("uses the same safe-estimate clamp as the rebalance engine (null → 30, >480 → 480)", () => {
        const noEstimate = suggestDay(120, [task(1, { estimatedTime: null, score: 50 })])
        expect(noEstimate.planned[0]?.estimatedMinutes ?? noEstimate.unfitted[0]?.estimatedMinutes).toBe(
            estimateOf({ estimatedTime: null }),
        )

        const huge = suggestDay(120, [task(2, { estimatedTime: 9999, score: 50 })])
        expect(huge.planned[0]?.estimatedMinutes ?? huge.unfitted[0]?.estimatedMinutes).toBe(
            estimateOf({ estimatedTime: 9999 }),
        )
    })

    it("flags tasks that fell back to the default estimate (30)", () => {
        const result = suggestDay(120, [
            task(1, { estimatedTime: null, score: 50 }),
            task(2, { estimatedTime: 45, score: 50 }),
        ])
        expect(result.usedDefaultEstimate).toEqual([1])
    })

    it("sorts the plan by weight desc (stable, id asc) and unfitted by weight asc", () => {
        const result = suggestDay(45, [
            task(3, { estimatedTime: 60, score: 10 }),
            task(1, { estimatedTime: 60, score: 90 }),
            task(2, { estimatedTime: 60, score: 50 }),
        ])
        const weights = result.planned.map((p) => p.weight)
        expect([...weights].sort((a, b) => b - a)).toEqual(weights)
    })
})

describe("suggestDay — capacity accounting invariants", () => {
    it("planned + remaining never exceeds capacity", () => {
        const result = suggestDay(75, [
            task(1, { estimatedTime: 120, score: 80 }),
            task(2, { estimatedTime: 60, score: 30 }),
        ])
        expect(result.plannedMinutes + result.remainingMinutes).toBeLessThanOrEqual(75)
    })

    it("does not mutate the input array", () => {
        const input = [task(1, { estimatedTime: 30 }), task(2, { estimatedTime: 60 })]
        const snapshot = JSON.stringify(input)
        suggestDay(60, input)
        expect(JSON.stringify(input)).toBe(snapshot)
    })

    it("treats negative capacity as zero", () => {
        const result = suggestDay(-50, [task(1, { estimatedTime: 30 })])
        expect(result.capacityMinutes).toBe(0)
        expect(result.planned).toEqual([])
    })
})
