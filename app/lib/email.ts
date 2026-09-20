// ارسال ایمیل ترانزاکشنی با Resend (فقط سمت سرور)
//
// طراحی:
// - RESEND_API_KEY فقط server-side خوانده می‌شود؛ هرگز به کلاینت نمی‌رود.
// - fail-open نیست: نتیجه‌ی صریح برمی‌گرداند تا caller تصمیم بگیرد (مثلاً OTP retry).
// - خطا هرگز throw نمی‌شود؛ log می‌شود و status برمی‌گردد (الگوی fail-open observability).
// - تشخیص‌پذیری: هر شکست با جزئیات کامل Resend لاگ می‌شود (statusCode + name + message)
//   تا «ارسال ناموفق» از «کپچا ناموفق» و از «کلید/دامنهٔ نامعتبر» قابل تفکیک باشد.
//   آدرس گیرنده فقط ماسک‌شده لاگ می‌شود (قرارداد حریم خصوصی §۲۱ پروژه).

import { Resend } from "resend"

/** نتیجه‌ی sendEmail — صریح و بدون throw. */
export type SendEmailResult =
    | { sent: true; id: string }
    | { sent: false; error: string }

/** آدرس sandbox پیش‌فرض Resend — فقط برای توسعه؛ در production محدودیت ارسال دارد. */
const SANDBOX_FROM = "DailyPilot <onboarding@resend.dev>"

/** پیشوند ثابت همه‌ی لاگ‌های این ماژول (برای فیلتر کردن در لاگ سرور). */
const LOG_PREFIX = "[email]"

/** آدرس فرستنده — در هر فراخوانی خوانده می‌شود تا مقدار runtime (نه زمان import) اعمال شود. */
function resolveFromAddress(): string {
    const configured = process.env.RESEND_FROM_EMAIL
    return configured && configured.trim() !== "" ? configured : SANDBOX_FROM
}

/**
 * ماسک امن ایمیل برای لاگ: ۲ کاراکتر اول local + *** + دامنه.
 * (همان قرارداد maskEmailForLog اسکریپت‌های عملیاتی — دامنه برای تشخیص حفظ می‌شود،
 * ولی آدرس کامل هرگز در لاگ نمی‌نشیند.)
 */
export function maskEmailForLog(email: string): string {
    const at = email.indexOf("@")
    if (at <= 0) return "***"
    const local = email.slice(0, at)
    return `${local.slice(0, Math.min(2, local.length))}***${email.slice(at)}`
}

/**
 * راهنمای علت بر اساس پاسخ Resend — دقیقاً همان کدهایی که در عمل باعث شکست OTP می‌شوند.
 * خروجی برای انسان است، نه ماشین؛ در همان خط لاگ چاپ می‌شود.
 */
function hintForFailure(statusCode: number | null, senderIsSandbox: boolean): string | null {
    if (statusCode === 401) return "کلید API نامعتبر/غیرفعال است (RESEND_API_KEY)"
    if (statusCode === 403) {
        return senderIsSandbox
            ? "فرستنده آدرس sandbox است (onboarding@resend.dev) — Resend فقط به ایمیل مالک حساب اجازهٔ ارسال می‌دهد؛ دامنه را verify و RESEND_FROM_EMAIL را ست کن"
            : "دامنهٔ فرستنده در Resend verify نشده است — RESEND_FROM_EMAIL را روی دامنهٔ تأییدشده بگذار"
    }
    if (statusCode === 422) return "پارامترهای ایمیل نامعتبر است (from/to/subject/html)"
    if (statusCode === 429) return "محدودیت نرخ Resend — کمی بعد دوباره تلاش کن"
    return null
}

/**
 * sendEmail — ارسال یک ایمیل HTML با Resend.
 *
 * - to: آدرس گیرنده (فردی — برای انبوه از batch API جداگانه استفاده شود).
 * - subject: موضوع ایمیل.
 * - html: محتوای HTML کامل ایمیل.
 * - آدرس فرستنده: RESEND_FROM_EMAIL (اگر تعریف شده باشد) وگرنه آدرس sandbox پیش‌فرض Resend.
 *
 * خروجی هرگز throw نمی‌کند؛ همیشه یک SendEmailResult برمی‌گرداند.
 */
export async function sendEmail(
    to: string,
    subject: string,
    html: string,
): Promise<SendEmailResult> {
    const apiKey = process.env.RESEND_API_KEY
    const from = resolveFromAddress()
    const senderIsSandbox = from === SANDBOX_FROM

    // پیکربندی ناقص → شکست صریح (بدون کرش)
    if (!apiKey || apiKey.trim() === "") {
        // اینجا هیچ تماسی با Resend نمی‌شود؛ پس لاگ باید صریحاً همین را بگوید
        console.error(`${LOG_PREFIX} RESEND_API_KEY is not configured — email not sent`, {
            to: maskEmailForLog(to),
            from,
        })
        return { sent: false, error: "RESEND_API_KEY is not configured" }
    }

    // اعتبارسنجی حداقلی ورودی
    if (!to || !to.includes("@") || !subject || !html) {
        console.error(`${LOG_PREFIX} invalid email arguments`, {
            to: maskEmailForLog(to || ""),
            hasSubject: Boolean(subject),
            hasHtml: Boolean(html),
        })
        return { sent: false, error: "Invalid email arguments" }
    }

    try {
        const resend = new Resend(apiKey)
        const { data, error } = await resend.emails.send({
            from,
            to,
            subject,
            html,
        })

        if (error) {
            // خطای API-level (کلید، دامنه، rate limit، آدرس نامعتبر و...)
            // توجه: SDK نسند این خطا را throw نمی‌کند و در { data: null, error } برمی‌گرداند؛
            // پس اگر اینجا لاگ نکنیم، شکست واقعی کاملاً بی‌صدا می‌ماند.
            const detail = error as { message?: string; name?: string; statusCode?: number | null }
            const statusCode = detail.statusCode ?? null
            const hint = hintForFailure(statusCode, senderIsSandbox)

            console.error(`${LOG_PREFIX} Resend API error — email NOT sent`, {
                statusCode,
                name: detail.name ?? null,
                message: detail.message ?? null,
                from,
                senderIsSandbox,
                to: maskEmailForLog(to),
                hint,
            })

            return { sent: false, error: detail.message ?? "Resend API error" }
        }

        console.log(`${LOG_PREFIX} accepted by Resend`, {
            id: data?.id ?? null,
            from,
            senderIsSandbox,
            to: maskEmailForLog(to),
        })

        return { sent: true, id: data?.id ?? "" }
    } catch (err) {
        // خطای شبکه/غیرمنتظره — بدون کرش کل برنامه
        console.error(`${LOG_PREFIX} sendEmail threw — email NOT sent`, {
            errorName: err instanceof Error ? err.name : typeof err,
            errorMessage: err instanceof Error ? err.message : String(err),
            from,
            to: maskEmailForLog(to),
        })
        return { sent: false, error: "Email delivery failed" }
    }
}
