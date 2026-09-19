// ارسال ایمیل ترانزاکشنی با Resend (فقط سمت سرور)
//
// طراحی:
// - RESEND_API_KEY فقط server-side خوانده می‌شود؛ هرگز به کلاینت نمی‌رود.
// - fail-open نیست: نتیجه‌ی صریح برمی‌گرداند تا caller تصمیم بگیرد (مثلاً OTP retry).
// - خطا هرگز throw نمی‌شود؛ log می‌شود و status برمی‌گردد (الگوی fail-open observability).

import { Resend } from "resend"

/** نتیجه‌ی sendEmail — صریح و بدون throw. */
export type SendEmailResult =
    | { sent: true; id: string }
    | { sent: false; error: string }

/** آدرس فرستنده — قابل override با env؛ default فقط برای توسعه. */
const DEFAULT_FROM = process.env.RESEND_FROM_EMAIL ?? "DailyPilot <onboarding@resend.dev>"

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

    // پیکربندی ناقص → شکست صریح (بدون کرش)
    if (!apiKey || apiKey.trim() === "") {
        return { sent: false, error: "RESEND_API_KEY is not configured" }
    }

    // اعتبارسنجی حداقلی ورودی
    if (!to || !to.includes("@") || !subject || !html) {
        return { sent: false, error: "Invalid email arguments" }
    }

    try {
        const resend = new Resend(apiKey)
        const { data, error } = await resend.emails.send({
            from: DEFAULT_FROM,
            to,
            subject,
            html,
        })

        if (error) {
            // خطای API-level (rate limit، آدرس نامعتبر و...)
            console.error("[email] Resend API error:", error.message)
            return { sent: false, error: error.message }
        }

        return { sent: true, id: data?.id ?? "" }
    } catch (err) {
        // خطای شبکه/غیرمنتظره — بدون کرش کل برنامه
        console.error("[email] sendEmail failed:", err instanceof Error ? err.message : err)
        return { sent: false, error: "Email delivery failed" }
    }
}
