import { NextRequest } from "next/server"

import { verifyTurnstile } from "@/app/lib/turnstile"
import { CAPTCHA_ACTIONS } from "@/app/lib/captchaActions"
import { isRateLimited, clientIp } from "@/app/lib/rateLimit"
import { forgotPasswordSchema } from "@/app/schema/formSchema"
import { getPrisma } from "@/app/lib/getPrisma"
import { maskEmailForLog, sendEmail } from "@/app/lib/email"
import { issueTemporaryPassword, type PasswordResetClient } from "@/app/lib/services/passwordReset.service"
import {
    forgotPasswordEmailHtml,
    forgotPasswordEmailSubject,
} from "@/app/lib/passwordResetEmail"
import { EmailDeliveryFailedError } from "@/app/lib/services/errors"
import {
    errorResponse,
    okMessageResponse,
    toServiceErrorResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

const LOG_PREFIX = "[forgot-password]"

/** سقف تلاش در پنجره — لایهٔ دوم، روی همان Turnstile. */
const IP_MAX_ATTEMPTS = 5
const EMAIL_MAX_ATTEMPTS = 3
const WINDOW_MS = 15 * 60 * 1000

/**
 * پاسخ **واحد و بدون نشانه** — هم برای ایمیل موجود، هم برای ایمیل ناموجود، هم
 * برای ایمیلی که کاربرش وجود ندارد.
 *
 * چرا: وجود یا نبود حساب از روی تفاوت پاسخ/تاخیر قابل کشف است. این endpoint باید
 * دقیقاً همان چیزی را برگرداند که یک ایمیل موفق برمی‌گرداند، وگرنه هر کسی می‌تواند
 * فهرست ایمیل‌های ثبت‌شده را بسازد.
 *
 * علاوه بر متن، ساختار پاسخ هم یکسان است و هیچ داده‌ای بیرون از این متن نمی‌رود.
 */
const UNIFORM_MESSAGE = "اگر این ایمیل در سامانه باشد، رمز موقت برای آن ارسال شد."

/**
 * POST /api/auth/forgot-password
 *
 * زنجیرهٔ امنیتی، به همان ترتیبی که `login` و `send-otp` دارند:
 *   ۱) Turnstile **fail-closed و قبل از هر کار دیتابیسی** — بدون کپچا این
 *      endpoint به ابزار ارسال ایمیل انبوه (mail bombing) تبدیل می‌شود.
 *   ۲) rate limit روی IP (سپس روی ایمیلِ نرمال‌شده) — لایهٔ دوم.
 *   ۳) اعتبارسنجی Zod.
 *   ۴) lookup کاربر → اگر نبود، **همان پاسخ یکسان** برمی‌گردد و هیچ کاری نمی‌شود.
 *   ۵) invalidate توکن‌های قبلی → صدور رمز تازه → ارسال ایمیل.
 *
 * قوانین سخت:
 * - plaintext رمز موقت **نه در DB و نه در log** (فقط bcrypt hash در
 *   `PasswordResetToken`، و فقط خودِ ایمیل آن را می‌بیند).
 * - نتیجهٔ `sendEmail` بازرسی می‌شود؛ شکست ارسال هرگز «پاسخ موفق دروغین» نمی‌دهد
 *   (همان قرارداد `login` و `send-otp`).
 */
export async function POST(req: NextRequest) {
    const context = createObservabilityContext("/api/auth/forgot-password", "auth")

    try {
        if (isRateLimited(`forgot:ip:${clientIp(req)}`, IP_MAX_ATTEMPTS, WINDOW_MS)) {
            return errorResponse(
                429,
                "RATE_LIMITED",
                "تلاش‌های زیادی انجام شده؛ کمی بعد دوباره تلاش کن",
                undefined,
                context.requestId,
            )
        }

        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
        if (!body) return validationErrorResponse(undefined, undefined, context.requestId)

        const turnstileToken = typeof body.turnstileToken === "string" ? body.turnstileToken : ""
        if (
            !(await verifyTurnstile(turnstileToken, {
                expectedAction: CAPTCHA_ACTIONS.forgotPassword,
            }))
        ) {
            console.warn(`${LOG_PREFIX} CAPTCHA_FAILED`, { requestId: context.requestId })
            return errorResponse(
                400,
                "CAPTCHA_FAILED",
                "تأیید انسان بودن ناموفق بود؛ دوباره تلاش کن",
                undefined,
                context.requestId,
            )
        }

        const parsed = forgotPasswordSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(
                parsed.error.flatten(),
                undefined,
                context.requestId,
            )
        }

        const { email } = parsed.data

        if (isRateLimited(`forgot:email:${email}`, EMAIL_MAX_ATTEMPTS, WINDOW_MS)) {
            // پاسخ یکسان — نمی‌گوییم ایمیل وجود دارد یا نه.
            return okMessageResponse(UNIFORM_MESSAGE, 200, context.requestId)
        }

        const prisma = getPrisma()
        const user = await prisma.user.findUnique({
            where: { email },
            select: { id: true, email: true },
        })

        // ── ضد enumeration ────────────────────────────────────────────────────
        // ایمیل ناموجود: دقیقاً همان پاسخ، بدون هیچ کار جانبی. تفاوتِ زمانِ
        // «ساخت توکن + ارسال ایمیل» در برابر «کاری نکردن» یک side-channel
        // کوچک می‌سازد، ولی متن و status یکسان است و sendEmail (که خودش
        // fail-open و بدون throw است) در این مسیر اصلاً صدا زده نمی‌شود؛
        // برای جبران، کل زنجیرهٔ سنگین فقط پس از کپچا و rate limit است.
        if (!user) {
            console.log(`${LOG_PREFIX} no matching account`, {
                requestId: context.requestId,
                to: maskEmailForLog(email),
            })
            return okMessageResponse(UNIFORM_MESSAGE, 200, context.requestId)
        }

        context.userId = user.id

        // توکن‌های باز قبلی باطل می‌شوند ⇒ فقط آخرین رمز موقت معتبر است.
        // `issueTemporaryPassword` این را قبل از ایجاد رکورد جدید انجام می‌دهد.
        const issued = await issueTemporaryPassword(prisma as unknown as PasswordResetClient, {
            userId: user.id,
        })

        const delivery = await sendEmail(
            user.email,
            forgotPasswordEmailSubject(),
            // `issued.temporaryPassword` فقط این‌جا مصرف می‌شود؛ نه در لاگ، نه در DB.
            forgotPasswordEmailHtml(issued.temporaryPassword),
        )

        // شکست ارسال: توکن بی‌مصرف در DB مانده و کاربر هرگز رمز را نمی‌بیند،
        // پس پاسخ موفق دروغین دادن بدترین حالت است.
        if (!delivery.sent) {
            console.error(`${LOG_PREFIX} email delivery FAILED — token stranded`, {
                requestId: context.requestId,
                tokenId: issued.tokenId,
                resendError: delivery.error,
            })
            await strandingIssue(prisma, issued.tokenId)
            throw new EmailDeliveryFailedError()
        }

        console.log(`${LOG_PREFIX} temporary password issued`, {
            requestId: context.requestId,
            userId: user.id,
            tokenId: issued.tokenId,
            expiresAt: issued.expiresAt.toISOString(),
            resendId: delivery.id,
        })

        return okMessageResponse(UNIFORM_MESSAGE, 200, context.requestId)
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "خطای سرور", undefined, context.requestId)
    }
}

/**
 * strandingIssue — اگر ایمیل نرسید، توکن بی‌استفاده نباید بماند (کاربر ممکن است
 * بعداً حدس بزند یا با rate limit روبه‌رو شود). حذف آن بی‌خطر است: نه نشستی
 * وجود دارد و نه راهی برای استفاده از آن بدون ایمیل.
 */
async function strandingIssue(
    prisma: ReturnType<typeof getPrisma>,
    tokenId: string,
): Promise<void> {
    try {
        await prisma.passwordResetToken.delete({ where: { id: tokenId } })
    } catch {
        // fail-open: تمیزکردن بهتر است ولی نباید خطای اصلی را بپوشاند.
    }
}
