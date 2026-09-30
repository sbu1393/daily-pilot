import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* Phase 4 — wiring اختصاصی `plan` به مسیر مرکزی quota.                 */
/*                                                                      */
/* تمرکز روی چیزی که در `plan` متفاوت از `analyze` است:                */
/*   • `execute` شامل validate + build + گارد schema است، پس هر شکستِ    */
/*     پس از AI هم **قبل از complete** رزرو را آزاد می‌کند.              */
/*   • قرارداد `failureCode` فرق دارد: شکست اعتبارسنجیِ AI هم           */
/*     `AI_PLAN_INVALID` ثبت می‌شود (در `analyze` فقط provider).        */
/*   • `plan/apply` اصلاً در این مسیر نیست و quota مصرف نمی‌کند.          */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    getPrisma: vi.fn(),
    isRateLimited: vi.fn(),
    getCanonicalToday: vi.fn(),
    getPlanGenerationContext: vi.fn(),
    analyzeBatchPlan: vi.fn(),
    recordError: vi.fn(),

    readCutoverAt: vi.fn(),
    reserveQuota: vi.fn(),
    completeQuota: vi.fn(),
    releaseQuota: vi.fn(),
    reserveBucketQuota: vi.fn(),
    completeBucketQuota: vi.fn(),
    releaseBucketQuota: vi.fn(),
    markReleaseFailed: vi.fn(),
    recordProviderOutcome: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: mocks.getPrisma }))
vi.mock("@/app/lib/rateLimit", () => ({ isRateLimited: mocks.isRateLimited }))
vi.mock("@/app/lib/services/plan.service", () => ({
    getPlanGenerationContext: mocks.getPlanGenerationContext,
}))
vi.mock("@/app/lib/ai/analyzeBatchPlan", () => ({ analyzeBatchPlan: mocks.analyzeBatchPlan }))
vi.mock("@/src/lib/observability/recordError", () => ({ recordError: mocks.recordError }))
vi.mock("@/app/lib/canonicalDay", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/canonicalDay")>()),
    getCanonicalToday: mocks.getCanonicalToday,
}))

vi.mock("@/app/lib/services/aiQuotaCutover.service", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/services/aiQuotaCutover.service")>()),
    readCutoverAt: mocks.readCutoverAt,
}))
vi.mock("@/app/lib/services/aiQuota.service", () => ({
    reserveQuota: mocks.reserveQuota,
    completeQuota: mocks.completeQuota,
    releaseQuota: mocks.releaseQuota,
}))
vi.mock("@/app/lib/services/aiQuotaV2.service", () => ({
    reserveBucketQuota: mocks.reserveBucketQuota,
    completeBucketQuota: mocks.completeBucketQuota,
    releaseBucketQuota: mocks.releaseBucketQuota,
}))
vi.mock("@/app/lib/services/aiUsage.service", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/services/aiUsage.service")>()),
    markReleaseFailed: mocks.markReleaseFailed,
    recordProviderOutcome: mocks.recordProviderOutcome,
}))

import { POST } from "./route"
import {
    AiPlanInvalidError,
    AiProviderUnavailableError,
    QuotaExceededError,
    QuotaUnavailableError,
} from "@/app/lib/services/errors"

const USER = { id: 1, username: "test", email: "t@e.com", timezone: "UTC", plan: "FREE" }
const DAY_KEY = "2026-09-15"

const CTX = {
    planVersion: 3,
    rebalancedVersion: 2,
    availableMinutes: 120,
    input: {
        dayKey: DAY_KEY,
        availableMinutes: 120,
        tasks: [
            { taskId: 1, title: "گزارش فروش" },
            { taskId: 2, title: "خرید نان" },
        ],
    },
    suggestionTasks: [
        { id: 1, estimatedTime: null, score: null, priority: null, status: "TODO", allocatedMinutes: null },
        { id: 2, estimatedTime: null, score: null, priority: null, status: "TODO", allocatedMinutes: null },
    ],
}

const AI_PLAN = {
    items: [
        { taskId: 1, estimatedMinutes: 30, score: 70, priority: "HIGH", order: 2, reason: "الف" },
        { taskId: 2, estimatedMinutes: 20, score: 40, priority: "LOW", order: 1, reason: "ب" },
    ],
    summary: "یک روز سبک",
}

function bucketResult(overrides: Record<string, unknown> = {}) {
    return {
        quotaSource: "BASE",
        bucketId: 42,
        periodStart: new Date("2026-09-01T00:00:00.000Z"),
        policyAllowedUnits: 2,
        ...overrides,
    }
}

const callPOST = () =>
    POST(
        new NextRequest("http://localhost/api/planner/plan", {
            method: "POST",
            body: JSON.stringify({ dayKey: DAY_KEY }),
        }),
    )

beforeEach(() => {
    vi.clearAllMocks()
    mocks.getCurrentUser.mockResolvedValue(USER)
    mocks.getPrisma.mockReturnValue({})
    mocks.isRateLimited.mockReturnValue(false)
    mocks.getCanonicalToday.mockReturnValue(DAY_KEY)
    mocks.getPlanGenerationContext.mockResolvedValue(CTX)
    mocks.analyzeBatchPlan.mockResolvedValue({ source: "1xai", plan: AI_PLAN, attempts: 1 })
    mocks.recordError.mockResolvedValue(undefined)
    mocks.recordProviderOutcome.mockResolvedValue(true)

    mocks.readCutoverAt.mockResolvedValue(new Date("2026-10-01T00:00:00.000Z"))
    mocks.reserveQuota.mockResolvedValue({
        quotaSource: "BASE",
        bucketId: null,
    })
    mocks.completeQuota.mockResolvedValue(true)
    mocks.releaseQuota.mockResolvedValue(true)
    mocks.reserveBucketQuota.mockResolvedValue(bucketResult())
    mocks.completeBucketQuota.mockResolvedValue(true)
    mocks.releaseBucketQuota.mockResolvedValue(true)
    mocks.markReleaseFailed.mockResolvedValue(true)
})

describe("plan — lifecycle از مسیر مرکزی (Phase 4)", () => {
    it("موفقیت ⇒ دقیقاً یک واحد منطقی (نه per-task)", async () => {
        const res = await callPOST()

        expect(res.status).toBe(200)
        expect(mocks.reserveQuota).toHaveBeenCalledTimes(1)
        // ورودی ۲ تسک دارد، ولی هزینه ۱ است
        expect(mocks.reserveQuota.mock.calls[0][1]).toMatchObject({
            units: 1,
            feature: "plan",
        })
        expect(mocks.completeQuota).toHaveBeenCalledTimes(1)
        expect(mocks.releaseQuota).not.toHaveBeenCalled()
    })

    it("هزینه از جدول بستهٔ فیچر می‌آید، نه از route", async () => {
        await callPOST()

        // `resolveFeatureUnits` دیگر در route نیست؛ واحد از AI_FEATURE_SPECS می‌آید
        expect(mocks.reserveQuota.mock.calls[0][1].units).toBe(1)
    })

    it("quota exhausted ⇒ provider اصلاً صدا زده نمی‌شود", async () => {
        mocks.reserveQuota.mockRejectedValue(new QuotaExceededError())

        const res = await callPOST()

        expect(res.status).toBe(429)
        expect((await res.json()).error.code).toBe("QUOTA_EXCEEDED")
        expect(mocks.analyzeBatchPlan).not.toHaveBeenCalled()
    })

    it("شکست reservation ⇒ provider صدا زده نمی‌شود، fail-closed", async () => {
        mocks.reserveQuota.mockRejectedValue(new QuotaUnavailableError())

        const res = await callPOST()

        expect(res.status).toBe(503)
        expect(mocks.analyzeBatchPlan).not.toHaveBeenCalled()
        expect(mocks.completeQuota).not.toHaveBeenCalled()
    })

    it("هیچ provider call پیش از reservation رخ نمی‌دهد", async () => {
        await callPOST()

        expect(mocks.reserveQuota.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.analyzeBatchPlan.mock.invocationCallOrder[0],
        )
    })

    it("شکست AI ⇒ رزرو آزاد با failureCode مخصوص provider", async () => {
        mocks.analyzeBatchPlan.mockRejectedValue(new AiProviderUnavailableError())

        const res = await callPOST()

        expect(res.status).toBe(503)
        expect((await res.json()).error.code).toBe("AI_PROVIDER_UNAVAILABLE")
        expect(mocks.releaseQuota).toHaveBeenCalledTimes(1)
        expect(mocks.releaseQuota.mock.calls[0][3]).toMatchObject({
            failureCode: "AI_PROVIDER_UNAVAILABLE",
        })
    })

    it("خروجی نامعتبر AI ⇒ آزادسازی با AI_PLAN_INVALID (قرارداد خاص plan)", async () => {
        // taskIdای که در ورودی نبود ⇒ validateBatchPlan ایراد می‌دهد
        mocks.analyzeBatchPlan.mockResolvedValue({
            source: "1xai",
            plan: { items: [{ taskId: 999, estimatedMinutes: 30, score: 50, priority: "LOW", order: 1, reason: "الف" }] },
            attempts: 1,
        })

        const res = await callPOST()

        expect(res.status).toBe(502)
        expect((await res.json()).error.code).toBe("AI_PLAN_INVALID")
        expect(mocks.releaseQuota).toHaveBeenCalledTimes(1)
        expect(mocks.releaseQuota.mock.calls[0][3]).toMatchObject({
            failureCode: "AI_PLAN_INVALID",
        })
        // حیاتی: complete رخ نمی‌دهد، پس سهمیه‌ای مصرف نشده است
        expect(mocks.completeQuota).not.toHaveBeenCalled()
    })

    it("شکست release ⇒ markReleaseFailed + ۵۰۳", async () => {
        mocks.analyzeBatchPlan.mockRejectedValue(new AiProviderUnavailableError())
        mocks.releaseQuota.mockRejectedValue(new QuotaUnavailableError())

        const res = await callPOST()

        expect(res.status).toBe(503)
        expect(mocks.markReleaseFailed).toHaveBeenCalledTimes(1)
        expect(mocks.completeQuota).not.toHaveBeenCalled()
    })

    it("شکست AI فقط یک‌بار ثبت می‌شود (نه دوبار در catch بیرونی)", async () => {
        mocks.analyzeBatchPlan.mockRejectedValue(new AiProviderUnavailableError())

        await callPOST()

        expect(mocks.recordError).toHaveBeenCalledTimes(1)
        expect(mocks.recordError.mock.calls[0][0]).toBeInstanceOf(AiProviderUnavailableError)
    })

    it("AiPlanInvalidError فقط یک‌بار ثبت می‌شود", async () => {
        mocks.analyzeBatchPlan.mockResolvedValue({
            source: "1xai",
            plan: { items: [] },
            attempts: 1,
        })

        await callPOST()

        expect(mocks.recordError).toHaveBeenCalledTimes(1)
        expect(mocks.recordError.mock.calls[0][0]).toBeInstanceOf(AiPlanInvalidError)
    })
})

describe("plan — یک واحد منطقی، چند provider call", () => {
    it("fallback با چند تلاش ⇒ یک واحد quota، ولی attempts کامل ثبت می‌شود", async () => {
        mocks.analyzeBatchPlan.mockResolvedValue({
            source: "1xai",
            plan: AI_PLAN,
            attempts: 3,
            aiProvider: "1xai",
            fallbackUsed: true,
            aiTelemetry: { durationMs: 5000, attempts: 3 },
        })

        const res = await callPOST()

        expect(res.status).toBe(200)
        expect(mocks.reserveQuota).toHaveBeenCalledTimes(1)
        expect(mocks.reserveQuota.mock.calls[0][1].units).toBe(1)
        expect(mocks.completeQuota.mock.calls[0][4]).toMatchObject({ attempts: 3 })
        expect(mocks.recordProviderOutcome.mock.calls[0][2]).toMatchObject({
            provider: "1xai",
            fallbackUsed: true,
        })
    })

    it("خروجی mock ⇒ provider outcome ثبت نمی‌شود", async () => {
        mocks.analyzeBatchPlan.mockResolvedValue({ source: "mock", plan: AI_PLAN, attempts: 0 })

        const res = await callPOST()

        expect(res.status).toBe(200)
        expect(mocks.recordProviderOutcome).not.toHaveBeenCalled()
    })
})

describe("plan — دورهٔ LEGACY در برابر V2", () => {
    it("cutover در آینده ⇒ مسیر legacy", async () => {
        await callPOST()

        expect(mocks.reserveQuota).toHaveBeenCalledTimes(1)
        expect(mocks.reserveBucketQuota).not.toHaveBeenCalled()
    })

    it("cutover گذشته ⇒ مسیر V2 با بُعد PLAN", async () => {
        mocks.readCutoverAt.mockResolvedValue(new Date("2026-01-01T00:00:00.000Z"))

        const res = await callPOST()

        expect(res.status).toBe(200)
        expect(mocks.reserveBucketQuota).toHaveBeenCalledTimes(1)
        expect(mocks.reserveBucketQuota.mock.calls[0][1]).toMatchObject({
            feature: "PLAN",
            units: 1,
            multiUnit: false,
        })
        expect(mocks.reserveQuota).not.toHaveBeenCalled()
    })

    it("رزرو PROMO ⇒ source از خودِ ledger خوانده می‌شود", async () => {
        mocks.readCutoverAt.mockResolvedValue(new Date("2026-01-01T00:00:00.000Z"))
        mocks.reserveBucketQuota.mockResolvedValue(
            bucketResult({ quotaSource: "PROMO", bucketId: 11 }),
        )

        const res = await callPOST()

        expect(res.status).toBe(200)
        expect(mocks.completeBucketQuota).toHaveBeenCalledTimes(1)
    })

    it("V2: شکست AI ⇒ release روی همان مسیر، بدون دست‌زدن به ledger قدیمی", async () => {
        mocks.readCutoverAt.mockResolvedValue(new Date("2026-01-01T00:00:00.000Z"))
        mocks.analyzeBatchPlan.mockRejectedValue(new AiProviderUnavailableError())

        const res = await callPOST()

        expect(res.status).toBe(503)
        expect(mocks.releaseBucketQuota).toHaveBeenCalledTimes(1)
        expect(mocks.releaseQuota).not.toHaveBeenCalled()
    })

    it("V2: خروجی نامعتبر AI هم رزرو را آزاد می‌کند (نه اینکه مصرف شود)", async () => {
        mocks.readCutoverAt.mockResolvedValue(new Date("2026-01-01T00:00:00.000Z"))
        mocks.analyzeBatchPlan.mockResolvedValue({ source: "1xai", plan: { items: [] }, attempts: 1 })

        const res = await callPOST()

        expect(res.status).toBe(502)
        expect(mocks.releaseBucketQuota).toHaveBeenCalledTimes(1)
        expect(mocks.completeBucketQuota).not.toHaveBeenCalled()
    })
})

describe("plan — plan/apply بی‌خطر از نظر quota", () => {
    it("apply هیچ quota مصرف نمی‌کند (جدا از مسیر generate)", async () => {
        const { POST: APPLY } = await import("../plan/apply/route")

        await APPLY(
            new NextRequest("http://localhost/api/planner/plan/apply", {
                method: "POST",
                body: JSON.stringify({
                    dayKey: DAY_KEY,
                    items: [{ taskId: 1, estimatedMinutes: 30 }],
                }),
            }),
        )

        // هیچ‌کدام از سرویس‌های quota صدا زده نشد — Apply یک عملیات قطعی است
        expect(mocks.reserveQuota).not.toHaveBeenCalled()
        expect(mocks.completeQuota).not.toHaveBeenCalled()
        expect(mocks.releaseQuota).not.toHaveBeenCalled()
        expect(mocks.reserveBucketQuota).not.toHaveBeenCalled()
        expect(mocks.analyzeBatchPlan).not.toHaveBeenCalled()
    })
})
