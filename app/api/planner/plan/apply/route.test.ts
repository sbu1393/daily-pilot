import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* Phase 3 — Route test: POST /api/planner/plan/apply                  */
/*                                                                    */
/* Auth + apply service mocked; the request schema is REAL so this    */
/* locks the trust-boundary validation. Quota/AI modules are mocked   */
/* to prove Apply consumes no AI quota and makes no AI call.          */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    applyPlan: vi.fn(),
    reserveQuota: vi.fn(),
    completeQuota: vi.fn(),
    releaseQuota: vi.fn(),
    analyzeBatchPlan: vi.fn(),
    recordError: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/services/planApply.service", () => ({ applyPlan: mocks.applyPlan }))
vi.mock("@/app/lib/services/aiQuota.service", () => ({
    reserveQuota: mocks.reserveQuota,
    completeQuota: mocks.completeQuota,
    releaseQuota: mocks.releaseQuota,
}))
vi.mock("@/app/lib/ai/analyzeBatchPlan", () => ({ analyzeBatchPlan: mocks.analyzeBatchPlan }))
vi.mock("@/src/lib/observability/recordError", () => ({ recordError: mocks.recordError }))

import { POST } from "./route"
import { PlanStaleError } from "@/app/lib/services/errors"

const USER = { id: 1, username: "test", email: "t@example.com", timezone: "Asia/Tehran", plan: "FREE" }
const DAY = "2026-09-27"

const planned = (taskId: number, overrides: Record<string, unknown> = {}) => ({
    taskId,
    estimatedMinutes: 40,
    suggestedMinutes: 40,
    order: taskId,
    aiOrder: taskId,
    priority: "HIGH",
    score: 80,
    weight: 100,
    partial: false,
    ...overrides,
})

const PROPOSAL = {
    basis: {
        dayKey: DAY,
        planVersion: 5,
        rebalancedVersion: 5,
        availableMinutes: 120,
        taskCount: 2,
        state: "fresh",
    },
    planned: [planned(1), planned(2)],
    unfitted: [],
    plannedMinutes: 80,
    remainingMinutes: 40,
    aiUnscheduledTaskIds: [],
    source: "1xai",
}

const RESULT = {
    applied: true,
    dayKey: DAY,
    planVersion: 6,
    rebalancedVersion: 6,
    availableMinutes: 120,
    plannedMinutes: 80,
    remainingMinutes: 40,
    tasks: [{ id: 1, estimatedTime: 40 }],
}

const body = (overrides: Record<string, unknown> = {}) => ({
    dayKey: DAY,
    expectedPlanVersion: 5,
    proposal: PROPOSAL,
    ...overrides,
})

const callPOST = (payload: unknown) =>
    POST(
        new NextRequest("http://localhost/api/planner/plan/apply", {
            method: "POST",
            body: typeof payload === "string" ? payload : JSON.stringify(payload),
        }),
    )

describe("POST /api/planner/plan/apply", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
        mocks.applyPlan.mockResolvedValue(RESULT)
    })

    it("returns 200 with the final day state and forwards the validated contract", async () => {
        const res = await callPOST(body())

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: RESULT })
        expect(mocks.applyPlan).toHaveBeenCalledWith(1, {
            dayKey: DAY,
            expectedPlanVersion: 5,
            proposal: expect.objectContaining({ source: "1xai" }),
        })
    })

    it("returns 401 and never calls the service when unauthenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await callPOST(body())

        expect(res.status).toBe(401)
        expect(mocks.applyPlan).not.toHaveBeenCalled()
    })

    it("returns 400 for a malformed body and never calls the service", async () => {
        const res = await callPOST("not json")

        expect(res.status).toBe(400)
        expect((await res.json()).error.code).toBe("VALIDATION_ERROR")
        expect(mocks.applyPlan).not.toHaveBeenCalled()
    })

    it("returns 400 for an invalid dayKey format and never calls the service", async () => {
        const res = await callPOST(body({ dayKey: "2026-13-99" }))

        expect(res.status).toBe(400)
        expect((await res.json()).error.code).toBe("VALIDATION_ERROR")
        expect(mocks.applyPlan).not.toHaveBeenCalled()
    })

    it("returns 400 for an invalid expectedPlanVersion (non-integer) and never calls the service", async () => {
        const res = await callPOST(body({ expectedPlanVersion: 1.5 }))

        expect(res.status).toBe(400)
        expect(mocks.applyPlan).not.toHaveBeenCalled()
    })

    it.each([
        ["duplicate taskId in planned", { planned: [planned(1), planned(1)] }],
        ["duplicate order in planned", { planned: [planned(1), planned(2, { order: 1 })] }],
        [
            "planned + unfitted overlap",
            { unfitted: [{ taskId: 1, estimatedMinutes: 20, weight: 10, aiOrder: 1, score: 40, priority: "MEDIUM" }] },
        ],
        ["out-of-bounds duration", { planned: [planned(1, { estimatedMinutes: 4 }), planned(2)] }],
        ["out-of-bounds score", { planned: [planned(1, { score: 900 }), planned(2)] }],
        ["invalid order (0)", { planned: [planned(1, { order: 0 }), planned(2)] }],
        ["unknown priority", { planned: [planned(1, { priority: "URGENT" }), planned(2)] }],
        ["invalid source", { source: "openai" }],
    ])("returns 400 for an invalid proposal (%s) and never calls the service", async (_label, overrides) => {
        const res = await callPOST(body({ proposal: { ...PROPOSAL, ...overrides } }))

        expect(res.status).toBe(400)
        expect((await res.json()).error.code).toBe("VALIDATION_ERROR")
        expect(mocks.applyPlan).not.toHaveBeenCalled()
    })

    it("accepts a valid unfitted item carrying score/priority (Phase 4.2)", async () => {
        const res = await callPOST(
            body({
                proposal: {
                    ...PROPOSAL,
                    unfitted: [
                        { taskId: 3, estimatedMinutes: 20, weight: 10, aiOrder: 3, score: 40, priority: "MEDIUM" },
                    ],
                },
            }),
        )

        expect(res.status).toBe(200)
        expect(mocks.applyPlan).toHaveBeenCalledWith(
            1,
            expect.objectContaining({
                proposal: expect.objectContaining({
                    unfitted: [expect.objectContaining({ taskId: 3, score: 40, priority: "MEDIUM" })],
                }),
            }),
        )
    })

    const INVALID_UNFITTED: Array<[string, Record<string, unknown>]> = [
        ["invalid unfitted score", { score: 500, priority: "MEDIUM" }],
        ["invalid unfitted priority", { score: 40, priority: "URGENT" }],
        ["missing required unfitted score", { priority: "MEDIUM" }],
        ["missing required unfitted priority", { score: 40 }],
    ]

    it.each(INVALID_UNFITTED)(
        "returns 400 for an invalid unfitted item (%s) and never calls the service",
        async (_label, extra) => {
            const unfittedItem = { taskId: 3, estimatedMinutes: 20, weight: 10, aiOrder: 3, ...extra }

            const res = await callPOST(body({ proposal: { ...PROPOSAL, unfitted: [unfittedItem] } }))

            expect(res.status).toBe(400)
            expect((await res.json()).error.code).toBe("VALIDATION_ERROR")
            expect(mocks.applyPlan).not.toHaveBeenCalled()
        },
    )

    it("propagates PLAN_STALE from the service as 409", async () => {
        mocks.applyPlan.mockRejectedValue(new PlanStaleError())

        const res = await callPOST(body())

        expect(res.status).toBe(409)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("PLAN_STALE")
    })

    it("consumes no AI quota and makes no AI call", async () => {
        await callPOST(body())

        expect(mocks.reserveQuota).not.toHaveBeenCalled()
        expect(mocks.completeQuota).not.toHaveBeenCalled()
        expect(mocks.releaseQuota).not.toHaveBeenCalled()
        expect(mocks.analyzeBatchPlan).not.toHaveBeenCalled()
    })

    it("carries X-Request-ID on both success and error responses", async () => {
        const ok = await callPOST(body())
        expect(ok.headers.get("X-Request-ID")).toEqual(expect.any(String))

        mocks.applyPlan.mockRejectedValue(new PlanStaleError())
        const err = await callPOST(body())
        expect(err.headers.get("X-Request-ID")).toEqual(expect.any(String))
    })
})
