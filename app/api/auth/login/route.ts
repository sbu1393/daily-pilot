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
            // علت دقیق رد در همان لحظه توسط ماژول turnstile لاگ می‌شود
            // (`[turnstile] rejected: <REASON>`). این خط فقط مرز مرحله را با
            // requestId به آن وصل می‌کند تا تفکیک «کپچا» از «ایمیل» قطعی باشد.
            console.warn("[login] step 1/2 failed: CAPTCHA_FAILED", { requestId: context.requestId })
            return errorResponse(
                400,
                "CAPTCHA_FAILED",
                "تأیید انسان بودن ناموفق بود؛ دوباره تلاش کن",
                undefined,
                context.requestId,
            )
        }

        // کپچا تأیید شد — ادامه‌ی مسیر بدون دخالت کپچا (برای عیب‌یابی "کجا شکست خورد").
        console.log("[login] captcha verified — proceeding to credentials", {
            requestId: context.requestId,
        })

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

        const auth = await authenticate(email, password)
        const user = auth.user
        context.userId = user.id

        // رمز موقت = ورود موفق ولی «هنوز کامل نیست». این پرچم تا صفحهٔ OTP و
        // سشن نهایی حمل می‌شود تا کاربر مستقیم به /auth/set-new-password برود.
        // OTP همچنان اجباری است — این پرچم هیچ مسیر ورود بدون تأیید ایمیل نمی‌سازد.
        const mustChangePassword = auth.kind === "TEMPORARY"

        // ورود با رمز موقت یعنی حساب وارد وضعیت «باید رمز جدید تعیین شود» شد.
        // فلگ **همین‌جا** در DB نوشته می‌شود، نه در verify-otp، چون تنها جایی که
        // «رمز موقت بود» را می‌داند همین‌جاست؛ OtpCode چنین ستونی ندارد و
        // افزودنش schema را بدون فایده‌ی دیگری بزرگ می‌کرد.
        // اثرش بی‌خطر است تا وقتی سشنی وجود ندارد: سشن فقط در verify-otp صادر
        // می‌شود، پس تا آن لحظه این فلگ هیچ مسیری را باز نمی‌کند.
        if (mustChangePassword) {
            try {
                await getPrisma().user.update({
                    where: { id: user.id },
                    data: { mustChangePassword: true },
                })
            } catch (error) {
                // نگسستن به ورود: OTP هنوز باید تأیید شود و ساخت سشن در verify-otp
                // دوباره فلگ را از DB می‌خواند؛ اگر این نوشتن شکست بخورد، سشن
                // ساخته می‌شود ولی بدون فلگ — که یعنی enforcement خنثی. پس صریحاً
                // خطا می‌دهیم تا کاربر پیام درست بگیرد.
                await recordError(error, context)
                return errorResponse(
                    503,
                    "ACCOUNT_STATE_UNAVAILABLE",
                    "لطفاً کمی بعد دوباره تلاش کن",
                    undefined,
                    context.requestId,
                )
            }
        }

        console.log("[login] password verified", {
            requestId: context.requestId,
            userId: user.id,
            // نوع ورود لاگ می‌شود ولی نه خودِ رمز و نه خودِ ایمیل.
            loginKind: auth.kind,
        })

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
            // جزئیات کامل Resend (statusCode/name/message) در همان لحظه توسط
            // app/lib/email.ts لاگ می‌شود؛ اینجا فقط پیوند با درخواست و پاسخ می‌آید.
            console.error("[login] step 2/2 failed: EMAIL_DELIVERY_FAILED", {
                requestId: context.requestId,
                userId: user.id,
                challengeId: challenge.challengeId,
                resendError: delivery.error,
                httpStatus: 503,
                errorCode: "EMAIL_DELIVERY_FAILED",
            })
            throw new EmailDeliveryFailedError()
        }

        console.log("[login] OTP challenge issued — final session deferred to verify-otp", {
            requestId: context.requestId,
            userId: user.id,
            challengeId: challenge.challengeId,
            nextStep: "OTP",
        })

        const response = NextResponse.json(
            {
                ok: true,
                data: {
                    nextStep: "OTP",
                    challengeId: challenge.challengeId,
                    email: user.email,
                    mustChangePassword,
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