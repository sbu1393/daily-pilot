import { describe, expect, it } from "vitest"

/* ------------------------------------------------------------------ */
/* Contract tests for the canonical PlanProposal schema                */
/* ------------------------------------------------------------------ */
/* `planProposalSchema` is the SINGLE contract shared by the producer  */
/* (buildPlanProposal, Generate) and the consumer (planApplyRequestSchema,*/
/* Apply). These tests lock both halves of it:                         */
/*                                                                     */
/*  - what must be ACCEPTED (advisory AI vs authoritative engine)      */
/*  - what must still be REJECTED (genuine structural corruption)      */
/*                                                                     */
/* The accept-cases exist because the schema once enforced a wrong      */
/* invariant (aiUnscheduledTaskIds ∩ planned = ∅) that the producer    */
/* legitimately violates, breaking Apply in production. The reject-    */
/* cases exist so that removing that refine did not quietly open the    */
/* schema up.                                                          */
/* ------------------------------------------------------------------ */

import { TASK_TITLE_MAX_LENGTH, TASK_TITLE_TOO_LONG_MESSAGE } from "@/app/lib/taskTitle"
import { planApplyRequestSchema, planProposalSchema, reanalyzeTaskSchema } from "./plannerSchema"

const DAY = "2026-09-27"

const plannedItem = (taskId: number, overrides: Record<string, unknown> = {}) => ({
    taskId,
    estimatedMinutes: 40,
    suggestedMinutes: 40,
    order: taskId,
    aiOrder: taskId,
    reason: null,
    priority: "HIGH" as const,
    score: 80,
    weight: 64,
    partial: false,
    ...overrides,
})

const unfittedItem = (taskId: number, overrides: Record<string, unknown> = {}) => ({
    taskId,
    estimatedMinutes: 60,
    weight: 75,
    aiOrder: null,
    reason: null,
    priority: "LOW" as const,
    score: 30,
    ...overrides,
})

const proposal = (overrides: Record<string, unknown> = {}) => ({
    basis: {
        dayKey: DAY,
        planVersion: 5,
        rebalancedVersion: 5,
        availableMinutes: 360,
        taskCount: 4,
        state: "fresh" as const,
    },
    planned: [plannedItem(1), plannedItem(2)],
    unfitted: [unfittedItem(3)],
    plannedMinutes: 80,
    remainingMinutes: 280,
    aiUnscheduledTaskIds: [],
    source: "1xai" as const,
    ...overrides,
})

const messagesOf = (result: ReturnType<typeof planProposalSchema.safeParse>): string[] =>
    result.success ? [] : result.error.issues.map((i) => i.message)

describe("planProposalSchema — accepted shapes", () => {
    it("accepts a baseline proposal", () => {
        expect(planProposalSchema.safeParse(proposal()).success).toBe(true)
    })

    it("accepts aiUnscheduledTaskIds overlapping planned (AI advisory vs engine authority)", () => {
        const result = planProposalSchema.safeParse(proposal({ aiUnscheduledTaskIds: [1, 2] }))
        expect(messagesOf(result)).toEqual([])
        expect(result.success).toBe(true)
    })

    it("accepts aiUnscheduledTaskIds overlapping unfitted", () => {
        const result = planProposalSchema.safeParse(proposal({ aiUnscheduledTaskIds: [3] }))
        expect(result.success).toBe(true)
    })

    it("accepts the full reported production payload (23/35/47 planned, 48 unfitted)", () => {
        const result = planProposalSchema.safeParse(
            proposal({
                planned: [23, 35, 47].map((id, i) => plannedItem(id, { order: i + 1 })),
                unfitted: [unfittedItem(48)],
                plannedMinutes: 340,
                remainingMinutes: 20,
                aiUnscheduledTaskIds: [23, 35, 48, 47],
            }),
        )
        expect(messagesOf(result)).toEqual([])
        expect(result.success).toBe(true)
    })

    it("accepts an empty aiUnscheduledTaskIds", () => {
        expect(planProposalSchema.safeParse(proposal({ aiUnscheduledTaskIds: [] })).success).toBe(true)
    })

    it("accepts a proposal with no unfitted items at all", () => {
        expect(planProposalSchema.safeParse(proposal({ unfitted: [] })).success).toBe(true)
    })
})

describe("planProposalSchema — still rejects genuine corruption", () => {
    it.each([
        [
            "duplicate id in aiUnscheduledTaskIds",
            { aiUnscheduledTaskIds: [2, 2] },
            "شناسهٔ تکراری در aiUnscheduledTaskIds",
        ],
        [
            "duplicate taskId in planned",
            { planned: [plannedItem(1), plannedItem(1, { order: 2 })] },
            "taskId تکراری در planned",
        ],
        [
            "duplicate taskId in unfitted",
            { unfitted: [unfittedItem(3), unfittedItem(3)] },
            "taskId تکراری در unfitted",
        ],
        [
            "duplicate order in planned",
            { planned: [plannedItem(1), plannedItem(2, { order: 1 })] },
            "order تکراری در planned",
        ],
        [
            "a task in both planned and unfitted",
            { unfitted: [unfittedItem(2)] },
            "یک تسک نمی‌تواند هم planned و هم unfitted باشد",
        ],
    ])("rejects %s", (_label, overrides, message) => {
        const result = planProposalSchema.safeParse(proposal(overrides))
        expect(result.success).toBe(false)
        expect(messagesOf(result)).toContain(message)
    })

    it.each([
        ["a non-integer taskId in aiUnscheduledTaskIds", { aiUnscheduledTaskIds: [1.5] }],
        ["a zero taskId in aiUnscheduledTaskIds", { aiUnscheduledTaskIds: [0] }],
        ["a negative taskId in aiUnscheduledTaskIds", { aiUnscheduledTaskIds: [-3] }],
        ["a non-integer taskId in planned", { planned: [plannedItem(1.5)] }],
        ["an out-of-range estimate", { planned: [plannedItem(1, { estimatedMinutes: 4 })] }],
        ["an out-of-range score", { planned: [plannedItem(1, { score: 900 })] }],
        ["a non-positive order", { planned: [plannedItem(1, { order: 0 })] }],
        ["an unknown priority", { planned: [plannedItem(1, { priority: "URGENT" })] }],
        ["a negative weight", { planned: [plannedItem(1, { weight: -1 })] }],
        ["an over-long reason", { planned: [plannedItem(1, { reason: "ط".repeat(301) })] }],
        ["a missing planned array", { planned: undefined }],
        ["a wrong basis.state", { basis: { ...proposal().basis, state: "stale" } }],
        ["an unknown source", { source: "gpt" }],
    ])("rejects %s", (_label, overrides) => {
        expect(planProposalSchema.safeParse(proposal(overrides)).success).toBe(false)
    })
})

describe("reanalyzeTaskSchema — title length limit", () => {
    const at = (n: number) => "ا".repeat(n)

    it("accepts a missing text (re-analyze the existing title)", () => {
        expect(reanalyzeTaskSchema.safeParse({}).success).toBe(true)
    })

    it("accepts exactly the limit (30 characters)", () => {
        expect(reanalyzeTaskSchema.safeParse({ text: at(TASK_TITLE_MAX_LENGTH) }).success).toBe(true)
    })

    it("rejects one character over the limit (31 characters) with the Persian message", () => {
        const parsed = reanalyzeTaskSchema.safeParse({ text: at(TASK_TITLE_MAX_LENGTH + 1) })
        expect(parsed.success).toBe(false)
        if (!parsed.success) {
            expect(parsed.error.issues.map((i) => i.message)).toContain(TASK_TITLE_TOO_LONG_MESSAGE)
        }
    })
})

describe("planApplyRequestSchema — consumer sees the same contract", () => {
    const body = (p: Record<string, unknown>) => ({
        dayKey: DAY,
        expectedPlanVersion: 5,
        proposal: p,
    })

    it("accepts the same advisory overlap the producer is allowed to emit", () => {
        const result = planApplyRequestSchema.safeParse(body(proposal({ aiUnscheduledTaskIds: [1, 2, 3] })))
        expect(result.success).toBe(true)
    })

    it("rejects a duplicated advisory id, proving the consumer kept the structural guard", () => {
        const result = planApplyRequestSchema.safeParse(body(proposal({ aiUnscheduledTaskIds: [1, 1] })))
        expect(result.success).toBe(false)
    })

    it("still rejects an invalid dayKey and a non-integer expectedPlanVersion", () => {
        expect(
            planApplyRequestSchema.safeParse({ ...body(proposal()), dayKey: "2026-13-99" }).success,
        ).toBe(false)
        expect(
            planApplyRequestSchema.safeParse({ ...body(proposal()), expectedPlanVersion: 1.5 }).success,
        ).toBe(false)
    })
})
