// یادآورها — لغو اشتراک Web Push (idempotent)
//
// - حذف همیشه با شرط `{ endpoint, userId }` انجام می‌شود؛ پس کاربر A هرگز
//   نمی‌تواند اشتراک کاربر B را با حدس‌زدن endpoint حذف کند (بدون IDOR).
// - خروجی همیشه موفق است (`removed: 0` وقتی ردیفی نبود) تا لغو دوباره یا لغو
//   اشتراکی که مرورگر خودش باطل کرده، خطا تولید نکند.
// - این مسیر به کلیدهای VAPID نیاز ندارد؛ لغو اشتراک همیشه ممکن است.

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
import { pushUnsubscribeSchema } from "@/app/schema/pushSchema"
import { removePushSubscription } from "@/app/lib/services/push.service"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

const RATE_LIMIT_MAX = 30
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000

export async function POST(req: NextRequest) {
    const context = createObservabilityContext("/api/notifications/unsubscribe", "notifications")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        if (isRateLimited(`push:unsubscribe:user:${user.id}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
            return errorResponse(429, "RATE_LIMITED", "تعداد درخواست‌ها زیاد است؛ کمی بعد تلاش کن", undefined, context.requestId)
        }

        const body = await req.json().catch(() => ({}))
        const parsed = pushUnsubscribeSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten(), undefined, context.requestId)
        }

        const { removed } = await removePushSubscription(user.id, parsed.data.endpoint)

        return okResponse({ removed }, { requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
