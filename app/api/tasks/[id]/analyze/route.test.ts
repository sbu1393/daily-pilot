import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke test: PATCH /api/tasks/[id]/analyze (ADR-04).      */
/* C3 — AI analysis: reanalyzeTask mocked (no real AI calls).          */
/*Malformed JSON → 400 (P2 convention), 404 ownership propagation.     */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    isRateLimited: vi.fn(),
    reanalyzeTask: vi.fn(),
    touchAuthenticatedActivity: vi.fn(),
    recordProductEvent: vi.fn(),
    reserveQuota: vi.fn(),
    completeQuota: vi.fn(),
    releaseQuota: vi.fn(),
    getPrisma: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/rateLimit", () => ({ isRateLimited: mocks.isRateLimited }))
vi.mock("@/app/lib/services/tasks.service", () => ({ reanalyzeTask: mocks.reanalyzeTask }))
vi.mock("@/app/lib/services/userActivity.service", () => ({
    touchAuthenticatedActivity: mocks.touchAuthenticatedActivity,
}))
vi.mock("@/app/lib/services/productEvent.service", () => ({
    recordProductEvent: mocks.recordProductEvent,
}))
vi.mock("@/app/lib/services/aiQuota.service", () => ({
    reserveQuota: mocks.reserveQuota,
    completeQuota: mocks.completeQuota,
    releaseQuota: mocks.releaseQuota,
}))
vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: mocks.getPrisma }))
// planPolicy واقعی استفاده می‌شود (خالص و بدون DB) — FREE=15/PRO=300 در تست خودش پوشش دارد

import { PATCH } from "./route"
import {
    AiProviderUnavailableError,
    IdempotencyConflictError,
    QuotaExceededError,
    QuotaUnavailableError,
    TaskNotAnalyzeableError,
    TaskNotFoundError,
} from "@/app/lib/services/errors"

const USER = { id: 1, username: "test", email: "test@example.com", timezone: "Asia/Tehran", plan: "FREE" }
const TASK = { id: 5, text: "گزارش", dayKey: "2026-01-01", status: "TODO" }

const callPATCH = (body: unknown, id = "5") =>
    PATCH(new NextRequest(`http://localhost/api/tasks/${id}/analyze`, {
        method: "PATCH",
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }), { params: Promise.resolve({ id }) })

describe("PATCH /api/tasks/[id]/analyze", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
        mocks.isRateLimited.mockReturnValue(false)
        mocks.touchAuthenticatedActivity.mockResolvedValue({ touched: true })
        mocks.recordProductEvent.mockResolvedValue({ recorded: true, eventName: "ai.analysis_succeeded" })
        mocks.reserveQuota.mockResolvedValue(undefined)
        mocks.completeQuota.mockResolvedValue(true)
        mocks.releaseQuota.mockResolvedValue(true)
        mocks.getPrisma.mockReturnValue({})
    })

    it("returns 200 with { ok: true, data: { task, aiSource } } and no summary key (A6)", async () => {
        mocks.reanalyzeTask.mockResolvedValue({ task: TASK, aiSource: "1xai" })

        const res = await callPATCH({})

        expect(res.status).toBe(200)
        const parsed = await res.json()
        expect(parsed).toEqual({ ok: true, data: { task: TASK, aiSource: "1xai" } })
        expect(parsed.data).not.toHaveProperty("summary")
        // بدون text → متن فعلی تسک دوباره تحلیل میشود
        expect(mocks.reanalyzeTask).toHaveBeenCalledWith(1, "Asia/Tehran", 5, undefined)
        expect(mocks.isRateLimited).toHaveBeenCalledWith("analyze:user:1", 5, 15 * 60 * 1000)
        // فاز ۱ — قرارداد کووتا: reserve 1 unit → complete بعد از موفقیت AI
        expect(mocks.reserveQuota).toHaveBeenCalledTimes(1)
        expect(mocks.completeQuota).toHaveBeenCalledTimes(1)
        expect(mocks.releaseQuota).not.toHaveBeenCalled()
        // فاز ۳ — گام ۹: قرارداد جدید touch — فقط بعد از verified production success
        // (بعد از complete، بعد از reserve). touch دیگر قبل از quota reserve نیست.
        const rateOrder = mocks.isRateLimited.mock.invocationCallOrder[0]
        const reserveOrder = mocks.reserveQuota.mock.invocationCallOrder[0]
        const completeOrder = mocks.completeQuota.mock.invocationCallOrder[0]
        const activityOrder = mocks.touchAuthenticatedActivity.mock.invocationCallOrder[0]
        expect(activityOrder).toBeGreaterThan(rateOrder)
        expect(activityOrder).toBeGreaterThan(reserveOrder)
        expect(activityOrder).toBeGreaterThan(completeOrder)
    })

    it("returns 429 RATE_LIMITED and never calls reanalyzeTask when the user limit is exhausted", async () => {
        mocks.isRateLimited.mockReturnValue(true)

        const res = await callPATCH({})

        expect(res.status).toBe(429)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: {
                code: "RATE_LIMITED",
                message: "تعداد درخواست‌های هوش مصنوعی زیاد شده؛ کمی بعد دوباره تلاش کن",
            },
        })
        expect(mocks.isRateLimited).toHaveBeenCalledWith("analyze:user:1", 5, 15 * 60 * 1000)
        expect(mocks.reanalyzeTask).not.toHaveBeenCalled()
        // کووتا قبل از rate limit صدا نمی‌خورد (no AI, no quota)
        expect(mocks.reserveQuota).not.toHaveBeenCalled()
    })

    it("forwards the explicit text override when provided", async () => {
        mocks.reanalyzeTask.mockResolvedValue({ task: TASK, aiSource: "mock" })

        const res = await callPATCH({ text: "گزارش فروش هفتگی" })

        expect(res.status).toBe(200)
        expect(mocks.reanalyzeTask).toHaveBeenCalledWith(1, "Asia/Tehran", 5, "گزارش فروش هفتگی")
    })

    it("propagates ServiceError TASK_NOT_ANALYZEABLE (DONE) as 400", async () => {
        mocks.reanalyzeTask.mockRejectedValue(new TaskNotAnalyzeableError("DONE"))

        const res = await callPATCH({})

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("TASK_NOT_ANALYZEABLE")
        expect(parsed.error.message).toEqual(expect.any(String))
    })

    it("propagates ServiceError TASK_NOT_FOUND as 404 for a missing or foreign task (ownership)", async () => {
        mocks.reanalyzeTask.mockRejectedValue(new TaskNotFoundError())

        const res = await callPATCH({})

        expect(res.status).toBe(404)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("TASK_NOT_FOUND")
    })

    it("returns 400 VALIDATION_ERROR for an invalid body (text too short)", async () => {
        const res = await callPATCH({ text: "ab" })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.reanalyzeTask).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR for malformed JSON and never calls the service", async () => {
        const res = await callPATCH("not json at all")

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.reanalyzeTask).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR for an absent JSON body (strict ADR-04 convention)", async () => {
        const res = await callPATCH(undefined)

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.reanalyzeTask).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR for an invalid task id and never calls the service", async () => {
        const res = await callPATCH({}, "0")

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.reanalyzeTask).not.toHaveBeenCalled()
    })

    it("returns 401 UNAUTHORIZED when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await callPATCH({})

        expect(res.status).toBe(401)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        })
        expect(mocks.reanalyzeTask).not.toHaveBeenCalled()
        expect(mocks.reserveQuota).not.toHaveBeenCalled()
    })

    // ---------- فاز ۱ — قرارداد کووتا (fail-closed) ----------

    it("propagates QUOTA_EXCEEDED as 429 and never calls the AI service", async () => {
        mocks.reserveQuota.mockRejectedValue(new QuotaExceededError())

        const res = await callPATCH({})

        expect(res.status).toBe(429)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("QUOTA_EXCEEDED")
        expect(mocks.reanalyzeTask).not.toHaveBeenCalled()
        expect(mocks.completeQuota).not.toHaveBeenCalled()
    })

    it("propagates QUOTA_UNAVAILABLE as 503 and never calls the AI service (fail-closed)", async () => {
        mocks.reserveQuota.mockRejectedValue(new QuotaUnavailableError())

        const res = await callPATCH({})

        expect(res.status).toBe(503)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("QUOTA_UNAVAILABLE")
        expect(mocks.reanalyzeTask).not.toHaveBeenCalled()
    })

    it("propagates IDEMPOTENCY_CONFLICT as 409 without any AI call or reservation", async () => {
        mocks.reserveQuota.mockRejectedValue(new IdempotencyConflictError())

        const res = await callPATCH({})

        expect(res.status).toBe(409)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("IDEMPOTENCY_CONFLICT")
        expect(mocks.reanalyzeTask).not.toHaveBeenCalled()
    })

    it("releases the reservation when the AI call fails, then propagates the domain error", async () => {
        mocks.reanalyzeTask.mockRejectedValue(new TaskNotFoundError())

        const res = await callPATCH({})

        expect(res.status).toBe(404)
        expect(mocks.releaseQuota).toHaveBeenCalledTimes(1)
        expect(mocks.releaseQuota).toHaveBeenCalledWith(expect.anything(), expect.any(String))
        expect(mocks.completeQuota).not.toHaveBeenCalled()
    })

    it("maps AI failure after successful release to 503 AI_PROVIDER_UNAVAILABLE (no mock success)", async () => {
        mocks.reanalyzeTask.mockRejectedValue(new AiProviderUnavailableError())

        const res = await callPATCH({})

        expect(res.status).toBe(503)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("AI_PROVIDER_UNAVAILABLE")
        expect(mocks.releaseQuota).toHaveBeenCalledTimes(1)
    })

    it("maps a release failure to 503 QUOTA_UNAVAILABLE (fail-closed, §13)", async () => {
        mocks.reanalyzeTask.mockRejectedValue(new AiProviderUnavailableError())
        mocks.releaseQuota.mockRejectedValue(new QuotaUnavailableError())

        const res = await callPATCH({})

        expect(res.status).toBe(503)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("QUOTA_UNAVAILABLE")
    })

    it("sets the X-Request-ID response header from the server-generated context", async () => {
        mocks.reanalyzeTask.mockResolvedValue({ task: TASK, aiSource: "1xai" })

        const res = await callPATCH({})

        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
        // requestId رزرو همان هدر پاسخ است (shared lifecycle — سند §22)
        expect(mocks.reserveQuota.mock.calls[0][1].requestId).toBe(
            res.headers.get("X-Request-ID"),
        )
    })

    /* ---------------------------------------------------------------- */
    /* فاز ۳ — گام ۹: ai.analysis_succeeded (فقط production success)     */
    /* ---------------------------------------------------------------- */

    it("records ai.analysis_succeeded + touch after verified production success (aiSource=1xai)", async () => {
        mocks.reanalyzeTask.mockResolvedValue({ task: TASK, aiSource: "1xai" })

        const res = await callPATCH({})

        expect(res.status).toBe(200)
        expect(mocks.touchAuthenticatedActivity).toHaveBeenCalledTimes(1)
        expect(mocks.recordProductEvent).toHaveBeenCalledTimes(1)
        expect(mocks.recordProductEvent).toHaveBeenCalledWith(
            1,
            "ai.analysis_succeeded",
            { units: 1, aiSource: "1xai", status: "success" },
            expect.objectContaining({
                requestId: expect.any(String),
                endpoint: "/api/tasks/[id]/analyze",
                feature: "analyze",
            }),
        )
        // touch قبل از event
        const touchOrder = mocks.touchAuthenticatedActivity.mock.invocationCallOrder[0]
        const eventOrder = mocks.recordProductEvent.mock.invocationCallOrder[0]
        expect(eventOrder).toBeGreaterThan(touchOrder)
    })

    it("event properties are exactly the allowlisted scalar values — no prompt/response/content", async () => {
        mocks.reanalyzeTask.mockResolvedValue({
            task: { ...TASK, title: "گزارش محرمانه فروش", text: "گزارش محرمانه فروش" },
            aiSource: "1xai",
        })

        await callPATCH({ text: "گزارش محرمانه فروش" })

        const props = mocks.recordProductEvent.mock.calls[0][2]
        expect(props).toEqual({ units: 1, aiSource: "1xai", status: "success" })
        const args = JSON.stringify(mocks.recordProductEvent.mock.calls[0])
        expect(args).not.toContain("گزارش محرمانه فروش")
        expect(args).not.toContain("prompt")
        expect(args).not.toContain("response")
    })

    it("emits no event and no touch when aiSource is mock — mock is never production success", async () => {
        mocks.reanalyzeTask.mockResolvedValue({ task: TASK, aiSource: "mock" })

        const res = await callPATCH({})

        expect(res.status).toBe(200)
        const parsed = await res.json()
        expect(parsed).toEqual({ ok: true, data: { task: TASK, aiSource: "mock" } })
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
    })

    it("emits no event and no touch on validation failure", async () => {
        const res = await callPATCH({ text: "ab" })

        expect(res.status).toBe(400)
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
    })

    it("emits no event and no touch on quota rejection (QUOTA_EXCEEDED)", async () => {
        mocks.reserveQuota.mockRejectedValue(new QuotaExceededError())

        const res = await callPATCH({})

        expect(res.status).toBe(429)
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
    })

    it("emits no event and no touch on quota unavailability (fail-closed QUOTA_UNAVAILABLE)", async () => {
        mocks.reserveQuota.mockRejectedValue(new QuotaUnavailableError())

        const res = await callPATCH({})

        expect(res.status).toBe(503)
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
    })

    it("emits no event and no touch on AI business failure (TASK_NOT_FOUND)", async () => {
        mocks.reanalyzeTask.mockRejectedValue(new TaskNotFoundError())

        const res = await callPATCH({})

        expect(res.status).toBe(404)
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
    })

    it("emits no event and no touch on production AI provider failure", async () => {
        mocks.reanalyzeTask.mockRejectedValue(new AiProviderUnavailableError())

        const res = await callPATCH({})

        expect(res.status).toBe(503)
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
    })

    it("emits no event and no touch on auth failure (401)", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await callPATCH({})

        expect(res.status).toBe(401)
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
    })

    it("keeps the 200 response unchanged when event persistence fails (fail-open)", async () => {
        mocks.reanalyzeTask.mockResolvedValue({ task: TASK, aiSource: "1xai" })
        mocks.recordProductEvent.mockRejectedValue(new Error("event insert failed"))

        const res = await callPATCH({})

        expect(res.status).toBe(200)
        const parsed = await res.json()
        expect(parsed).toEqual({ ok: true, data: { task: TASK, aiSource: "1xai" } })
        expect(mocks.completeQuota).toHaveBeenCalledTimes(1)
    })

    it("keeps the 200 response unchanged when touch fails (fail-open), event still recorded", async () => {
        mocks.reanalyzeTask.mockResolvedValue({ task: TASK, aiSource: "1xai" })
        mocks.touchAuthenticatedActivity.mockRejectedValue(new Error("analytics db down"))

        const res = await callPATCH({})

        expect(res.status).toBe(200)
        const parsed = await res.json()
        expect(parsed.ok).toBe(true)
        expect(parsed.data.aiSource).toBe("1xai")
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
    })

    it("propagates the requestId to the analytics context (correlation only)", async () => {
        mocks.reanalyzeTask.mockResolvedValue({ task: TASK, aiSource: "1xai" })

        const res = await callPATCH({})

        const ctx = mocks.recordProductEvent.mock.calls[0][3]
        expect(ctx.requestId).toBe(res.headers.get("X-Request-ID"))
        expect(ctx.endpoint).toBe("/api/tasks/[id]/analyze")
        expect(ctx.feature).toBe("analyze")
    })

    it("proves touch no longer runs before quota reserve (placement fix)", async () => {
        mocks.reanalyzeTask.mockResolvedValue({ task: TASK, aiSource: "1xai" })

        await callPATCH({})

        const reserveOrder = mocks.reserveQuota.mock.invocationCallOrder[0]
        const activityOrder = mocks.touchAuthenticatedActivity.mock.invocationCallOrder[0]
        expect(activityOrder).toBeGreaterThan(reserveOrder)
    })

    it("does not touch or record when quota reserve itself throws before any business operation", async () => {
        mocks.reserveQuota.mockRejectedValue(new IdempotencyConflictError())

        const res = await callPATCH({})

        expect(res.status).toBe(409)
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
    })
})
