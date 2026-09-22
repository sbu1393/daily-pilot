// یادآورها — ثبت اشتراک Web Push برای کاربر نشست جاری (سند گزارش تحلیل §۲)
//
// مرزها:
// - `userId` فقط از `getCurrentUser()` می‌آید؛ بدنه‌ی درخواست هرگز userId ندارد.
// - `endpoint` کلید یکتای واقعی است (یک مرورگر = یک ردیف) و در صورت ثبت دوباره
//   به همین کاربر نسبت داده می‌شود (کاربر قبلی روی همان دستگاه دیگر اعلان نمی‌گیرد).
// - payload خام provider/مرورگر ذخیره نمی‌شود؛ فقط endpoint + دو کلید عمومی.
// - rate limit per-user (نوشتن روی DB) — کلید user-scoped، پس پشت NAT درست است.
// - اگر کلیدهای VAPID روی سرور تنظیم نشده باشند → 503 PUSH_NOT_CONFIGURED
//   (کلاینت این را «اعلان روی سرور غیرفعال است» ترجمه می‌کند، نه خرابی اپ).

import { NextRequest } from "next/server"

import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { isRateLimited } from "@/app/lib/rateLimit"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"
import { pushSubscribeSchema } from "@/app/schema/pushSchema"
import { isPushConfigured } from "@/app/lib/push/config"
import { PushNotConfiguredError } from "@/app/lib/services/errors"
import { savePushSubscription } from "@/app/lib/services/push.service"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

const RATE_LIMIT_MAX = 30
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000

export async function POST(req: NextRequest) {
    const context = createObservabilityContext("/api/notifications/subscribe", "notifications")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        if (isRateLimited(`push:subscribe:user:${user.id}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
            return errorResponse(429, "RATE_LIMITED", "تعداد درخواست‌ها زیاد است؛ کمی بعد تلاش کن", undefined, context.requestId)
        }

        const body = await req.json().catch(() => ({}))
        const parsed = pushSubscribeSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten(), undefined, context.requestId)
        }

        if (!isPushConfigured()) throw new PushNotConfiguredError()

        const { id, pruned } = await savePushSubscription(user.id, {
            endpoint: parsed.data.endpoint,
            p256dh: parsed.data.keys.p256dh,
            auth: parsed.data.keys.auth,
        })

        // پاسخ فقط شناسه‌ی داخلی ردیف و تعداد prune — هیچ کلید/endpoint برنمی‌گردد
        return okResponse({ id, pruned }, { status: 201, requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
