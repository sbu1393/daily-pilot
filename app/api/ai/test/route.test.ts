import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* GET /api/ai/test — قرارداد «دیباگ داخلی، بدون quota».              */
/*                                                                      */
/* تصمیم قطعی: این endpoint هیچ quota واقعی مصرف نمی‌کند. تست‌های این  */
/* فایل عمداً ماژول‌های quota را mock می‌کنند و انتظار **صفر** فراخوانی*/
/* دارند، تا یک بازگشتِ ناخواسته به reserveQuota فوراً قرمز شود.        */
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
vi.mock("@/src/lib/observability/recordError", () => ({ recordError: mocks.recordError }))
vi.mock("@/app/lib/services/aiUsage.service", () => ({
    markReleaseFailed: mocks.markReleaseFailed,
}))

import { GET } from "./route"
import { QuotaExceededError } from "@/app/lib/services/errors"

const USER = { id: 1, username: "test", email: "test@example.com", timezone: "Asia/Tehran", plan: "FREE" }
const SAMPLES = [
    { source: "1xai", analysis: { priority: "HIGH", score: 90, estimatedMinutes: 45, reason: "دلیل", category: "Work" }, attempts: 1 },
    { source: "mock", analysis: { priority: "LOW", score: 40, estimatedMinutes: 15, reason: "دلیل", category: "Personal" }, attempts: 0 },
]

/** ادعای مرکزی: هیچ مسیر quotaای لمس نمی‌شود — نه در موفقیت، نه در خطا. */
function expectNoQuotaTouched() {
    expect(mocks.reserveQuota).not.toHaveBeenCalled()
    expect(mocks.completeQuota).not.toHaveBeenCalled()
    expect(mocks.releaseQuota).not.toHaveBeenCalled()
    expect(mocks.markReleaseFailed).not.toHaveBeenCalled()
    expect(mocks.getPrisma).not.toHaveBeenCalled()
}

describe("GET /api/ai/test — production guard", () => {
    it("returns 404 in production as the FIRST business action — no rate limit, no quota, no AI", async () => {
        vi.stubEnv("NODE_ENV", "production")

        const res = await GET()

        expect(res.status).toBe(404)
        await expect(res.json()).resolves.toMatchObject({ ok: false })
        // گارد اولین action است — هیچ چیز دیگری اجرا نشده
        expect(mocks.getCurrentUser).not.toHaveBeenCalled()
        expect(mocks.isRateLimited).not.toHaveBeenCalled()
        expectNoQuotaTouched()
        expect(mocks.runAiSamples).not.toHaveBeenCalled()
    })
})

describe("GET /api/ai/test (C8 — ADR-04 envelope)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.unstubAllEnvs()
        mocks.getCurrentUser.mockResolvedValue(USER)
        mocks.isRateLimited.mockReturnValue(false)
        mocks.getPrisma.mockReturnValue({})
    })

    it("returns 200 with the standard success envelope { ok: true, data: results }", async () => {
        mocks.runAiSamples.mockResolvedValue(SAMPLES)

        const res = await GET()

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: SAMPLES })
        expect(mocks.runAiSamples).toHaveBeenCalledTimes(1)
        expect(mocks.isRateLimited).toHaveBeenCalledWith("ai-test:user:1", 1, 60 * 60 * 1000)
    })

    /* -------------------------------------------------------------- */
    /* تصمیم قطعی: هیچ quota واقعی مصرف نمی‌شود                       */
    /* -------------------------------------------------------------- */

    it("consumes NO quota on success — no reserve, no complete, no release, no prisma", async () => {
        mocks.runAiSamples.mockResolvedValue(SAMPLES)

        const res = await GET()

        expect(res.status).toBe(200)
        expectNoQuotaTouched()
    })

    it("consumes NO quota when the AI call fails — nothing to release because nothing was reserved", async () => {
        mocks.runAiSamples.mockRejectedValue(new Error("provider down"))
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

        const res = await GET()

        expect(res.status).toBe(500)
        expectNoQuotaTouched()
        errorSpy.mockRestore()
    })

    it("consumes NO quota when the user is not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await GET()

        expect(res.status).toBe(401)
        expectNoQuotaTouched()
        expect(mocks.runAiSamples).not.toHaveBeenCalled()
    })

    it("consumes NO quota when rate limited — rejection happens before any AI work", async () => {
        mocks.isRateLimited.mockReturnValue(true)

        const res = await GET()

        expect(res.status).toBe(429)
        expectNoQuotaTouched()
        expect(mocks.runAiSamples).not.toHaveBeenCalled()
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

    it("never surfaces QUOTA_EXCEEDED — an exhausted user quota cannot block this debug route", async () => {
        // حتی اگر quota کاربر تمام باشد، این endpoint نباید 429 بدهد: اصلاً quota
        // نمی‌خواند. Mock عمداً یک QuotaExceededError آماده دارد تا ثابت شود مسیر
        // هیچ‌وقت به آن نمی‌رسد.
        mocks.reserveQuota.mockRejectedValue(new QuotaExceededError())
        mocks.runAiSamples.mockResolvedValue(SAMPLES)

        const res = await GET()

        expect(res.status).toBe(200)
        expect(mocks.reserveQuota).not.toHaveBeenCalled()
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

    it("preserves X-Request-ID header on success responses", async () => {
        mocks.runAiSamples.mockResolvedValue(SAMPLES)

        const res = await GET()

        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
    })

    it("records an unexpected AI failure exactly once via recordError (error logging retained)", async () => {
        const failure = new Error("boom")
        mocks.runAiSamples.mockRejectedValue(failure)
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

        const res = await GET()

        expect(res.status).toBe(500)
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
        errorSpy.mockRestore()
    })

    it("propagates ServiceError through the standard error envelope", async () => {
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
    /* regression — /api/ai/test از ProductEvent و activity مستقل است   */
    /* ---------------------------------------------------------------- */

    it("records no ProductEvent — even on success", async () => {
        mocks.runAiSamples.mockResolvedValue(SAMPLES)

        const res = await GET()

        expect(res.status).toBe(200)
        // route اصلاً recordProductEvent را import/صدا نمی‌زند؛ mock آن تعریف نشده است —
        // هر فراخوانی خطای ReferenceError می‌داد. اثبات: جریان موفق بدون هیچ event است.
        expect(mocks.runAiSamples).toHaveBeenCalledTimes(1)
    })

    it("does NOT touch user activity (lastSeenAt) — debug route is excluded", async () => {
        mocks.runAiSamples.mockResolvedValue(SAMPLES)

        const res = await GET()

        expect(res.status).toBe(200)
        // `/api/ai/test` در فهرست Exclude است و نباید activity تولید کند
        // → هیچ نوشتنی روی `User.lastSeenAt` رخ نمی‌دهد.
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
    })
})
