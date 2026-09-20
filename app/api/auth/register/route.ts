import { NextRequest, NextResponse } from "next/server"
import { createSession } from "@/app/lib/createSession"
import { registerSchema } from "@/app/schema/formSchema"
import { isRateLimited, clientIp } from "@/app/lib/rateLimit"
import { verifyTurnstile } from "@/app/lib/turnstile"
import { CAPTCHA_ACTIONS } from "@/app/lib/captchaActions"
import { registerUser } from "@/app/lib/services/auth.service"
import {
    errorResponse,
    toServiceErrorResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

export async function POST(req: NextRequest) {
    const context = createObservabilityContext("/api/auth/register", "auth")
    try {
        // محدودیت نرخ: حداکثر چند ثبت‌نام از یک IP در یک بازه
        if (isRateLimited(`register:ip:${clientIp(req)}`, 5, 60 * 60 * 1000)) {
            return errorResponse(
                429,
                "RATE_LIMITED",
                "تعداد ثبت‌نام‌ها زیاد شده؛ کمی بعد دوباره تلاش کن",
                undefined,
                context.requestId,
            )
        }

        // M3: بدنه‌ی نامعتبر/غیر-JSON نباید ۵۰۰ بسازد → همان ۴۰۰ استاندارد ADR-04
        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
        if (!body) return validationErrorResponse(undefined, undefined, context.requestId)

        // Turnstile: قبل از هر work دیتابیسی — بات‌ها همین‌جا مسدود می‌شوند.
        // fail-closed: نبود/نامعتبر/منقضی/مصرف‌شده بودن توکن، نبود secret،
        // دامنه‌ی غیرمجاز یا action اشتباه → مسدود.
        const turnstileToken = typeof body.turnstileToken === "string" ? body.turnstileToken : ""
        if (!(await verifyTurnstile(turnstileToken, { expectedAction: CAPTCHA_ACTIONS.register }))) {
            return errorResponse(
                400,
                "CAPTCHA_FAILED",
                "تأیید انسان بودن ناموفق بود؛ دوباره تلاش کن",
                undefined,
                context.requestId,
            )
        }

        const validation = registerSchema.safeParse(body)
        if (!validation.success) {
            return validationErrorResponse(validation.error.flatten(), undefined, context.requestId)
        }

        const { username, email, password } = validation.data

        const user = await registerUser({ username, email, password })
        context.userId = user.id

        const response = NextResponse.json(
            {
                ok: true,
                data: {
                    user: {
                        id: user.id,
                        email: user.email,
                    },
                },
            },
            { status: 201 },
        )
        response.headers.set("X-Request-ID", context.requestId)

        return createSession(user, response)
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "خطای سرور", undefined, context.requestId)
    }
}