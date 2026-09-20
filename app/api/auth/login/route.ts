import { NextRequest, NextResponse } from "next/server"
import { loginSchema } from "@/app/schema/formSchema"
import { isRateLimited, clientIp } from "@/app/lib/rateLimit"
import { verifyTurnstile } from "@/app/lib/turnstile"
import { CAPTCHA_ACTIONS } from "@/app/lib/captchaActions"
import { authenticate } from "@/app/lib/services/auth.service"
import {
    errorResponse,
    toServiceErrorResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import { getPrisma } from "@/app/lib/getPrisma"
import { touchAuthenticatedActivity } from "@/app/lib/services/userActivity.service"
import { recordProductEvent } from "@/app/lib/services/productEvent.service"
import { createOtpChallenge, sendOtpEmail } from "@/app/lib/services/otp.service"
import { EmailDeliveryFailedError } from "@/app/lib/services/errors"

export async function POST(req: NextRequest) {
    const context = createObservabilityContext("/api/auth/login", "auth")
    try {
        // محدودیت نرخ: به ازای IP (قبل از خواندن بدنه) و به ازای ایمیل (بعد از اعتبارسنجی)
        if (isRateLimited(`login:ip:${clientIp(req)}`)) {
            return errorResponse(
                429,
                "RATE_LIMITED",
                "تلاش‌های زیادی انجام شده؛ کمی بعد دوباره تلاش کن",
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
        if (!(await verifyTurnstile(turnstileToken, { expectedAction: CAPTCHA_ACTIONS.login }))) {
            return errorResponse(
                400,
                "CAPTCHA_FAILED",
                "تأیید انسان بودن ناموفق بود؛ دوباره تلاش کن",
                undefined,
                context.requestId,
            )
        }

        const validation = loginSchema.safeParse(body)

        if (!validation.success) {
            return validationErrorResponse(validation.error.flatten(), undefined, context.requestId)
        }

        const { email, password } = validation.data

        if (isRateLimited(`login:email:${email}`, 5)) {
            return errorResponse(
                429,
                "RATE_LIMITED",
                "تلاش‌های زیادی برای این حساب انجام شده؛ کمی بعد دوباره تلاش کن",
                undefined,
                context.requestId,
            )
        }

        const user = await authenticate(email, password)
        context.userId = user.id

        // فاز ۳ — گام ۷: auth.login_succeeded فقط بعد از موفقیت واقعی authentication،
        // قبل از ساخت session (مرز موفقیت auth)؛ خارج از business transaction؛
        // fail-open — هرگز نتیجه‌ی login را تغییر نمی‌دهد (سند §17).
        try {
            const prisma = getPrisma()
            await touchAuthenticatedActivity(user.id, new Date(), prisma)
            await recordProductEvent(
                user.id,
                "auth.login_succeeded",
                undefined, // بدون properties (§8)
                { requestId: context.requestId, endpoint: "/api/auth/login", feature: "auth" },
            )
        } catch {
            // fail-open — analytics failure هرگز login را fail نمی‌کند
        }

        // ورود دو مرحله‌ای (2FA): رمز عبور تأیید شد، اما **سشن نهایی اینجا ساخته
        // نمی‌شود**. یک چالش OTP ساخته و ایمیل می‌شود؛ سشن فقط پس از تأیید کد در
        // /api/auth/verify-otp صادر می‌شود.
        const challenge = await createOtpChallenge(user.email)
        const delivery = await sendOtpEmail(user.email, challenge.code)

        // شکست ارسال ایمیل هرگز بی‌صدا رد نمی‌شود: بدون ایمیل، کد به کاربر نمی‌رسد
        // و ادامه دادن یعنی پاسخ ۲۰۰ دروغین. خطای صریح + recordError در catch.
        if (!delivery.sent) {
            throw new EmailDeliveryFailedError()
        }

        const response = NextResponse.json(
            {
                ok: true,
                data: {
                    nextStep: "OTP",
                    challengeId: challenge.challengeId,
                    email: user.email,
                },
            },
            { status: 200 },
        )
        response.headers.set("X-Request-ID", context.requestId)

        return response
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "خطای سرور", undefined, context.requestId)
    }
}