import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* Phase 4 — wiring اختصاصی `analyze` به مسیر مرکزی quota.             */
/*                                                                      */
/* فایل `route.test.ts` قراردادهای قدیمیِ route را قفل می‌کند (که هنوز  */
/* معتبرند). این فایل چیزهایی را قفل می‌کند که **تازه** با wiring ساخته  */
/* شده‌اند:                                                            */
/*   • reserve از جدول بستهٔ فیچر می‌آید (نه از route).                 */
/*   • provider **هیچ‌وقت** قبل از reservation صدا زده نمی‌شود.         */
/*   • یک درخواست = دقیقاً یک واحد منطقی، حتی با retry/fallback.        */
/*   • مسیر LEGACY و مسیر V2 (PROMO و BASE) هر دو کار می‌کنند.         */
/*                                                                      */
/* سرویس‌های quota از پایین mock می‌شوند تا `runAiOperation` واقعاً      */
/* اجرا شود — در غیر این صورت تست، خودِ سرویس را mock کرده و هیچی را    */
/* دربارهٔ wiring ثابت نمی‌کند.                                          */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    isRateLimited: vi.fn(),
    reanalyzeTask: vi.fn(),
    touchAuthenticatedActivity: vi.fn(),
    recordProductEvent: vi.fn(),
    recordError: vi.fn(),
    getPrisma: vi.fn(),

    // cutover
    readCutoverAt: vi.fn(),

    // legacy ledger
    reserveQuota: vi.fn(),
    completeQuota: vi.fn(),
    releaseQuota: vi.fn(),

    // v2 ledger
    reserveBucketQuota: vi.fn(),
    completeBucketQuota: vi.fn(),
    releaseBucketQuota: vi.fn(),

    markReleaseFailed: vi.fn(),
    recordProviderOutcome: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/rateLimit", () => ({ isRateLimited: mocks.isRateLimited }))
vi.mock("@/app/lib/services/tasks.service", () => ({ reanalyzeTask: mocks.reanalyzeTask }))
vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: mocks.getPrisma }))
vi.mock("@/app/lib/services/userActivity.service", () => ({
    touchAuthenticatedActivity: mocks.touchAuthenticatedActivity,
}))
vi.mock("@/app/lib/services/productEvent.service", () => ({
    recordProductEvent: mocks.recordProductEvent,
}))
vi.mock("@/src/lib/observability/recordError", () => ({ recordError: mocks.recordError }))

// قاعدهٔ تصمیم LEGACY/NEW واقعی می‌ماند؛ فقط خواندن cutover از DB mock است.
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

import { PATCH } from "./route"
import {
    AiProviderUnavailableError,
    QuotaExceededError,
    QuotaUnavailableError,
} from "@/app/lib/services/errors"

const USER = { id: 1, username: "test", email: "t@e.com", timezone: "UTC", plan: "FREE" }
const PRO_USER = { ...USER, plan: "PRO" }
const TASK = { id: 5, text: "گزارش", dayKey: "2026-01-01", status: "TODO" }

/** یک واحد رزروشده در ledger جدید. */
function bucketResult(overrides: Record<string, unknown> = {}) {
    return {
        quotaSource: "BASE",
        bucketId: 42,
        periodStart: new Date("2026-09-01T00:00:00.000Z"),
        policyAllowedUnits: 15,
        ...overrides,
    }
}

const callPATCH = (body: unknown = {}) =>
    PATCH(
        new NextRequest("http://localhost/api/tasks/5/analyze", {
            method: "PATCH",
            body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: "5" }) },
    )

beforeEach(() => {
    vi.clearAllMocks()
    mocks.getCurrentUser.mockResolvedValue(USER)
    mocks.isRateLimited.mockReturnValue(false)
    mocks.getPrisma.mockReturnValue({})
    mocks.touchAuthenticatedActivity.mockResolvedValue({ touched: true })
    mocks.recordProductEvent.mockResolvedValue({ recorded: true })
    mocks.recordError.mockResolvedValue(undefined)
    mocks.reanalyzeTask.mockResolvedValue({ task: TASK, aiSource: "1xai" })
    mocks.recordProviderOutcome.mockResolvedValue(true)

    // پیش‌فرض: cutover در آینده ⇒ دورهٔ جاری LEGACY است
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

describe("analyze — lifecycle از مسیر مرکزی (Phase 4)", () => {
    it("موفقیت ⇒ دقیقاً یک واحد منطقی مصرف می‌شود", async () => {
        const res = await callPATCH()

        expect(res.status).toBe(200)
        expect(mocks.reserveQuota).toHaveBeenCalledTimes(1)
        // واحد از جدول بستهٔ فیچر می‌آید، نه از route
        expect(mocks.reserveQuota.mock.calls[0][1]).toMatchObject({
            units: 1,
            feature: "analyze",
        })
        expect(mocks.completeQuota).toHaveBeenCalledTimes(1)
        expect(mocks.releaseQuota).not.toHaveBeenCalled()
    })

    it("هزینه از جدول فیچر می‌آید، پس route نمی‌تواند آن را تحمیل کند", async () => {
        await callPATCH()

        const arg = mocks.reserveQuota.mock.calls[0][1]
        // `AI_FEATURE_SPECS.analyze` = { dimension: "ANALYZE", units: 1, multiUnit: false }
        expect(arg.units).toBe(1)
        expect(arg.feature).toBe("analyze")
    })

    it("quota exhausted ⇒ provider اصلاً صدا زده نمی‌شود", async () => {
        mocks.reserveQuota.mockRejectedValue(new QuotaExceededError())

        const res = await callPATCH()

        expect(res.status).toBe(429)
        expect((await res.json()).error.code).toBe("QUOTA_EXCEEDED")
        expect(mocks.reanalyzeTask).not.toHaveBeenCalled()
        expect(mocks.completeQuota).not.toHaveBeenCalled()
    })

    it("شکست reservation (زیرساخت) ⇒ provider صدا زده نمی‌شود و ۵۰۳ fail-closed است", async () => {
        mocks.reserveQuota.mockRejectedValue(new QuotaUnavailableError())

        const res = await callPATCH()

        expect(res.status).toBe(503)
        expect((await res.json()).error.code).toBe("QUOTA_UNAVAILABLE")
        expect(mocks.reanalyzeTask).not.toHaveBeenCalled()
        // مصرف جعلی quota رخ نمی‌دهد چون اصلاً رزروی ساخته نشده
        expect(mocks.completeQuota).not.toHaveBeenCalled()
        expect(mocks.releaseQuota).not.toHaveBeenCalled()
    })

    it("هیچ provider call پیش از reservation رخ نمی‌دهد (ترتیب قفل‌شده)", async () => {
        await callPATCH()

        const reserveOrder = mocks.reserveQuota.mock.invocationCallOrder[0]
        const aiOrder = mocks.reanalyzeTask.mock.invocationCallOrder[0]
        expect(reserveOrder).toBeLessThan(aiOrder)
    })

    it("شکست AI ⇒ رزرو آزاد می‌شود و خطای اصلی حفظ می‌شود", async () => {
        const failure = new AiProviderUnavailableError()
        mocks.reanalyzeTask.mockRejectedValue(failure)

        const res = await callPATCH()

        expect(res.status).toBe(503)
        expect((await res.json()).error.code).toBe("AI_PROVIDER_UNAVAILABLE")
        expect(mocks.releaseQuota).toHaveBeenCalledTimes(1)
        expect(mocks.completeQuota).not.toHaveBeenCalled()
        // شکست provider برچسب failureCode می‌گیرد
        expect(mocks.releaseQuota.mock.calls[0][3]).toMatchObject({
            failureCode: "AI_PROVIDER_UNAVAILABLE",
        })
    })

    it("خطای دامنه‌ای (نه provider) ⇒ بدون failureCode آزاد می‌شود", async () => {
        const { TaskNotFoundError } = await import("@/app/lib/services/errors")
        mocks.reanalyzeTask.mockRejectedValue(new TaskNotFoundError())

        const res = await callPATCH()

        expect(res.status).toBe(404)
        expect(mocks.releaseQuota).toHaveBeenCalledTimes(1)
        // قرارداد پیشین analyze حفظ است: فقط شکست provider برچسب می‌گیرد
        expect(mocks.releaseQuota.mock.calls[0][3].failureCode).toBeUndefined()
    })

    it("شکست release ⇒ markReleaseFailed + ۵۰۳ (سهمیه silently گم نمی‌شود)", async () => {
        mocks.reanalyzeTask.mockRejectedValue(new AiProviderUnavailableError())
        mocks.releaseQuota.mockRejectedValue(new QuotaUnavailableError())

        const res = await callPATCH()

        expect(res.status).toBe(503)
        expect((await res.json()).error.code).toBe("QUOTA_UNAVAILABLE")
        expect(mocks.markReleaseFailed).toHaveBeenCalledTimes(1)
        expect(mocks.recordError).toHaveBeenCalledTimes(1)
        expect(mocks.recordError.mock.calls[0][0]).toBeInstanceOf(QuotaUnavailableError)
    })

    it("شکست release در مسیر V2 هم fail-closed و علامت‌گذاری می‌شود", async () => {
        mocks.readCutoverAt.mockResolvedValue(new Date("2026-01-01T00:00:00.000Z"))
        mocks.reanalyzeTask.mockRejectedValue(new AiProviderUnavailableError())
        mocks.releaseBucketQuota.mockRejectedValue(new QuotaUnavailableError())

        const res = await callPATCH()

        expect(res.status).toBe(503)
        expect(mocks.markReleaseFailed).toHaveBeenCalledTimes(1)
        expect(mocks.releaseQuota).not.toHaveBeenCalled()
    })
})

describe("analyze — یک واحد منطقی، چند provider call (retry/fallback)", () => {
    /**
     * سناریوی fallback چند call واقعی دارد ولی باید یک واحد مصرف کند.
     * `reanalyzeTask` تنها proxy قابل مشاهده از route است، پس آن را با
     * telemetry/attempts چندگانه برمی‌گردانیم — همان چیزی که providerClient
     * بعد از چند تلاش تحویل می‌دهد.
     */
    it("fallback با ۳ provider call ⇒ باز هم یک واحد quota", async () => {
        mocks.reanalyzeTask.mockResolvedValue({
            task: TASK,
            aiSource: "1xai",
            aiProvider: "1xai",
            fallbackUsed: true,
            aiTelemetry: { durationMs: 4200, attempts: 3 },
        })

        const res = await callPATCH()

        expect(res.status).toBe(200)
        // reserve یک‌بار با units=1 — retry/fallback هیچ واحد اضافه‌ای نمی‌گیرد
        expect(mocks.reserveQuota).toHaveBeenCalledTimes(1)
        expect(mocks.reserveQuota.mock.calls[0][1].units).toBe(1)
        expect(mocks.completeQuota).toHaveBeenCalledTimes(1)
        // ولی شمارندهٔ تلاش‌ها کامل ثبت می‌شود: ۳ تلاش، یک رزرو
        expect(mocks.completeQuota.mock.calls[0][4]).toMatchObject({ attempts: 3 })
        expect(mocks.recordProviderOutcome).toHaveBeenCalledTimes(1)
        expect(mocks.recordProviderOutcome.mock.calls[0][2]).toMatchObject({
            provider: "1xai",
            fallbackUsed: true,
        })
    })

    it("بدون fallback ⇒ provider واقعی ثبت می‌شود", async () => {
        mocks.reanalyzeTask.mockResolvedValue({
            task: TASK,
            aiSource: "1xai",
            aiProvider: "openrouter",
            fallbackUsed: false,
        })

        await callPATCH()

        expect(mocks.recordProviderOutcome).toHaveBeenCalledWith(
            expect.anything(),
            expect.any(String),
            { provider: "openrouter", fallbackUsed: false },
        )
    })

    it("خروجی mock ⇒ هیچ provider outcome ثبت نمی‌شود (ادعای نادرست ثبت نشود)", async () => {
        mocks.reanalyzeTask.mockResolvedValue({ task: TASK, aiSource: "mock" })

        const res = await callPATCH()

        expect(res.status).toBe(200)
        expect(mocks.recordProviderOutcome).not.toHaveBeenCalled()
    })
})

describe("analyze — دورهٔ LEGACY در برابر V2", () => {
    it("cutover در آینده ⇒ مسیر legacy (`AiUsage`) و بدون bucket", async () => {
        mocks.readCutoverAt.mockResolvedValue(new Date("2026-10-01T00:00:00.000Z"))

        await callPATCH()

        expect(mocks.reserveQuota).toHaveBeenCalledTimes(1)
        expect(mocks.reserveBucketQuota).not.toHaveBeenCalled()
    })

    it("cutover گذشته ⇒ مسیر V2 (`AiQuotaBucket`)", async () => {
        mocks.readCutoverAt.mockResolvedValue(new Date("2026-01-01T00:00:00.000Z"))

        const res = await callPATCH()

        expect(res.status).toBe(200)
        expect(mocks.reserveBucketQuota).toHaveBeenCalledTimes(1)
        expect(mocks.reserveBucketQuota.mock.calls[0][1]).toMatchObject({
            units: 1,
            feature: "ANALYZE", // بُعد، نه نام فیچر
        })
        expect(mocks.completeBucketQuota).toHaveBeenCalledTimes(1)
        expect(mocks.reserveQuota).not.toHaveBeenCalled()
    })

    it("رزرو PROMO ⇒ source و bucket همان چیزی است که ledger برگرداند", async () => {
        mocks.readCutoverAt.mockResolvedValue(new Date("2026-01-01T00:00:00.000Z"))
        mocks.reserveBucketQuota.mockResolvedValue(
            bucketResult({ quotaSource: "PROMO", bucketId: 7, policyAllowedUnits: 15 }),
        )

        await callPATCH()

        // complete دقیقاً روی همان رزرو می‌نشیند و خودش bucket را از رویداد می‌خواند
        expect(mocks.reserveBucketQuota.mock.calls[0][1]).toMatchObject({
            feature: "ANALYZE",
            units: 1,
            multiUnit: false,
        })
        expect(mocks.completeBucketQuota.mock.calls[0][1]).toEqual(
            expect.any(String), // requestId
        )
    })

    it("رزرو BASE ⇒ همان قرارداد، فقط منبع متفاوت", async () => {
        mocks.readCutoverAt.mockResolvedValue(new Date("2026-01-01T00:00:00.000Z"))
        mocks.reserveBucketQuota.mockResolvedValue(bucketResult({ quotaSource: "BASE", bucketId: 9 }))

        await callPATCH()

        expect(mocks.reserveBucketQuota.mock.calls[0][1]).toMatchObject({
            feature: "ANALYZE",
            units: 1,
        })
    })

    it("V2: quota exhausted ⇒ باز هم provider صدا زده نمی‌شود", async () => {
        mocks.readCutoverAt.mockResolvedValue(new Date("2026-01-01T00:00:00.000Z"))
        mocks.reserveBucketQuota.mockRejectedValue(new QuotaExceededError())

        const res = await callPATCH()

        expect(res.status).toBe(429)
        expect(mocks.reanalyzeTask).not.toHaveBeenCalled()
    })

    it("V2: شکست AI ⇒ release روی همان مسیر، بدون دست‌زدن به ledger قدیمی", async () => {
        mocks.readCutoverAt.mockResolvedValue(new Date("2026-01-01T00:00:00.000Z"))
        mocks.reanalyzeTask.mockRejectedValue(new AiProviderUnavailableError())

        const res = await callPATCH()

        expect(res.status).toBe(503)
        expect(mocks.releaseBucketQuota).toHaveBeenCalledTimes(1)
        expect(mocks.releaseQuota).not.toHaveBeenCalled()
    })
})

describe("analyze — plan کاربر و سقف از policy می‌آید، نه از route", () => {
    it("مسیر legacy: plan از session می‌رود و سقف از سرویس policy خوانده می‌شود", async () => {
        mocks.getCurrentUser.mockResolvedValue(PRO_USER)

        await callPATCH()

        // plan از session عبور می‌کند و سقف را سرویس تعیین می‌کند؛ route عددی
        // در دست ندارد که بتواند آن را تحمیل کند.
        expect(mocks.reserveQuota.mock.calls[0][1]).toMatchObject({ units: 1 })
        expect(mocks.reserveQuota.mock.calls[0][1].allowedUnits).toBeGreaterThan(15)
    })

    it("مسیر V2: plan به ledger جدید داده می‌شود تا سقف از جدول policy بخواند", async () => {
        mocks.getCurrentUser.mockResolvedValue(PRO_USER)
        mocks.readCutoverAt.mockResolvedValue(new Date("2026-01-01T00:00:00.000Z"))

        await callPATCH()

        // در V2 خودِ `reserveBucketQuota` سقف را از `AiQuotaPolicy` می‌خواند؛
        // پس route فقط `plan` را می‌دهد و هیچ سقفی در اختیار ندارد.
        const arg = mocks.reserveBucketQuota.mock.calls[0][1]
        expect(arg.plan).toBe("PRO")
        expect(arg).not.toHaveProperty("allowedUnits")
    })

    it("FREE و PRO از هم تفکیک می‌شوند (اشتباه‌گیری plan رخ نمی‌دهد)", async () => {
        mocks.getCurrentUser.mockResolvedValue(USER)
        await callPATCH()
        const freeCap = mocks.reserveQuota.mock.calls[0][1].allowedUnits

        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(PRO_USER)
        mocks.reanalyzeTask.mockResolvedValue({ task: TASK, aiSource: "1xai" })
        mocks.reserveQuota.mockResolvedValue({
        quotaSource: "BASE",
        bucketId: null,
    })
        mocks.completeQuota.mockResolvedValue(true)
        mocks.readCutoverAt.mockResolvedValue(new Date("2026-10-01T00:00:00.000Z"))
        await callPATCH()
        const proCap = mocks.reserveQuota.mock.calls[0][1].allowedUnits

        expect(freeCap).toBe(15)
        expect(proCap).toBe(300)
    })
})
