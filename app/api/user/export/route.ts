import { NextResponse } from "next/server"

import { requireVerifiedUser } from "@/app/lib/requireVerifiedUser"
import { isRateLimited } from "@/app/lib/rateLimit"
import { buildUserDataExport } from "@/app/lib/services/userData.service"
import {
    errorResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
} from "@/app/lib/apiResponse"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

/* خروجی کامل یک کاربر می‌تواند سنگین باشد؛ سقف per-user از سوءاستفاده جلوگیری می‌کند. */
const EXPORT_MAX_ATTEMPTS = 5
const EXPORT_WINDOW_MS = 15 * 60 * 1000

/**
 * GET /api/user/export
 *
 * یک فایل JSON قابل‌دانلود از داده‌های همین کاربر برمی‌گرداند. گیرنده هرگز از
 * ورودی کلاینت گرفته نمی‌شود؛ همیشه `user.id` از نشست است.
 */
export async function GET() {
    const context = createObservabilityContext("/api/user/export", "account")
    try {
        const user = await requireVerifiedUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        if (isRateLimited(`export:user:${user.id}`, EXPORT_MAX_ATTEMPTS, EXPORT_WINDOW_MS)) {
            return errorResponse(
                429,
                "RATE_LIMITED",
                "تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره تلاش کن",
                undefined,
                context.requestId,
            )
        }

        const data = await buildUserDataExport(user.id)
        const body = JSON.stringify(data, null, 2)

        const response = new NextResponse(body, {
            status: 200,
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                // نام فایل دقیقاً همان چیزی است که کلاینت انتظار دارد؛ ASCII تا در همه‌ی مرورگرها سالم بماند.
                "Content-Disposition": 'attachment; filename="roozsaz-data.json"',
                // دادهٔ شخصی نباید در کش مرورگر/پروکسی بماند.
                "Cache-Control": "no-store",
            },
        })
        response.headers.set("X-Request-ID", context.requestId)
        return response
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "خطای سرور", undefined, context.requestId)
    }
}
