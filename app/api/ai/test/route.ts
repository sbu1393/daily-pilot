import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { getPrisma } from "@/app/lib/getPrisma"
import { isRateLimited } from "@/app/lib/rateLimit"
import { runAiSamples } from "@/app/lib/services/analysis.service"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import { resolvePlanPolicy, getMonthlyPeriod } from "@/app/lib/services/planPolicy.service"
import { touchAuthenticatedActivity } from "@/app/lib/services/userActivity.service"
import { reserveQuota, completeQuota, releaseQuota } from "@/app/lib/services/aiQuota.service"
import { markReleaseFailed } from "@/app/lib/services/aiUsage.service"
import { QuotaUnavailableError } from "@/app/lib/services/errors"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
} from "@/app/lib/apiResponse"

// فاز ۱ — سند §16:
// Production → گارد محیط اولین business action است: 404، بدون rate limit/quota/AI.
// Dev/Staging → rate limit فعلی 1/hour حفظ می‌شود؛ invocation = 3 logical AI operations
// → reserve = 3 units (all-or-nothing)؛ AI هرگز داخل transaction کووتا نیست.

const AI_TEST_UNITS = 3 // سند §16: invocation برابر ۳ logical AI operation

export async function GET() {
    // Production guard — اولین business action (سند §16)
    if (process.env.NODE_ENV === "production") {
        return errorResponse(404, "NOT_FOUND", "Not found")
    }

    const context = createObservabilityContext("/api/ai/test", "ai-test")
    try {
        // این اندپوینت هر بار چند فراخوانی AI انجام می‌دهد → فقط برای کاربران واردشده
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        const limited = isRateLimited(
            `ai-test:user:${user.id}`,
            1,
            60 * 60 * 1000,
        )
        if (limited) {
            return errorResponse(
                429,
                "RATE_LIMITED",
                "تعداد درخواست‌های هوش مصنوعی زیاد شده؛ کمی بعد دوباره تلاش کن",
                undefined,
                context.requestId,
            )
        }

        const prisma = getPrisma()

        // فاز ۱ — ثبت فعالیت (بعد از rate limit، قبل از plan/quota — سند §17)
        await touchAuthenticatedActivity(user.id, new Date(), prisma)

        // فاز ۱ — plan policy + period محلی کاربر (سند §۶) + reserve 3 units all-or-nothing (سند §16)
        const policy = resolvePlanPolicy({ plan: user.plan })
        const periodStart = getMonthlyPeriod(new Date(), user.timezone).periodStart
        // P1-5 (سند §19/§20/§21/§32): شکست زیرساخت quota ثبت می‌شود؛
        // QUOTA_EXCEEDED خطای expected است و هرگز record نمی‌شود.
        try {
            await reserveQuota(prisma, {
                userId: user.id,
                requestId: context.requestId,
                allowedUnits: policy.allowedUnits,
                units: AI_TEST_UNITS,
                feature: "ai-test",
                periodStart,
            })
        } catch (error) {
            if (error instanceof QuotaUnavailableError) recordError(error, context)
            throw error
        }

        let results
        try {
            // AI calls — خارج از transaction کووتا (سند §10)
            results = await runAiSamples()
        } catch (error) {
            // شکست نهایی → release (سند §12) — روی همان periodStart رزرو
            try {
                await releaseQuota(prisma, context.requestId, undefined, { periodStart })
            } catch {
                // سند §13/§21: release failure → reservation باقی می‌ماند، event در RESERVED می‌ماند،
                // failureCode=RELEASE_FAILED برای reconciliation ثبت می‌شود (best-effort، بدون throw) و
                // observability دقیقاً یک‌بار ثبت می‌کند؛ provider دوباره صدا زده نمی‌شود.
                await markReleaseFailed(prisma, context.requestId)
                recordError(new QuotaUnavailableError(), context)
                throw new QuotaUnavailableError()
            }
            throw error
        }

        // موفقیت → complete (سند §11) — روی همان periodStart رزرو
        try {
            await completeQuota(prisma, context.requestId, undefined, { periodStart })
        } catch (error) {
            if (error instanceof QuotaUnavailableError) recordError(error, context)
            throw error
        }

        // C8 — ADR-04: Envelope استاندارد { ok, data } (§3.11)
        return okResponse(results, { requestId: context.requestId })
    } catch (error) {
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        recordError(error, context)
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
