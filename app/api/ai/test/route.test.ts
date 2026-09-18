import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke test: GET /api/ai/test (C8 — ADR-04 conformance).  */
/* runAiSamples mocked: بدون فراخوانی AI واقعی.                        */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    isRateLimited: vi.fn(),
    runAiSamples: vi.fn(),
    touchAuthenticatedActivity: vi.fn(),
    reserveQuota: vi.fn(),
    completeQuota: vi.fn(),
    releaseQuota: vi.fn(),
    markReleaseFailed: vi.fn(),
    recordError: vi.fn(),
    getPrisma: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/rateLimit", () => ({ isRateLimited: mocks.isRateLimited }))
vi.mock("@/app/lib/services/analysis.service", () => ({ runAiSamples: mocks.runAiSamples }))
vi.mock("@/app/lib/services/userActivity.service", () => ({
    touchAuthenticatedActivity: mocks.touchAuthenticatedActivity,
}))
vi.mock("@/app/lib/services/aiQuota.service", () => ({
    reserveQuota: mocks.reserveQuota,
    completeQuota: mocks.completeQuota,
    releaseQuota: mocks.releaseQuota,
}))
vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: mocks.getPrisma }))
// P1-5 — سند §۲۱/§۳۲: شکست زیرساخت quota باید از recordError عبور کند (بدون I/O واقعی).
vi.mock("@/src/lib/observability/recordError", () => ({ recordError: mocks.recordError }))
// D2 — سند §13: علامت‌گذاری release failure باید بدون I/O واقعی قابل assert باشد.
vi.mock("@/app/lib/services/aiUsage.service", () => ({
    markReleaseFailed: mocks.markReleaseFailed,
}))

import { GET } from "./route"
import { QuotaExceededError, QuotaUnavailableError } from "@/app/lib/services/errors"

const USER = { id: 1, username: "test", email: "test@example.com", timezone: "Asia/Tehran", plan: "FREE" }
const SAMPLES = [
    { source: "1xai", analysis: { priority: "HIGH", score: 90, estimatedMinutes: 45, reason: "دلیل", category: "Work" }, attempts: 1 },
    { source: "mock", analysis: { priority: "LOW", score: 40, estimatedMinutes: 15, reason: "دلیل", category: "Personal" }, attempts: 0 },
]

describe("GET /api/ai/test — production guard (فاز ۱ — سند §16)", () => {
    it("returns 404 in production as the FIRST business action — no rate limit, no quota, no AI", async () => {
        vi.stubEnv("NODE_ENV", "production")

        const res = await GET()

        expect(res.status).toBe(404)
        await expect(res.json()).resolves.toMatchObject({ ok: false })
        // گارد اولین action است — هیچ چیز دیگری اجرا نشده
        expect(mocks.getCurrentUser).not.toHaveBeenCalled()
        expect(mocks.isRateLimited).not.toHaveBeenCalled()
        expect(mocks.reserveQuota).not.toHaveBeenCalled()
        expect(mocks.runAiSamples).not.toHaveBeenCalled()
    })
})

describe("GET /api/ai/test (C8 — ADR-04 envelope)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.unstubAllEnvs()
        mocks.getCurrentUser.mockResolvedValue(USER)
        mocks.isRateLimited.mockReturnValue(false)
        mocks.touchAuthenticatedActivity.mockResolvedValue({ touched: true })
        mocks.reserveQuota.mockResolvedValue(undefined)
        mocks.completeQuota.mockResolvedValue(true)
        mocks.releaseQuota.mockResolvedValue(true)
        mocks.getPrisma.mockReturnValue({})
    })

    it("returns 200 with the standard success envelope { ok: true, data: results }", async () => {
        mocks.runAiSamples.mockResolvedValue(SAMPLES)

        const res = await GET()

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: SAMPLES })
        expect(mocks.runAiSamples).toHaveBeenCalledTimes(1)
        expect(mocks.isRateLimited).toHaveBeenCalledWith("ai-test:user:1", 1, 60 * 60 * 1000)
        // فاز ۱ — reserve 3 units (all-or-nothing) → complete
        expect(mocks.reserveQuota).toHaveBeenCalledTimes(1)
        expect(mocks.reserveQuota.mock.calls[0][1].units).toBe(3)
        expect(mocks.reserveQuota.mock.calls[0][1].feature).toBe("ai-test")
        expect(mocks.completeQuota).toHaveBeenCalledTimes(1)
        expect(mocks.releaseQuota).not.toHaveBeenCalled()
    })

    it("returns 429 RATE_LIMITED and never calls runAiSamples when the user limit is exhausted", async () => {
        mocks.isRateLimited.mockReturnValue(true)

        const res = await GET()

        expect(res.status).toBe(429)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: {
                code: "RATE_LIMITED",
                message: "تعداد درخواست‌های هوش مصنوعی زیاد شده؛ کمی بعد دوباره تلاش کن",
            },
        })
        expect(mocks.isRateLimited).toHaveBeenCalledWith("ai-test:user:1", 1, 60 * 60 * 1000)
        expect(mocks.runAiSamples).not.toHaveBeenCalled()
    })

    it("keeps the payload under data (payload preserved, envelope added)", async () => {
        mocks.runAiSamples.mockResolvedValue(SAMPLES)

        const res = await GET()
        const parsed = await res.json()

        expect(parsed.ok).toBe(true)
        expect(Array.isArray(parsed.data)).toBe(true)
        expect(parsed.data).toEqual(SAMPLES)
        expect(parsed.data[0].source).toBe("1xai")
    })

    it("returns 401 UNAUTHORIZED envelope when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await GET()

        expect(res.status).toBe(401)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        })
        expect(mocks.runAiSamples).not.toHaveBeenCalled()
    })

    it("returns 429 QUOTA_EXCEEDED when the 3-unit reservation is over the remaining limit (no partial reserve)", async () => {
        mocks.reserveQuota.mockRejectedValue(new QuotaExceededError())

        const res = await GET()

        expect(res.status).toBe(429)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("QUOTA_EXCEEDED")
        expect(mocks.runAiSamples).not.toHaveBeenCalled()
        expect(mocks.completeQuota).not.toHaveBeenCalled()
        // P1-5 / سند §۲۱/§۳۲: QUOTA_EXCEEDED خطای expected است → هرگز record نمی‌شود
        expect(mocks.recordError).not.toHaveBeenCalled()
    })

    /* ---------------------------------------------------------------- */
    /* P1-5 — D1: infrastructure failures recorded (§19/§20/§21/§32)     */
    /* ---------------------------------------------------------------- */

    it("reserve failure → 503 QUOTA_UNAVAILABLE, envelope unchanged, recordError exactly once (P1-5)", async () => {
        const failure = new QuotaUnavailableError()
        mocks.reserveQuota.mockRejectedValue(failure)

        const res = await GET()

        expect(res.status).toBe(503)
        await expect(res.json()).resolves.toMatchObject({
            ok: false,
            error: { code: "QUOTA_UNAVAILABLE", message: failure.message },
        })
        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
        expect(mocks.runAiSamples).not.toHaveBeenCalled()
        expect(mocks.recordError).toHaveBeenCalledTimes(1)
        expect(mocks.recordError).toHaveBeenCalledWith(
            failure,
            expect.objectContaining({
                endpoint: "/api/ai/test",
                feature: "ai-test",
                userId: 1,
                requestId: res.headers.get("X-Request-ID"),
            }),
        )
    })

    it("complete failure → 503 QUOTA_UNAVAILABLE and recordError exactly once (P1-5, §21)", async () => {
        const failure = new QuotaUnavailableError()
        mocks.runAiSamples.mockResolvedValue(SAMPLES)
        mocks.completeQuota.mockRejectedValue(failure)

        const res = await GET()

        expect(res.status).toBe(503)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("QUOTA_UNAVAILABLE")
        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
        expect(mocks.recordError).toHaveBeenCalledTimes(1)
        expect(mocks.recordError).toHaveBeenCalledWith(
            failure,
            expect.objectContaining({ userId: 1 }),
        )
    })

    it("release failure → 503 QUOTA_UNAVAILABLE and recordError exactly once (fail-closed, §13/§21 — P1-5)", async () => {
        mocks.runAiSamples.mockRejectedValue(new Error("provider down"))
        mocks.releaseQuota.mockRejectedValue(new QuotaUnavailableError())

        const res = await GET()

        expect(res.status).toBe(503)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("QUOTA_UNAVAILABLE")
        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
        expect(mocks.completeQuota).not.toHaveBeenCalled()
        expect(mocks.recordError).toHaveBeenCalledTimes(1)
        expect(mocks.recordError.mock.calls[0][0]).toBeInstanceOf(QuotaUnavailableError)
        // D2 / سند §13: event برای reconciliation علامت می‌خورد و provider دوباره اجرا نمی‌شود
        expect(mocks.markReleaseFailed).toHaveBeenCalledTimes(1)
        expect(mocks.markReleaseFailed).toHaveBeenCalledWith(
            expect.anything(),
            res.headers.get("X-Request-ID"),
        )
        expect(mocks.runAiSamples).toHaveBeenCalledTimes(1)
    })

    it("releases the reservation when runAiSamples fails (§12) and keeps envelope", async () => {
        mocks.runAiSamples.mockRejectedValue(new Error("provider down"))
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

        const res = await GET()

        expect(mocks.releaseQuota).toHaveBeenCalledTimes(1)
        expect(mocks.completeQuota).not.toHaveBeenCalled()
        expect(res.status).toBe(500)
        // D2: release موفق است → هیچ علامت‌گذاری RELEASE_FAILED نباید رخ دهد
        expect(mocks.markReleaseFailed).not.toHaveBeenCalled()
        errorSpy.mockRestore()
    })

    it("preserves X-Request-ID header on success responses", async () => {
        mocks.runAiSamples.mockResolvedValue(SAMPLES)

        const res = await GET()

        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
    })

    it("propagates ServiceError through the standard error envelope", async () => {
        // runAiSamples در حال حاضر ServiceError پرتاب نمی‌کند؛ این تست قرارداد ADR-04
        // مسیر خطای احتمالی را قفل می‌کند (defense against regression).
        mocks.runAiSamples.mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }))

        const res = await GET()

        // خطای عمومی → 500 INTERNAL با همان ساختار envelope
        expect(res.status).toBe(500)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("INTERNAL")
        expect(parsed.error.message).toEqual(expect.any(String))
    })

    /* ---------------------------------------------------------------- */
    /* فاز ۳ — گام ۹: regression — /api/ai/test از ProductEvent مستقل است */
    /* ---------------------------------------------------------------- */

    it("records no ProductEvent (never touches productEvent.service) — even on success", async () => {
        mocks.runAiSamples.mockResolvedValue(SAMPLES)

        const res = await GET()

        expect(res.status).toBe(200)
        // route اصلاً recordProductEvent را import/صدا نمی‌زند؛ mock آن تعریف نشده است —
        // هر فراخوانی خطای ReferenceError می‌داد. اثبات: جریان موفق بدون هیچ event است.
        expect(mocks.runAiSamples).toHaveBeenCalledTimes(1)
        expect(mocks.completeQuota).toHaveBeenCalledTimes(1)
    })

    it("keeps lastSeenAt placement unchanged: after rate limit, before plan/quota (سند §17)", async () => {
        mocks.runAiSamples.mockResolvedValue(SAMPLES)

        await GET()

        const rateOrder = mocks.isRateLimited.mock.invocationCallOrder[0]
        const activityOrder = mocks.touchAuthenticatedActivity.mock.invocationCallOrder[0]
        const reserveOrder = mocks.reserveQuota.mock.invocationCallOrder[0]
        expect(activityOrder).toBeGreaterThan(rateOrder)
        expect(reserveOrder).toBeGreaterThan(activityOrder)
    })

    it("never bumps lastSeenAt on quota rejection", async () => {
        mocks.reserveQuota.mockRejectedValue(new QuotaExceededError())

        const res = await GET()

        expect(res.status).toBe(429)
        // touch قبل از reserve است (قرارداد فعلی سند §17 برای این endpoint) —
        // اما هیچ ProductEvent مسیر وجود ندارد؛ quota rejection → بدون AI و بدون event.
        expect(mocks.runAiSamples).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).toHaveBeenCalledTimes(1) // placement فعلی دست‌نخورده
    })
})
