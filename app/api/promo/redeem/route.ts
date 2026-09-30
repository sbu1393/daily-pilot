import { NextRequest } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { getPrisma } from "@/app/lib/getPrisma"
import { redeemPromoCode } from "@/app/lib/services/promoCode.service"
import { redeemPromoCodeSchema } from "@/app/schema/aiQuotaSchema"
import { isRateLimited, clientIp } from "@/app/lib/rateLimit"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
} from "@/app/lib/apiResponse"

// AI Quota V2 — POST /api/promo/redeem (کاربر عادی، نه ادمین)
//
// - `userId` فقط از session؛ `code` تنها ورودی کلاینت (schema strict).
// - ضد-enumeration: همه‌ی حالت‌های رد (invalid/inactive/not-yet-valid/expired/exhausted)
//   یک پاسخ یکسان `PROMO_CODE_INVALID` (۴۰۰) می‌دهند؛ `PROMO_ALREADY_REDEEMED` (۴۰۹)
//   جدا می‌ماند چون فقط کاربرِ خودش می‌تواند آن را ببیند.
// - دلیل واقعی فقط در audit سمت سرور ثبت می‌شود و raw rejected code هرگز persist نمی‌شود
//   (این تضمین در خودِ سرویس `redeemPromoCode` است).
// - rate limit هم per-user و هم per-IP (مدل in-memory موجود پروژه).

const USER_MAX_ATTEMPTS = 10
const IP_MAX_ATTEMPTS = 30
const WINDOW_MS = 15 * 60 * 1000

export async function POST(req: NextRequest) {
    const context = createObservabilityContext("/api/promo/redeem", "billing")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        if (isRateLimited(`promo:user:${user.id}`, USER_MAX_ATTEMPTS, WINDOW_MS)) {
            return errorResponse(429, "RATE_LIMITED", "تعداد تلاش‌ها زیاد بود؛ کمی بعد دوباره امتحان کن", undefined, context.requestId)
        }
        if (isRateLimited(`promo:ip:${clientIp(req)}`, IP_MAX_ATTEMPTS, WINDOW_MS)) {
            return errorResponse(429, "RATE_LIMITED", "تعداد تلاش‌ها زیاد بود؛ کمی بعد دوباره امتحان کن", undefined, context.requestId)
        }

        let body: unknown
        try {
            body = await req.json()
        } catch {
            return errorResponse(400, "VALIDATION_ERROR", "بدنه‌ی درخواست نامعتبر است", undefined, context.requestId)
        }

        const parsed = redeemPromoCodeSchema.safeParse(body)
        if (!parsed.success) {
            return errorResponse(
                400,
                "VALIDATION_ERROR",
                "اطلاعات نامعتبر است",
                parsed.error.issues,
                context.requestId,
            )
        }

        const result = await redeemPromoCode(getPrisma(), {
            userId: user.id,
            code: parsed.data.code,
            timezone: user.timezone ?? "UTC",
            requestId: context.requestId,
        })

        return okResponse(
            {
                grantedFeatures: result.grantedFeatures,
                bonusAnalyzeUnits: result.bonusAnalyzeUnits,
                bonusPlanUnits: result.bonusPlanUnits,
                periodStart: result.periodStart.toISOString(),
            },
            { requestId: context.requestId },
        )
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
