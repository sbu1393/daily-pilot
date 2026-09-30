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
import { createSession } from "@/app/lib/createSession"
import { EmailDeliveryFailedError } from "@/app/lib/services/errors"

/** کمینهٔ عمر سشنِ محدود تا کاربر فرصت داشته باشد رمز جدید را تایپ کند. */
const RESTRICTED_SESSION_MIN_SECONDS = 60

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

        // رمز موقت = ورود موفق ولی «هنوز کامل نیست».
        //
        // چرا این مسیر دیگر OTP نمی‌خواهد؟ تحلیل کامل در کامنت شاخهٔ رمز موقت
        // پایین‌تر آمده؛ خلاصه‌اش: هر دو راز (رمز موقت و کد OTP) از **یک کانال**
        // یعنی همان ایمیل می‌آیند، پس OTP یک عامل مستقل (2FA) نیست و فقط
        // سفر دوم به inbox اضافه می‌کند. رمز موقت خودش ۶۹ بیت آنتروپی دارد و
        // فقط از طریق همان ایمیل به کاربر می‌رسد، پس **دسترسی به inbox را ثابت
        // می‌کند**. جایگزینِ guard این است که سشنِ حاصل «محدود» باشد:
        //   ۱) `mustChangePassword` در DB ⇒ همهٔ endpointهای محافظت‌شده ۴۰۳
        //      و layoutها redirect می‌شوند (تنها کارِ ممکن، تعیین رمز جدید است)،
        //   ۲) سشن به `resetTokenId` **سنجاق** می‌شود — فقط همان توکن کار را می‌کند،
        //   ۳) عمر سشن و JWT به بازهٔ باقی‌ماندهٔ توکن محدود می‌شود (نه ۷ روز).
        // بدون این سه، حذف OTP ریسک را واقعاً بالا می‌برد.
        const mustChangePassword = auth.kind === "TEMPORARY"

        // ورود با رمز موقت یعنی حساب وارد وضعیت «باید رمز جدید تعیین شود» شد.
        // فلگ **همین‌جا** در DB نوشته می‌شود، نه در set-new-password، چون تنها
        // جایی که «رمز موقت بود» را می‌داند همین‌جاست؛ هر جای دیگری فقط پرچم را
        // *می‌خواند* و نمی‌تواند حدس بزد چرا باید صفر شود.
        // ترتیب حیاتی است: اول فلگ، بعد سشن. اگر نوشتن فلگ شکست بخورد و سشن
        // ساخته شود، enforcement خنثی می‌شود ⇒ صریحاً خطا می‌دهیم.
        if (mustChangePassword) {
            try {
                await getPrisma().user.update({
                    where: { id: user.id },
                    data: { mustChangePassword: true },
                })
            } catch (error) {
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

        // ── شاخهٔ رمز موقت: سشنِ محدود، بدون چالش OTP ────────────────────────
        //
        // چرا اینجا سشن صادر می‌شود و `verify-otp` در جریان نیست؟
        //   • هر دو راز (رمز موقت و کد OTP) به **یک کانال** می‌رسند: همان inbox.
        //     پس OTP عامل مستقل نیست؛ چیزی که اضافه می‌کند یک سفر دوم به inbox
        //     است، نه یک لایهٔ اعتماد جدید.
        //   • رمز موقت خودش یک رازِ تازه‌ساخت با ~۶۹ بیت آنتروپی است که فقط از
        //     طریق همان ایمیل به کاربر می‌رسد ⇒ رسیدنش اثباتِ دسترسی به inbox است.
        //   • آنچه OTP واقعاً اضافه می‌کرد: محافظت در برابر «لو رفتن جزئی» رمز
        //     (پیش‌نمایش ایمیل، shoulder-surfing). این با سه guard زیر تا حد زیادی
        //     پوشش داده می‌شود: پرچم DB، سنجاق سشن به توکن، و سقف عمر سشن.
        if (auth.kind === "TEMPORARY") {
            // عمر سشن = بازهٔ باقی‌ماندهٔ توکن (نه ۷ روز). کف ۶۰ ثانیه فقط برای اینکه
            // کاربر در لبهٔ انقضا فرصت تایپ داشته باشد؛ مرجع نهایی، چک توکن در
            // set-new-password است.
            const remainingSeconds = Math.floor((auth.resetExpiresAt.getTime() - Date.now()) / 1000)
            const restrictedMaxAge = Math.max(RESTRICTED_SESSION_MIN_SECONDS, remainingSeconds)

            console.log("[login] temporary password accepted — restricted session issued", {
                requestId: context.requestId,
                userId: user.id,
                resetTokenId: auth.resetTokenId,
                sessionMaxAgeSeconds: restrictedMaxAge,
            })

            const restrictedResponse = NextResponse.json(
                {
                    ok: true,
                    data: {
                        nextStep: "SET_PASSWORD",
                        email: user.email,
                        mustChangePassword: true,
                    },
                },
                { status: 200 },
            )
            restrictedResponse.headers.set("X-Request-ID", context.requestId)

            return createSession(
                {
                    id: user.id,
                    email: user.email,
                    mustChangePassword: true,
                    resetTokenId: auth.resetTokenId,
                },
                restrictedResponse,
                { maxAgeSeconds: restrictedMaxAge },
            )
        }

        // ── شاخهٔ عادی: ورود دو مرحله‌ای (۲FA) — دست‌نخورده ────────────────────
        // رمز عبور تأیید شد، اما **سشن نهایی اینجا ساخته نمی‌شود**. یک چالش OTP
        // ساخته و ایمیل می‌شود؛ سشن فقط پس از تأیید کد در /api/auth/verify-otp
        // صادر می‌شود.
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