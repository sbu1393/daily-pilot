// یادآورها — ارسال اعلان آزمایشی به دستگاه‌های خودِ کاربر (تشخیصی)
//
// چرا لازم است؟ بدون این مسیر هیچ راهی برای تأیید انتها-به-انتها وجود ندارد که
// اعلان در حالت بسته بودن اپ هم می‌رسد (سناریوی اصلی Web Push).
//
// مرزها:
// - فقط برای کاربر نشست جاری ارسال می‌شود (هیچ ورودی client برای تعیین گیرنده نیست).
// - rate limit سخت‌گیرانه (۵ در ۱۵ دقیقه) چون هر فراخوانی به provider خارجی می‌زند.
// - payload ثابت و بی‌خطر است: هیچ محتوای تسک/ایمیل/شناسه‌ای ارسال نمی‌شود.
// - این مسیر هیچ ردیف اشتراکی نمی‌سازد و هیچ یادآور زمان‌بندی‌شده‌ای را دست نمی‌زند.

import { NextRequest } from "next/server"

import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { isRateLimited } from "@/app/lib/rateLimit"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
} from "@/app/lib/apiResponse"
import { isPushConfigured } from "@/app/lib/push/config"
import { PushNotConfiguredError } from "@/app/lib/services/errors"
import { sendPushToUser } from "@/app/lib/services/push.service"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

const RATE_LIMIT_MAX = 5
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000

export async function POST(_req: NextRequest) {
    const context = createObservabilityContext("/api/notifications/test", "notifications")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        if (isRateLimited(`push:test:user:${user.id}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
            return errorResponse(429, "RATE_LIMITED", "تعداد درخواست‌ها زیاد است؛ کمی بعد تلاش کن", undefined, context.requestId)
        }

        if (!isPushConfigured()) throw new PushNotConfiguredError()

        const summary = await sendPushToUser(user.id, {
            title: "آزمایش اعلان روزچین",
            body: "اگر این پیام را می‌بینی، اعلان‌ها درست کار می‌کنند ✅",
            url: "/dashboard",
            tag: "dp-test",
        })

        return okResponse(summary, { requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
