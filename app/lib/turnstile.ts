// تأیید سمت سرور توکن Cloudflare Turnstile (siteverify).
//
// طراحی:
// - فقط server-side: TURNSTILE_SECRET_KEY هرگز به کلاینت نمی‌رود.
// - fail-closed: هر شکست پیکربندی/شبکه/اعتبارسنجی → false (درخواست رد می‌شود،
//   نه اینکه عبور کند).
// - action و hostname از روی *تنظیمات سرور* اعتبارسنجی می‌شوند؛ نه از Host header
//   کنترل‌نشده و نه از مقادیر قابل‌تغییر توسط کلاینت.
// - بدون وابستگی خارجی: fetch استاندارد Node 18+ / Next.js Route Handler.

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

/** نام متغیر محیطی allowlist دامنه‌ها (با کاما جدا می‌شود). */
const ALLOWED_HOSTNAMES_ENV = "TURNSTILE_ALLOWED_HOSTNAMES"

/** تایماوت پیش‌فرض درخواست به Cloudflare (میلی‌ثانیه). */
const DEFAULT_TIMEOUT_MS = 5000

/** پاسخ Cloudflare siteverify — فقط فیلدهای موردنیاز. */
interface SiteVerifyResponse {
    success?: boolean
    "error-codes"?: string[]
    hostname?: string
    action?: string
}

export interface VerifyTurnstileOptions {
    /** action مورد انتظار برای این endpoint (از ثابت‌های سرور). */
    expectedAction?: string
    /** IP بازدیدکننده — در صورت وجود به siteverify پاس داده می‌شود. */
    remoteIp?: string
    /** تایماوت درخواست به Cloudflare (ms). پیش‌فرض ۵۰۰۰. */
    timeoutMs?: number
}

/** خواندن allowlist دامنه‌ها از env: "example.com, *.preview.example.com" */
function parseAllowedHostnames(raw: string | undefined): string[] {
    return (raw ?? "")
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0)
}

/**
 * آیا hostname برگشتی Cloudflare مجاز است؟
 * - تطابق دقیق: `example.com`
 * - وایلکارد زیر‌دامنه‌ها: `*.example.com` (شامل خود `example.com` نمی‌شود)
 */
function isHostnameAllowed(hostname: string | undefined, allowlist: string[]): boolean {
    if (!hostname) return false
    const value = hostname.trim().toLowerCase()
    return allowlist.some((pattern) =>
        pattern.startsWith("*.")
            ? value.endsWith(pattern.slice(1)) && value.length > pattern.length - 1
            : value === pattern,
    )
}

/**
 * verifyTurnstile — تأیید توکن Turnstile دریافت‌شده از کلاینت.
 *
 * ترتیب fail-closed:
 * 1. نبود secret → false (بدون تماس شبکه)
 * 2. توکن خالی/فقط فاصله → false (بدون تماس شبکه)
 * 3. در production، نبودِ allowlist دامنه → false (بدون تماس شبکه؛ هیچ bypass ای
 *    برای production وجود ندارد)
 * 4. خطای HTTP/شبکه/تایماوت/JSON خراب → false
 * 5. success !== true (توکن نامعتبر، منقضی یا مصرف‌شده) → false
 * 6. در صورت تنظیم allowlist: hostname پاسخ باید مجاز باشد → در غیر این صورت false
 * 7. در صورت تعیین expectedAction: action پاسخ باید دقیقاً همان باشد → در غیر این صورت false
 */
export async function verifyTurnstile(
    token: string,
    options: VerifyTurnstileOptions = {},
): Promise<boolean> {
    const secret = process.env.TURNSTILE_SECRET_KEY
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const allowlist = parseAllowedHostnames(process.env[ALLOWED_HOSTNAMES_ENV])

    // پیکربندی ناقص یا ورودی خالی → fail-closed
    if (!secret || secret.trim() === "" || !token || token.trim() === "") {
        return false
    }

    // در production بدون allowlist نمی‌توان دامنه را اعتبارسنجی کرد → fail-closed.
    // (در محیط‌های توسعه/تست، نبودِ allowlist مجاز است تا dev بدون پیکربندی کار کند.)
    if (allowlist.length === 0 && process.env.NODE_ENV === "production") {
        return false
    }

    try {
        const body = new URLSearchParams({ secret, response: token })
        if (options.remoteIp) body.set("remoteip", options.remoteIp)

        const res = await fetch(SITEVERIFY_URL, {
            method: "POST",
            body,
            signal: AbortSignal.timeout(timeoutMs),
        })

        if (!res.ok) {
            return false
        }

        const data = (await res.json().catch(() => null)) as SiteVerifyResponse | null
        if (!data || data.success !== true) {
            return false
        }

        // دامنه‌ی مجاز (در صورت پیکربندی allowlist)
        if (allowlist.length > 0 && !isHostnameAllowed(data.hostname, allowlist)) {
            return false
        }

        // action مورد انتظار سرور (هرگز از بدنه‌ی درخواست خوانده نمی‌شود)
        if (options.expectedAction !== undefined && data.action !== options.expectedAction) {
            return false
        }

        return true
    } catch {
        // تایماوت / خطای شبکه / پاسخ غیرقابل‌تجزیه → fail-closed (بدون کرش برنامه)
        return false
    }
}
