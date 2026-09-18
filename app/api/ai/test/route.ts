import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { isRateLimited } from "@/app/lib/rateLimit"
import { runAiSamples } from "@/app/lib/services/analysis.service"
import { errorResponse, okResponse, unauthorizedResponse } from "@/app/lib/apiResponse"

export async function GET() {
    try {
        // این اندپوینت هر بار چند فراخوانی AI انجام می‌دهد → فقط برای کاربران واردشده
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse()

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
            )
        }

        const results = await runAiSamples()

        // C8 — ADR-04: از پاسخ خام آرایه به Envelope استاندارد { ok, data } رفتیم (§3.11)
        return okResponse(results)
    } catch (error) {
        // C8 — ADR-04: خطای مدیریت‌نشده قبلاً به صفحه‌ی 500 پیش‌فرض Next می‌رسید، نه Envelope خطا
        console.error("AI TEST ERROR:", error)
        return errorResponse(500, "INTERNAL", "Server error")
    }
}