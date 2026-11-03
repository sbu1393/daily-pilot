import { NextRequest, NextResponse } from "next/server"
import { getCanonicalToday, isValidCanonicalDayKey } from "@/app/lib/canonicalDay"
import { isWeekStart, weekStartOf } from "@/app/lib/coach/week"
import { requireVerifiedUser } from "@/app/lib/requireVerifiedUser"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
} from "@/app/lib/apiResponse"
import {
    getWeeklyCoachReport,
    resolveCoachTimezone,
} from "@/app/lib/services/coach.service"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

const ENDPOINT = "/api/coach/weekly"
const FEATURE = "coach"
const WEEK_START_PARAM = "weekStart"

// داده‌ی شخصی و وابسته به «امروز» است؛ هیچ لایه‌ی واسط نباید آن را کش کند.
function noStore(response: NextResponse): NextResponse {
    response.headers.set("Cache-Control", "no-store")
    return response
}

/**
 * GET /api/coach/weekly?weekStart=YYYY-MM-DD
 *
 * خواندن گزارش هفتگی مربی هوشمند برای کاربر Session.
 *
 * - userId فقط از Session می‌آید؛ هیچ userId/timezone از Query، Header یا Body پذیرفته نمی‌شود.
 * - timezone فقط از رکورد کاربر resolve و strict IANA اعتبارسنجی می‌شود.
 * - weekStart اختیاری است؛ پیش‌فرض شنبه‌ی هفته‌ی جاری از weekStartOf(todayKey) می‌آید.
 * - weekStart باید canonical Gregorian، شنبه و غیرآینده باشد؛ همه قبل از سرویس رد می‌شوند.
 * - پارامتر تکراری weekStart صریحاً 400 می‌شود تا انتخاب هفته مبهم نماند.
 * - ساخت ۷ روز، پوشش روزهای آینده، تجمیع و dataQuality همه در getWeeklyCoachReport
 *   و موتور step 1 (weekDaysOf/buildWeeklyReport) انجام می‌شود؛ Route تکرارشان نمی‌کند.
 * - این Route خودش business logic read-only دارد، اما نوشتن‌های احتمالی لایه‌ی احراز هویت
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

        const rawWeekStarts = req.nextUrl.searchParams.getAll(WEEK_START_PARAM)
        if (rawWeekStarts.length > 1) {
            return noStore(
                errorResponse(
                    400,
                    "VALIDATION_ERROR",
                    "پارامتر شروع هفته بیش از یک بار ارسال شده است",
                    undefined,
                    context.requestId,
                ),
            )
        }

        let weekStart: string

        if (rawWeekStarts.length === 0) {
            // شنبه‌ی هفته‌ی جاری؛ همیشه شنبه و غیرآینده است.
            weekStart = weekStartOf(todayKey)
        } else {
            weekStart = rawWeekStarts[0]

            if (!isValidCanonicalDayKey(weekStart)) {
                return noStore(
                    errorResponse(
                        400,
                        "VALIDATION_ERROR",
                        "فرمت شروع هفته نامعتبر است",
                        undefined,
                        context.requestId,
                    ),
                )
            }

            if (!isWeekStart(weekStart)) {
                return noStore(
                    errorResponse(
                        400,
                        "VALIDATION_ERROR",
                        "شروع هفته باید شنبه باشد",
                        undefined,
                        context.requestId,
                    ),
                )
            }

            // Both keys are canonical zero-padded; lexical comparison is chronological.
            if (weekStart > todayKey) {
                return noStore(
                    errorResponse(
                        400,
                        "VALIDATION_ERROR",
                        "هفته‌ی آینده مجاز نیست",
                        undefined,
                        context.requestId,
                    ),
                )
            }
        }

        const report = await getWeeklyCoachReport({
            userId: user.id,
            weekStart,
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
