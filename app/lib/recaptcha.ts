// تایید سمت سرور توکن reCAPTCHA v3
//
// طراحی:
// - فقط server-side: RECAPTCHA_SECRET_KEY هرگز به کلاینت نمی‌رود.
// - fail-closed: هر شکست ارتباط/پیکربندی → false (درخواست رد می‌شود، نه اینکه عبور کند).
// - بدون وابستگی خارجی: fetch استاندارد Node 18+ / Next.js Route Handler.

const SITEVERIFY_URL = "https://www.google.com/recaptcha/api/siteverify"

/** آستانه‌ی حداقل امتیاز reCAPTCHA v3 (۰ تا ۱) — 0.5 توصیه‌ی رسمی گوگل است. */
const DEFAULT_MIN_SCORE = 0.5

/** پاسخ Google siteverify — فقط فیلدهای موردنیاز. */
interface SiteVerifyResponse {
    success?: boolean
    score?: number
    action?: string
    "error-codes"?: string[]
}

/**
 * verifyRecaptcha — تایید توکن reCAPTCHA v3 دریافت‌شده از کلاینت.
 *
 * - secret از RECAPTCHA_SECRET_KEY خوانده می‌شود (فقط سمت سرور).
 * - درخواست POST با URLSearchParams به https://www.google.com/recaptcha/api/siteverify
 * - true فقط وقتی: success === true و score >= آستانه‌ی حداقل.
 * - هر شکست (network، پیکربندی ناقص، پاسخ نامعتبر) → false (هرگز throw نمی‌کند).
 */
export async function verifyRecaptcha(
    token: string,
    options?: { minScore?: number },
): Promise<boolean> {
    const secret = process.env.RECAPTCHA_SECRET_KEY
    const minScore = options?.minScore ?? DEFAULT_MIN_SCORE

    // پیکربندی ناقص → fail-closed
    if (!secret || secret.trim() === "" || !token || token.trim() === "") {
        return false
    }

    try {
        const body = new URLSearchParams({
            secret,
            response: token,
        })

        const res = await fetch(SITEVERIFY_URL, {
            method: "POST",
            body,
        })

        if (!res.ok) {
            return false
        }

        const data = (await res.json().catch(() => null)) as SiteVerifyResponse | null
        if (!data || data.success !== true) {
            return false
        }

        // reCAPTCHA v3 امتیاز برمی‌گرداند؛ امتیاز پایین = احتمال bot
        if (typeof data.score === "number" && data.score < minScore) {
            return false
        }

        return true
    } catch {
        // شکست ارتباط با گوگل → fail-closed (بدون کرش کل برنامه)
        return false
    }
}
