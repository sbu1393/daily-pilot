import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke test: POST /api/tasks/rollover (ADR-04).           */
/* فاز ۳ گام ۷: analytics (touch + productEvent) mocked — success/failure. */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    rolloverTasks: vi.fn(),
    touchAuthenticatedActivity: vi.fn(),
    recordProductEvent: vi.fn(),
    getPrisma: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/services/tasks.service", () => ({ rolloverTasks: mocks.rolloverTasks }))
vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: mocks.getPrisma }))
vi.mock("@/app/lib/services/userActivity.service", () => ({
    touchAuthenticatedActivity: mocks.touchAuthenticatedActivity,
}))
vi.mock("@/app/lib/services/productEvent.service", () => ({
    recordProductEvent: mocks.recordProductEvent,
}))

import { POST } from "./route"

describe("POST /api/tasks/rollover — X-Request-ID (فاز صفر §7)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
        mocks.touchAuthenticatedActivity.mockResolvedValue({ touched: true })
        mocks.recordProductEvent.mockResolvedValue({ recorded: true, eventName: "task.rolled_over" })
        mocks.getPrisma.mockReturnValue({})
    })

    it("200 success carries X-Request-ID", async () => {
        mocks.rolloverTasks.mockResolvedValue({ moved: MOVED, summaries: SUMMARIES })

        const res = await callPOST({ taskIds: [1, 2] })

        expect(res.status).toBe(200)
        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
    })

    it("404 domain error carries X-Request-ID", async () => {
        mocks.rolloverTasks.mockRejectedValue(new NoRolloverCandidatesError())

        const res = await callPOST({ taskIds: [1, 2] })

        expect(res.status).toBe(404)
        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
    })
})
import { NoRolloverCandidatesError, PlanStaleError } from "@/app/lib/services/errors"

const USER = { id: 1, username: "test", email: "test@example.com", timezone: "Asia/Tehran" }
// قرارداد واقعی سرویس: { id, from, to }[] — فیکسچر قبلی (عدد ۲) ناسازگار بود
const MOVED = [
    { id: 11, from: "2026-01-01", to: "2026-01-02" },
    { id: 12, from: "2026-01-01", to: "2026-01-02" },
]
const SUMMARIES = { "2026-01-01": { availableMinutes: 120, spentMinutes: 60 } }

const callPOST = (body: unknown) =>
    POST(new NextRequest("http://localhost/api/tasks/rollover", {
        method: "POST",
        body: JSON.stringify(body),
    }))

describe("POST /api/tasks/rollover", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
        mocks.touchAuthenticatedActivity.mockResolvedValue({ touched: true })
        mocks.recordProductEvent.mockResolvedValue({ recorded: true, eventName: "task.rolled_over" })
        mocks.getPrisma.mockReturnValue({})
    })

    it("returns 200 with { ok: true, data: { moved, summaries } }", async () => {
        mocks.rolloverTasks.mockResolvedValue({ moved: MOVED, summaries: SUMMARIES })

        const res = await callPOST({ taskIds: [1, 2] })

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: { moved: MOVED, summaries: SUMMARIES } })
        expect(mocks.rolloverTasks).toHaveBeenCalledWith(1, "Asia/Tehran", [1, 2], undefined)
    })

    /* A1 Phase 4 — گارد نسخه‌ی blueprint (اختیاری، additive) */

    it("forwards an optional planVersion to the service", async () => {
        mocks.rolloverTasks.mockResolvedValue({ moved: MOVED, summaries: SUMMARIES })

        const res = await callPOST({ taskIds: [1, 2], planVersion: 7 })

        expect(res.status).toBe(200)
        expect(mocks.rolloverTasks).toHaveBeenCalledWith(1, "Asia/Tehran", [1, 2], 7)
    })

    it("propagates a stale blueprint as 409 PLAN_STALE", async () => {
        mocks.rolloverTasks.mockRejectedValue(new PlanStaleError())

        const res = await callPOST({ taskIds: [1], planVersion: 3 })

        expect(res.status).toBe(409)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("PLAN_STALE")
    })

    it.each([[-1], [1.5], ["3"], [true]])(
        "returns 400 VALIDATION_ERROR for an invalid planVersion (%s) and never calls the service",
        async (planVersion) => {
            const res = await callPOST({ taskIds: [1], planVersion })

            expect(res.status).toBe(400)
            const parsed = await res.json()
            expect(parsed.error.code).toBe("VALIDATION_ERROR")
            expect(mocks.rolloverTasks).not.toHaveBeenCalled()
        },
    )

    it("returns 400 VALIDATION_ERROR for an empty taskIds array and never calls the service", async () => {
        const res = await callPOST({ taskIds: [] })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.rolloverTasks).not.toHaveBeenCalled()
    })

    it("propagates ServiceError NO_ROLLOVER_CANDIDATES as 404", async () => {
        mocks.rolloverTasks.mockRejectedValue(new NoRolloverCandidatesError())

        const res = await callPOST({ taskIds: [1] })

        expect(res.status).toBe(404)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("NO_ROLLOVER_CANDIDATES")
    })

    it("returns 401 UNAUTHORIZED when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await callPOST({ taskIds: [1] })

        expect(res.status).toBe(401)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        })
        expect(mocks.rolloverTasks).not.toHaveBeenCalled()
    })

    it("keeps the request contract backward compatible when planVersion is omitted", async () => {
        mocks.rolloverTasks.mockResolvedValue({ moved: MOVED, summaries: SUMMARIES })

        const res = await callPOST({ taskIds: [1] })

        expect(res.status).toBe(200)
        expect(mocks.rolloverTasks).toHaveBeenCalledWith(1, "Asia/Tehran", [1], undefined)
    })

    /* فاز ۳ — گام ۷: integration analysis (touch + productEvent per moved task) */

    it("records one task.rolled_over event per actually-moved task (per-task granularity)", async () => {
        mocks.rolloverTasks.mockResolvedValue({ moved: MOVED, summaries: SUMMARIES })

        const res = await callPOST({ taskIds: [11, 12] })

        expect(res.status).toBe(200)
        expect(mocks.recordProductEvent).toHaveBeenCalledTimes(2)
        expect(mocks.recordProductEvent).toHaveBeenNthCalledWith(
            1,
            1,
            "task.rolled_over",
            { taskId: 11, toDayKey: "2026-01-02" },
            expect.objectContaining({ requestId: expect.any(String), feature: "tasks" }),
        )
        expect(mocks.recordProductEvent).toHaveBeenNthCalledWith(
            2,
            1,
            "task.rolled_over",
            { taskId: 12, toDayKey: "2026-01-02" },
            expect.anything(),
        )
    })

    it("emits zero events and no touch when moved=[]", async () => {
        mocks.rolloverTasks.mockResolvedValue({ moved: [], summaries: SUMMARIES })

        const res = await callPOST({ taskIds: [1] })

        expect(res.status).toBe(200)
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
    })

    it("touches activity once only after verified rollover success", async () => {
        mocks.rolloverTasks.mockResolvedValue({ moved: MOVED, summaries: SUMMARIES })

        await callPOST({ taskIds: [11, 12] })

        expect(mocks.touchAuthenticatedActivity).toHaveBeenCalledTimes(1)
        expect(mocks.touchAuthenticatedActivity).toHaveBeenCalledWith(
            1,
            expect.any(Date),
            expect.anything(),
        )
    })

    it("emits no event and no touch when the rollover fails (PLAN_STALE)", async () => {
        mocks.rolloverTasks.mockRejectedValue(new PlanStaleError())

        const res = await callPOST({ taskIds: [1], planVersion: 3 })

        expect(res.status).toBe(409)
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
    })

    it("keeps the route response unchanged when analytics fails (fail-open)", async () => {
        mocks.rolloverTasks.mockResolvedValue({ moved: MOVED, summaries: SUMMARIES })
        mocks.touchAuthenticatedActivity.mockRejectedValue(new Error("analytics db down"))

        const res = await callPOST({ taskIds: [11] })

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: { moved: MOVED, summaries: SUMMARIES } })
        // touch شکست خورده → زنجیره متوقف می‌شود؛ رویدادِ بعد از آن ثبت نمی‌شود ولی
        // پاسخ/business result عیناً حفظ شده است
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
    })

    it("propagates requestId from Phase 0 context (never client identity)", async () => {
        mocks.rolloverTasks.mockResolvedValue({ moved: MOVED, summaries: SUMMARIES })

        await callPOST({ taskIds: [11] })

        const ctx = mocks.recordProductEvent.mock.calls[0][3]
        expect(ctx.requestId).toEqual(expect.any(String))
        expect(ctx.requestId.length).toBeGreaterThan(10)
        expect(ctx.endpoint).toBe("/api/tasks/rollover")
    })
})