import { requireVerifiedUser } from "@/app/lib/requireVerifiedUser"
import { isRateLimited } from "@/app/lib/rateLimit"
import { runAiSamples } from "@/app/lib/services/analysis.service"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
} from "@/app/lib/apiResponse"

// Endpoint تشخیصی داخلی (debug/QA) — **هیچ quota واقعی مصرف نمی‌کند**.
//
// تصمیم قطعی: `ai-test` یک قابلیت محصول نیست، پس نه سهمیه‌ای از `AiQuotaPolicy`
// می‌خواند، نه reservation می‌سازد و نه از ledger (BASE/PROMO) کم می‌کند. دلیل‌ها:
//  1) در production از همان اولین statement با 404 بسته است و user-facing نیست.
//  2) UI/caller ندارد و ProductEvent/activity عمداً برایش ثبت نمی‌شود.
//  3) در dev بدون provider key به mock می‌افتد ⇒ **صفر** AI call واقعی، ولی quota مصرف
//     می‌کرد؛ یعنی سهمیهٔ کاربر بابت کاری که انجام نشده بود کم می‌شد.
//  4) `AI_TEST_UNITS = 3` فقط تعداد sampleهای داخلی بود، نه هزینهٔ محصول.
//
// در نتیجه V2 دقیقاً همان چهار ترکیب سیاست محصول را نگه می‌دارد:
//   FREE: ANALYZE=15, PLAN=2   ·   PRO: ANALYZE=270, PLAN=50
//
// آنچه عمداً حفظ شده: احراز هویت، rate limit خودِ این endpoint، اجرای sampleها و
// ثبت خطا. فقط quota حذف شده است.

export async function GET() {
    // Production guard — اولین business action
    if (process.env.NODE_ENV === "production") {
        return errorResponse(404, "NOT_FOUND", "Not found")
    }

    const context = createObservabilityContext("/api/ai/test", "ai-test")
    try {
        const user = await requireVerifiedUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        // rate limit داخلی این endpoint (۱ بار در ساعت برای هر کاربر) — مستقل از quota
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

        // این endpoint فقط debug است و **نباید** activity تولید کند:
        // هیچ `touchAuthenticatedActivity` (lastSeenAt) و هیچ ProductEvent این‌جا ثبت
        // نمی‌شود.

        // AI callها بدون هیچ رزرو سهمیه‌ای اجرا می‌شوند.
        const results = await runAiSamples()

        // C8 — ADR-04: Envelope استاندارد { ok, data } (§3.11)
        return okResponse(results, { requestId: context.requestId })
    } catch (error) {
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        await recordError(error, context)
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
