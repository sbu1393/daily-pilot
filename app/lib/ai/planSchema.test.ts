import { describe, expect, it } from "vitest"

/* ------------------------------------------------------------------ */
/* Phase 1 — AI Daily Plan: aiBatchPlanSchema + parseAiPlanJson        */
/* Pure — بدون DB/AI/شبکه.                                             */
/* ------------------------------------------------------------------ */

import { aiBatchPlanSchema, parseAiPlanJson } from "./planSchema"

const validPlan = () => ({
    items: [
        { taskId: 1, estimatedMinutes: 60, score: 80, priority: "HIGH", order: 1 },
        { taskId: 2, estimatedMinutes: 30, score: 40, priority: "LOW", order: 2, reason: "کوتاه" },
    ],
    unscheduledTaskIds: [3],
    summary: "برنامه پیشنهادی",
})

describe("aiBatchPlanSchema — shape", () => {
    it("accepts a well-formed batch output", () => {
        const parsed = aiBatchPlanSchema.parse(validPlan())
        expect(parsed.items).toHaveLength(2)
        expect(parsed.unscheduledTaskIds).toEqual([3])
        expect(parsed.summary).toBe("برنامه پیشنهادی")
    })

    it("coerces numeric strings for taskId/order/estimate/score (domain ids are Int)", () => {
        const parsed = aiBatchPlanSchema.parse({
            items: [{ taskId: "7", estimatedMinutes: "45", score: "55", priority: "MEDIUM", order: "1" }],
        })
        expect(parsed.items[0]).toEqual({
            taskId: 7,
            estimatedMinutes: 45,
            score: 55,
            priority: "MEDIUM",
            order: 1,
        })
    })

    it("allows unscheduledTaskIds and summary to be omitted", () => {
        const parsed = aiBatchPlanSchema.parse({
            items: [{ taskId: 1, estimatedMinutes: 30, score: 50, priority: "MEDIUM", order: 1 }],
        })
        expect(parsed.unscheduledTaskIds).toBeUndefined()
        expect(parsed.summary).toBeUndefined()
    })

    it("requires at least one item", () => {
        expect(aiBatchPlanSchema.safeParse({ items: [] }).success).toBe(false)
    })
})

describe("aiBatchPlanSchema — rejects malformed values", () => {
    it("rejects an out-of-range estimatedMinutes (min 5 / max 480)", () => {
        expect(
            aiBatchPlanSchema.safeParse({
                items: [{ taskId: 1, estimatedMinutes: 4, score: 50, priority: "HIGH", order: 1 }],
            }).success,
        ).toBe(false)
        expect(
            aiBatchPlanSchema.safeParse({
                items: [{ taskId: 1, estimatedMinutes: 481, score: 50, priority: "HIGH", order: 1 }],
            }).success,
        ).toBe(false)
    })

    it("rejects a non-integer estimatedMinutes", () => {
        expect(
            aiBatchPlanSchema.safeParse({
                items: [{ taskId: 1, estimatedMinutes: 30.5, score: 50, priority: "HIGH", order: 1 }],
            }).success,
        ).toBe(false)
    })

    it("rejects an out-of-range score (min 0 / max 100)", () => {
        expect(
            aiBatchPlanSchema.safeParse({
                items: [{ taskId: 1, estimatedMinutes: 30, score: 101, priority: "HIGH", order: 1 }],
            }).success,
        ).toBe(false)
        expect(
            aiBatchPlanSchema.safeParse({
                items: [{ taskId: 1, estimatedMinutes: 30, score: -1, priority: "HIGH", order: 1 }],
            }).success,
        ).toBe(false)
    })

    it("rejects an invalid priority", () => {
        expect(
            aiBatchPlanSchema.safeParse({
                items: [{ taskId: 1, estimatedMinutes: 30, score: 50, priority: "URGENT", order: 1 }],
            }).success,
        ).toBe(false)
    })

    it("rejects a non-positive or non-numeric order", () => {
        expect(
            aiBatchPlanSchema.safeParse({
                items: [{ taskId: 1, estimatedMinutes: 30, score: 50, priority: "HIGH", order: 0 }],
            }).success,
        ).toBe(false)
        expect(
            aiBatchPlanSchema.safeParse({
                items: [{ taskId: 1, estimatedMinutes: 30, score: 50, priority: "HIGH", order: "x" }],
            }).success,
        ).toBe(false)
    })

    it("rejects a non-numeric taskId", () => {
        expect(
            aiBatchPlanSchema.safeParse({
                items: [{ taskId: "abc", estimatedMinutes: 30, score: 50, priority: "HIGH", order: 1 }],
            }).success,
        ).toBe(false)
    })
})

describe("aiBatchPlanSchema — cross-field rules", () => {
    it("rejects duplicate taskIds", () => {
        expect(
            aiBatchPlanSchema.safeParse({
                items: [
                    { taskId: 1, estimatedMinutes: 30, score: 50, priority: "HIGH", order: 1 },
                    { taskId: 1, estimatedMinutes: 45, score: 60, priority: "LOW", order: 2 },
                ],
            }).success,
        ).toBe(false)
    })

    it("rejects duplicate orders", () => {
        expect(
            aiBatchPlanSchema.safeParse({
                items: [
                    { taskId: 1, estimatedMinutes: 30, score: 50, priority: "HIGH", order: 1 },
                    { taskId: 2, estimatedMinutes: 45, score: 60, priority: "LOW", order: 1 },
                ],
            }).success,
        ).toBe(false)
    })

    it("rejects duplicate ids inside unscheduledTaskIds", () => {
        expect(
            aiBatchPlanSchema.safeParse({
                items: [{ taskId: 1, estimatedMinutes: 30, score: 50, priority: "HIGH", order: 1 }],
                unscheduledTaskIds: [2, 2],
            }).success,
        ).toBe(false)
    })

    it("rejects a task that is both planned and unscheduled", () => {
        expect(
            aiBatchPlanSchema.safeParse({
                items: [{ taskId: 1, estimatedMinutes: 30, score: 50, priority: "HIGH", order: 1 }],
                unscheduledTaskIds: [1],
            }).success,
        ).toBe(false)
    })
})

describe("parseAiPlanJson", () => {
    it("parses a raw JSON object", () => {
        const parsed = parseAiPlanJson(JSON.stringify(validPlan()))
        expect(parsed.items.map((i) => i.taskId)).toEqual([1, 2])
    })

    it("tolerates markdown fences and surrounding prose", () => {
        const raw = `Sure!\n\`\`\`json\n${JSON.stringify(validPlan())}\n\`\`\``
        expect(parseAiPlanJson(raw).items).toHaveLength(2)
    })

    it("rejects malformed JSON after parsing", () => {
        expect(() => parseAiPlanJson("not json at all")).toThrow()
    })

    it("rejects JSON that fails schema validation (with a useful error path)", () => {
        const raw = JSON.stringify({
            items: [{ taskId: 1, estimatedMinutes: 999, score: 50, priority: "HIGH", order: 1 }],
        })
        expect(() => parseAiPlanJson(raw)).toThrow()
    })
})
