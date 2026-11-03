import { NextRequest, NextResponse } from "next/server"
import { getCanonicalToday, isValidCanonicalDayKey } from "@/app/lib/canonicalDay"
import { requireVerifiedUser } from "@/app/lib/requireVerifiedUser"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
} from "@/app/lib/apiResponse"
import {
    getDailyCoachReport,
    resolveCoachTimezone,
} from "@/app/lib/services/coach.service"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

const ENDPOINT = "/api/coach/daily"
const FEATURE = "coach"
const DAY_KEY_PARAM = "dayKey"

// داده‌ی شخصی و وابسته به «امروز» است؛ هیچ لایه‌ی واسط نباید آن را کش کند.
function noStore(response: NextResponse): NextResponse {
    response.headers.set("Cache-Control", "no-store")
    return response
}

/**
 * GET /api/coach/daily?dayKey=YYYY-MM-DD
 *
 * خواندن گزارش روزانه‌ی مربی هوشمند برای کاربر Session.
 *
 * - userId فقط از Session می‌آید؛ هیچ userId/timezone از Query یا Header پذیرفته نمی‌شود.
 * - timezone فقط از رکورد کاربر resolve و به‌صورت strict IANA اعتبارسنجی می‌شود.
 * - dayKey اختیاری است؛ پیش‌فرض «امروزِ» canonical در timezone کاربر است.
 * - dayKey باید canonical Gregorian معتبر و غیرآینده باشد؛ هر دو قبل از سرویس رد می‌شوند.
 * - پارامتر تکراری dayKey صریحاً 400 می‌شود تا انتخاب تاریخ مبهم نماند.
 * - محاسبه‌ی گزارش کاملاً در getDailyCoachReport است؛ Route هیچ محاسبه‌ای تکرار نمی‌کند.
 * - این Route خودش read-only است، اما نوشتن‌های احتمالی لایه‌ی احراز هویت
 *   (getCurrentUser/lazyExpire) خارج از محدوده‌ی سرویس Coach و بدون تغییر باقی می‌مانند.
 */
export async function GET(req: NextRequest) {
    const context = createObservabilityContext(ENDPOINT, FEATURE)
    try {
        const user = await requireVerifiedUser()
        if (!user) return noStore(unauthorizedResponse(context.requestId))
        context.userId = user.id

        // Timezone فقط از کاربر احراز هویت‌شده؛ مقدار نامعتبر fail-closed است.
        const timezone = resolveCoachTimezone(user.timezone)
        const todayKey = getCanonicalToday(timezone)

        const rawDayKeys = req.nextUrl.searchParams.getAll(DAY_KEY_PARAM)
        if (rawDayKeys.length > 1) {
            return noStore(
                errorResponse(
                    400,
                    "VALIDATION_ERROR",
                    "پارامتر روز بیش از یک بار ارسال شده است",
                    undefined,
                    context.requestId,
                ),
            )
        }

        const dayKey = rawDayKeys[0] ?? todayKey

        // M10-style validation: format + real calendar, matching the other planner routes.
        if (!isValidCanonicalDayKey(dayKey)) {
            return noStore(
                errorResponse(
                    400,
                    "VALIDATION_ERROR",
                    "فرمت روز نامعتبر است",
                    undefined,
                    context.requestId,
                ),
            )
        }

        // Both keys are canonical zero-padded; lexical comparison is chronological.
        if (dayKey > todayKey) {
            return noStore(
                errorResponse(
                    400,
                    "VALIDATION_ERROR",
                    "تاریخ آینده مجاز نیست",
                    undefined,
                    context.requestId,
                ),
            )
        }

        const report = await getDailyCoachReport({
            userId: user.id,
            dayKey,
            todayKey,
        })

        // ADR-04: { ok, data } — data is exactly the Coach DTO, with no added fields.
        return noStore(okResponse(report, { requestId: context.requestId }))
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return noStore(mapped)
        return noStore(
            errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId),
        )
    }
}
