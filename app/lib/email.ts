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

/**
 * پیشوند کلیدهای API معتبر Resend. اگر مقدار env با این پیشوند شروع نشود، یعنی
 * مقدار اشتباه/ناقص در environment نشسته است و Resend پاسخ 401 می‌دهد.
 */
const RESEND_KEY_PREFIX = "re_"

/** پیشوند ثابت همه‌ی لاگ‌های این ماژول (برای فیلتر کردن در لاگ سرور). */
const LOG_PREFIX = "[email]"

/**
 * آدرس فرستنده — در هر فراخوانی خوانده می‌شود تا مقدار runtime (نه زمان import) اعمال شود.
 * (trim می‌شود تا فاصله/`\n` انتهایی از هر دو مسیر — ایمیل و endpoint دیباگ — یکسان حذف شود.)
 */
export function resolveFromAddress(): string {
    const configured = process.env.RESEND_FROM_EMAIL
    return configured && configured.trim() !== "" ? configured.trim() : SANDBOX_FROM
}

/** آیا آدرس فرستنده همان sandbox پیش‌فرض Resend است؟ (منبع یکتای این تشخیص برای route دیباگ) */
export function isSandboxFromAddress(from: string = resolveFromAddress()): boolean {
    return from === SANDBOX_FROM
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
    // کلید در هر فراخوانی از env خوانده می‌شود (مقدار runtime، نه زمان import) و **trim** می‌شود:
    // یک فاصله یا `\n` انتهایی در مقدار env (paste دستی یا `vercel env add` با echo) باعث
    // می‌شود SDK هدر «Authorization: Bearer <key>\n» بسازد و Resend آن را 401 رد کند.
    const rawApiKey = process.env.RESEND_API_KEY
    const apiKey = (rawApiKey ?? "").trim()
    // فقط boolean لاگ می‌شود؛ خودِ secret تحت هیچ شرایطی (حتی به‌صورت بخشی) چاپ نمی‌شود.
    const keyHadSurroundingWhitespace = rawApiKey !== undefined && rawApiKey !== apiKey

    const from = resolveFromAddress()
    const senderIsSandbox = from === SANDBOX_FROM

    // پیکربندی ناقص → شکست صریح (بدون کرش)
    if (apiKey === "") {
        // اینجا هیچ تماسی با Resend نمی‌شود؛ پس لاگ باید صریحاً همین را بگوید.
        // `keyVariablePresent` تفاوت «متغیر تعریف‌نشده» و «متغیر تعریف‌شدهٔ خالی» را نشان می‌دهد.
        console.error(`${LOG_PREFIX} RESEND_API_KEY is not configured — email not sent`, {
            keyVariablePresent: rawApiKey !== undefined,
            keyHadSurroundingWhitespace,
            to: maskEmailForLog(to),
            from,
            senderIsSandbox,
        })
        return { sent: false, error: "RESEND_API_KEY is not configured" }
    }

    // کلیدهای Resend همیشه با `re_` شروع می‌شوند؛ در غیر این صورت مقدار env اشتباه است
    // (کلید سرویس دیگر، کلید ناقص، یا مقدار جابه‌جا) و Resend آن را 401 رد می‌کند.
    if (!apiKey.startsWith(RESEND_KEY_PREFIX)) {
        console.warn(
            `${LOG_PREFIX} RESEND_API_KEY does not start with "${RESEND_KEY_PREFIX}" — Resend will most likely reject it with 401`,
            {
                keyHadSurroundingWhitespace,
                to: maskEmailForLog(to),
                from,
                senderIsSandbox,
            },
        )
    } else if (keyHadSurroundingWhitespace) {
        console.warn(`${LOG_PREFIX} RESEND_API_KEY had surrounding whitespace — trimmed before use`, {
            to: maskEmailForLog(to),
            from,
            senderIsSandbox,
        })
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
                // تفکیک «کلید معیوب (فاصله/\n)» از «کلید اشتباه/باطل» — بدون افشای مقدار
                keyHadSurroundingWhitespace,
                keyStartsWithResendPrefix: apiKey.startsWith(RESEND_KEY_PREFIX),
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
            senderIsSandbox,
            to: maskEmailForLog(to),
            keyHadSurroundingWhitespace,
        })
        return { sent: false, error: "Email delivery failed" }
    }
}
