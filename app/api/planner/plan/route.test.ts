import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* Phase 2 — Route test: POST /api/planner/plan                        */
/*                                                                    */
/* DB/AI/quota mocked; validation + proposal builder are REAL so this */
/* is an integration-level proof of the pipeline.                     */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    getPrisma: vi.fn(),
    isRateLimited: vi.fn(),
    getCanonicalToday: vi.fn(),
    getPlanGenerationContext: vi.fn(),
    analyzeBatchPlan: vi.fn(),
    reserveQuota: vi.fn(),
    completeQuota: vi.fn(),
    releaseQuota: vi.fn(),
    markReleaseFailed: vi.fn(),
    recordError: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: mocks.getPrisma }))
vi.mock("@/app/lib/rateLimit", () => ({ isRateLimited: mocks.isRateLimited }))
vi.mock("@/app/lib/canonicalDay", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/canonicalDay")>()),
    getCanonicalToday: mocks.getCanonicalToday,
}))
vi.mock("@/app/lib/services/plan.service", () => ({
    getPlanGenerationContext: mocks.getPlanGenerationContext,
}))
vi.mock("@/app/lib/ai/analyzeBatchPlan", () => ({ analyzeBatchPlan: mocks.analyzeBatchPlan }))
vi.mock("@/app/lib/services/aiQuota.service", () => ({
    reserveQuota: mocks.reserveQuota,
    completeQuota: mocks.completeQuota,
    releaseQuota: mocks.releaseQuota,
}))
vi.mock("@/app/lib/services/aiUsage.service", () => ({ markReleaseFailed: mocks.markReleaseFailed }))
vi.mock("@/src/lib/observability/recordError", () => ({ recordError: mocks.recordError }))

import { POST } from "./route"
import {
    AiProviderUnavailableError,
    DayPlanNotSetError,
    NoPlannableTasksError,
    QuotaExceededError,
} from "@/app/lib/services/errors"

const USER = { id: 1, username: "test", email: "t@example.com", timezone: "Asia/Tehran", plan: "FREE" }
const DAY_KEY = "2026-09-27"

const INPUT = {
    dayKey: DAY_KEY,
    availableMinutes: 120,
    tasks: [
        { taskId: 1, title: "گزارش فروش" },
        { taskId: 2, title: "خرید نان" },
    ],
}

const CTX = {
    planVersion: 3,
    rebalancedVersion: 2,
    availableMinutes: 120,
    input: INPUT,
    suggestionTasks: [
        { id: 1, estimatedTime: null, score: null, priority: null, status: "TODO", allocatedMinutes: null },
        { id: 2, estimatedTime: null, score: null, priority: null, status: "TODO", allocatedMinutes: null },
    ],
}

const AI_PLAN = {
    items: [
        { taskId: 1, estimatedMinutes: 30, score: 70, priority: "HIGH", order: 2 },
        { taskId: 2, estimatedMinutes: 20, score: 40, priority: "LOW", order: 1 },
    ],
}

const prismaMock = {
    task: { update: vi.fn(), updateMany: vi.fn(), create: vi.fn(), delete: vi.fn() },
    dailyPlan: { update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), create: vi.fn() },
}

const callPOST = (body: unknown) =>
    POST(
        new NextRequest("http://localhost/api/planner/plan", {
            method: "POST",
            body: typeof body === "string" ? body : JSON.stringify(body),
        }),
    )

describe("POST /api/planner/plan", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
        mocks.getPrisma.mockReturnValue(prismaMock)
        mocks.isRateLimited.mockReturnValue(false)
        mocks.getCanonicalToday.mockReturnValue(DAY_KEY)
        mocks.getPlanGenerationContext.mockResolvedValue(CTX)
        mocks.analyzeBatchPlan.mockResolvedValue({ source: "1xai", plan: AI_PLAN, attempts: 1 })
        mocks.reserveQuota.mockResolvedValue(undefined)
        mocks.completeQuota.mockResolvedValue(true)
        mocks.releaseQuota.mockResolvedValue(true)
        mocks.markReleaseFailed.mockResolvedValue(true)
        mocks.recordError.mockResolvedValue(undefined)
    })

    it("returns a valid ephemeral proposal with basis/source and no mutation", async () => {
        const res = await callPOST({ dayKey: DAY_KEY })

        expect(res.status).toBe(200)
        const parsed = await res.json()
        expect(parsed.ok).toBe(true)
        expect(parsed.data.source).toBe("1xai")
        expect(parsed.data.basis).toEqual({
            dayKey: DAY_KEY,
            planVersion: 3,
            rebalancedVersion: 2,
            availableMinutes: 120,
            taskCount: 2,
            state: "fresh",
        })
        expect(parsed.data.planned.map((p: any) => p.taskId).sort()).toEqual([1, 2])
        expect(parsed.data.planned[0].aiOrder).toBeDefined()
    })

    it("consumes exactly one quota unit (feature 'plan') and completes it", async () => {
        await callPOST({ dayKey: DAY_KEY })

        expect(mocks.reserveQuota).toHaveBeenCalledTimes(1)
        const reserveArg = mocks.reserveQuota.mock.calls[0][1]
        expect(reserveArg).toMatchObject({ userId: 1, units: 1, feature: "plan", allowedUnits: 15 })
        expect(reserveArg.requestId).toEqual(expect.any(String))
        expect(mocks.completeQuota).toHaveBeenCalledTimes(1)
        expect(mocks.releaseQuota).not.toHaveBeenCalled()
    })

    it("never mutates DailyPlan or Task allocation (proposal is read-only/ephemeral)", async () => {
        await callPOST({ dayKey: DAY_KEY })

        for (const fn of [
            prismaMock.task.update,
            prismaMock.task.updateMany,
            prismaMock.task.create,
            prismaMock.task.delete,
            prismaMock.dailyPlan.update,
            prismaMock.dailyPlan.updateMany,
            prismaMock.dailyPlan.upsert,
            prismaMock.dailyPlan.create,
        ]) {
            expect(fn).not.toHaveBeenCalled()
        }
    })

    it("defaults dayKey to the user's canonical today and never accepts client capacity/tasks", async () => {
        await callPOST({})

        expect(mocks.getCanonicalToday).toHaveBeenCalledWith("Asia/Tehran")
        expect(mocks.getPlanGenerationContext).toHaveBeenCalledWith(1, DAY_KEY)
    })

    it("passes a client-provided dayKey through after validating it", async () => {
        await callPOST({ dayKey: "2026-01-02" })
        expect(mocks.getPlanGenerationContext).toHaveBeenCalledWith(1, "2026-01-02")
    })

    it("returns 401 and consumes no quota when unauthenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await callPOST({ dayKey: DAY_KEY })

        expect(res.status).toBe(401)
        expect(mocks.reserveQuota).not.toHaveBeenCalled()
        expect(mocks.analyzeBatchPlan).not.toHaveBeenCalled()
    })

    it("returns 400 for a malformed body and never touches business/quota", async () => {
        const res = await callPOST("not json")

        expect(res.status).toBe(400)
        expect((await res.json()).error.code).toBe("VALIDATION_ERROR")
        expect(mocks.reserveQuota).not.toHaveBeenCalled()
    })

    it("returns 400 for invalid field types", async () => {
        const res = await callPOST({ dayKey: 123 })

        expect(res.status).toBe(400)
        expect((await res.json()).error.code).toBe("VALIDATION_ERROR")
        expect(mocks.reserveQuota).not.toHaveBeenCalled()
    })

    it("returns 400 for a calendar-invalid dayKey and never calls the loader", async () => {
        const res = await callPOST({ dayKey: "2026-13-99" })

        expect(res.status).toBe(400)
        expect((await res.json()).error.code).toBe("VALIDATION_ERROR")
        expect(mocks.getPlanGenerationContext).not.toHaveBeenCalled()
    })

    it("returns 429 RATE_LIMITED before loading or consuming quota", async () => {
        mocks.isRateLimited.mockReturnValue(true)

        const res = await callPOST({ dayKey: DAY_KEY })

        expect(res.status).toBe(429)
        expect((await res.json()).error.code).toBe("RATE_LIMITED")
        expect(mocks.getPlanGenerationContext).not.toHaveBeenCalled()
        expect(mocks.reserveQuota).not.toHaveBeenCalled()
    })

    it("returns 404 DAY_PLAN_NOT_SET when there is no valid day/plan state", async () => {
        mocks.getPlanGenerationContext.mockRejectedValue(new DayPlanNotSetError())

        const res = await callPOST({ dayKey: DAY_KEY })

        expect(res.status).toBe(404)
        expect((await res.json()).error.code).toBe("DAY_PLAN_NOT_SET")
        expect(mocks.reserveQuota).not.toHaveBeenCalled()
    })

    it("returns 404 NO_PLANNABLE_TASKS when there are no open tasks", async () => {
        mocks.getPlanGenerationContext.mockRejectedValue(new NoPlannableTasksError())

        const res = await callPOST({ dayKey: DAY_KEY })

        expect(res.status).toBe(404)
        expect((await res.json()).error.code).toBe("NO_PLANNABLE_TASKS")
        expect(mocks.reserveQuota).not.toHaveBeenCalled()
    })

    it("returns 429 QUOTA_EXCEEDED and never calls the AI", async () => {
        mocks.reserveQuota.mockRejectedValue(new QuotaExceededError())

        const res = await callPOST({ dayKey: DAY_KEY })

        expect(res.status).toBe(429)
        expect((await res.json()).error.code).toBe("QUOTA_EXCEEDED")
        expect(mocks.analyzeBatchPlan).not.toHaveBeenCalled()
        expect(mocks.completeQuota).not.toHaveBeenCalled()
    })

    it("releases quota (with provider failureCode) and returns 503 when the AI is unavailable", async () => {
        mocks.analyzeBatchPlan.mockRejectedValue(new AiProviderUnavailableError())

        const res = await callPOST({ dayKey: DAY_KEY })

        expect(res.status).toBe(503)
        expect((await res.json()).error.code).toBe("AI_PROVIDER_UNAVAILABLE")
        expect(mocks.releaseQuota).toHaveBeenCalledTimes(1)
        expect(mocks.releaseQuota.mock.calls[0][3]).toMatchObject({
            failureCode: "AI_PROVIDER_UNAVAILABLE",
        })
        expect(mocks.completeQuota).not.toHaveBeenCalled()
        expect(mocks.recordError).toHaveBeenCalled()
    })

    it("stays fail-closed (QUOTA_UNAVAILABLE) when release itself fails, and marks reconciliation", async () => {
        mocks.analyzeBatchPlan.mockRejectedValue(new AiProviderUnavailableError())
        mocks.releaseQuota.mockRejectedValue(new Error("db down"))

        const res = await callPOST({ dayKey: DAY_KEY })

        expect(res.status).toBe(503)
        expect((await res.json()).error.code).toBe("QUOTA_UNAVAILABLE")
        expect(mocks.markReleaseFailed).toHaveBeenCalledTimes(1)
        expect(mocks.completeQuota).not.toHaveBeenCalled()
    })

    it("releases quota and returns 502 AI_PLAN_INVALID when AI output fails semantic validation", async () => {
        mocks.analyzeBatchPlan.mockResolvedValue({
            source: "1xai",
            plan: { items: [{ taskId: 99, estimatedMinutes: 30, score: 70, priority: "HIGH", order: 1 }] },
            attempts: 1,
        })

        const res = await callPOST({ dayKey: DAY_KEY })

        expect(res.status).toBe(502)
        expect((await res.json()).error.code).toBe("AI_PLAN_INVALID")
        expect(mocks.releaseQuota).toHaveBeenCalledTimes(1)
        expect(mocks.releaseQuota.mock.calls[0][3]).toMatchObject({ failureCode: "AI_PLAN_INVALID" })
        expect(mocks.completeQuota).not.toHaveBeenCalled()
        expect(mocks.recordError).toHaveBeenCalled()
    })

    it("passes the mock source through to the proposal", async () => {
        mocks.analyzeBatchPlan.mockResolvedValue({ source: "mock", plan: AI_PLAN, attempts: 0 })

        const res = await callPOST({ dayKey: DAY_KEY })

        expect(res.status).toBe(200)
        expect((await res.json()).data.source).toBe("mock")
    })

    it("carries X-Request-ID on both success and error responses", async () => {
        const ok = await callPOST({ dayKey: DAY_KEY })
        expect(ok.headers.get("X-Request-ID")).toEqual(expect.any(String))

        mocks.analyzeBatchPlan.mockRejectedValue(new AiProviderUnavailableError())
        const err = await callPOST({ dayKey: DAY_KEY })
        expect(err.headers.get("X-Request-ID")).toEqual(expect.any(String))
    })
})
