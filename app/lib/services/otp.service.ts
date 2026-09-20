// سرویس OTP — صدور چالش و ارسال ایمیل، مشترک بین /api/auth/login (مرحله ۱ از ۲)
// و /api/auth/send-otp.
//
// چرا سرویس جدا؟ ADR-02: Route فقط orchestration است (Parse → Authenticate →
// Validate → Service → Response) و منطق دامنه در app/lib می‌ماند. هر دو Route
// دقیقاً یک کار می‌کنند: ساخت کد، ذخیره‌ی hash، ارسال ایمیل. تکرار این منطق در دو
// Route یعنی واگرایی تدریجی قواعد امنیتی.
//
// قواعد امنیتی:
// - کد خام هرگز persist نمی‌شود؛ فقط bcrypt hash (lib/otp.ts).
// - نتیجه‌ی ارسال از Resend همیشه اعتبارسنجی می‌شود؛ شکست هرگز بی‌صدا رد نمی‌شود
//   (این تابع خودش throw نمی‌کند و نتیجه‌ی صریح برمی‌گرداند تا caller تصمیم بگیرد).
// - secret سرویس ایمیل فقط server-side خوانده می‌شود (app/lib/email.ts).

import { getPrisma } from "@/app/lib/getPrisma"
import { generateOtpCode, hashOtp } from "@/lib/otp"
import { maskEmailForLog, sendEmail, type SendEmailResult } from "@/app/lib/email"

/** پیشوند ثابت لاگ‌های این سرویس (برای فیلتر کردن در لاگ سرور). */
const LOG_PREFIX = "[otp]"

/** عمر چالش OTP — ۱۰ دقیقه (هم‌راستا با متن ایمیل و قرارداد قبلی). */
export const OTP_TTL_MS = 10 * 60 * 1000

/**
 * حداکثر تلاش تأیید برای هر چالش (max attempts — ضد brute force).
 * Turnstile هر درخواست را جدا می‌سنجد؛ این سقف یک لایه‌ی دفاعی دوم روی همان
 * چالش/ایمیل است (الگوی دو-سبدی همان login route).
 */
export const OTP_MAX_ATTEMPTS = 5

/** چالش صادرشده — challengeId همان id رکورد OtpCode است (بدون تغییر schema). */
export type OtpChallenge = {
    challengeId: string
    code: string
    expiresAt: Date
}

/** کلاینت حداقلی موردنیاز صدور چالش — قابل تزریق برای تست (بدون DB واقعی). */
export type OtpChallengeClient = {
    otpCode: {
        create: (args: {
            data: { email: string; codeHash: string; expiresAt: Date }
        }) => Promise<{ id: string }>
    }
}

/**
 * createOtpChallenge — یک کد ۶ رقمی امن می‌سازد، hash آن را با انقضای ۱۰ دقیقه
 * ذخیره می‌کند و شناسه‌ی چالش + کد خام را برمی‌گرداند.
 *
 * کد خام فقط در حافظه‌ی همین فراخوانی زنده است و برای ارسال ایمیل استفاده می‌شود؛
 * در DB فقط hash می‌ماند.
 */
export async function createOtpChallenge(
    email: string,
    client: OtpChallengeClient = getPrisma() as unknown as OtpChallengeClient,
    now: Date = new Date(),
): Promise<OtpChallenge> {
    const code = generateOtpCode()
    const codeHash = await hashOtp(code)
    const expiresAt = new Date(now.getTime() + OTP_TTL_MS)

    const record = await client.otpCode.create({
        data: { email, codeHash, expiresAt },
    })

    // کد خام هرگز لاگ نمی‌شود؛ فقط شناسهٔ چالش برای correlation با ایمیل/لاگ مسیر.
    console.log(`${LOG_PREFIX} challenge created`, {
        challengeId: record.id,
        to: maskEmailForLog(email),
        expiresAt: expiresAt.toISOString(),
    })

    return { challengeId: record.id, code, expiresAt }
}

/** موضوع ایمیل OTP — خالص و قابل تست. */
export function otpEmailSubject(): string {
    return "کد تأیید DailyPilot"
}

/** بدنه‌ی HTML ایمیل OTP — خالص؛ هیچ داده‌ی حساسی جز خود کد در آن نیست. */
export function otpEmailHtml(code: string): string {
    return `<p>کد یک‌بار مصرف شما: <strong>${code}</strong></p><p>این کد تا ۱۰ دقیقه معتبر است.</p>`
}

/**
 * sendOtpEmail — ارسال کد OTP با Resend از طریق helper موجود email.ts.
 *
 * نتیجه‌ی Resend (خطای API مثل ۴۰۱/۴۰۳/۴۲۲/۴۲۹ یا خطای شبکه) به‌صورت
 * `{ sent: false, error }` برگردانده می‌شود تا caller بتواند خطای مناسب بدهد؛
 * اگر این نتیجه بررسی نشود، یک شکست واقعی به «کد ارسال شد» تبدیل می‌شود.
 */
export async function sendOtpEmail(email: string, code: string): Promise<SendEmailResult> {
    const result = await sendEmail(email, otpEmailSubject(), otpEmailHtml(code))

    // لاگ سطح سرویس: نتیجهٔ دقیق Resend (کد خطا/status/message در email.ts لاگ می‌شود)
    // تا شکست ارسال از شکست کپچا و از خطاهای دیگر در لاگ سرور قابل تفکیک باشد.
    if (result.sent) {
        console.log(`${LOG_PREFIX} email delivered to provider`, {
            to: maskEmailForLog(email),
            resendId: result.id,
        })
    } else {
        console.error(`${LOG_PREFIX} email delivery FAILED — OTP cannot reach the user`, {
            to: maskEmailForLog(email),
            error: result.error,
        })
    }

    return result
}
