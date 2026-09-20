// تأیید سمت سرور توکن Cloudflare Turnstile (siteverify).
//
// طراحی:
// - فقط server-side: TURNSTILE_SECRET_KEY هرگز به کلاینت نمی‌رود.
// - fail-closed: هر شکست پیکربندی/شبکه/اعتبارسنجی → false (درخواست رد می‌شود،
//   نه اینکه عبور کند).
// - action و hostname از روی *تنظیمات سرور* اعتبارسنجی می‌شوند؛ نه از Host header
//   کنترل‌نشده و نه از مقادیر قابل‌تغییر توسط کلاینت.
// - بدون وابستگی خارجی: fetch استاندارد Node 18+ / Next.js Route Handler.
// - تشخیص‌پذیری: هر رد شدن با یک لاگ ساختاریافته (`[turnstile]`) ثبت می‌شود تا
//   «تیک سبز کلاینت ولی رد سرور» قابل ریشه‌یابی باشد — بدون لاگ کردن secret یا
//   مقدار کامل توکن (فقط boolean و طول).

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

/** نام متغیر محیطی allowlist دامنه‌ها (با کاما جدا می‌شود). */
const ALLOWED_HOSTNAMES_ENV = "TURNSTILE_ALLOWED_HOSTNAMES"

/** تایماوت پیش‌فرض درخواست به Cloudflare (میلی‌ثانیه). */
const DEFAULT_TIMEOUT_MS = 5000

/** پیشوند ثابت همه‌ی لاگ‌های این ماژول (برای فیلترکردن در لاگ سرور). */
const LOG_PREFIX = "[turnstile]"

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

/**
 * دلیل رد شدن تأیید — همان ترتیب fail-closed داکیومنت `verifyTurnstile`.
 * در لاگ تشخیصی به‌عنوان `reason` چاپ می‌شود.
 */
export type TurnstileFailureReason =
    | "MISSING_SECRET"
    | "EMPTY_TOKEN"
    | "PRODUCTION_WITHOUT_ALLOWLIST"
    | "HTTP_ERROR"
    | "INVALID_JSON"
    | "NOT_SUCCESS"
    | "HOSTNAME_NOT_ALLOWED"
    | "ACTION_MISMATCH"
    | "NETWORK_ERROR"

/**
 * لاگ تشخیصی ساختاریافته (فقط سرور).
 *
 * قواعد امنیتی:
 * - `TURNSTILE_SECRET_KEY` هرگز لاگ نمی‌شود؛ فقط boolean بودن آن (`hasSecret`).
 * - توکن Turnstile هرگز به‌طور کامل لاگ نمی‌شود؛ فقط boolean بودن (`hasToken`) و
 *   طول آن (`tokenLength`) — برای تشخیص توکن خالی/ناقص.
 * - بدنه‌ی درخواست ارسالی به Cloudflare لاگ نمی‌شود.
 */
function logDiagnostic(reason: TurnstileFailureReason, fields: Record<string, unknown>): void {
    console.warn(`${LOG_PREFIX} rejected: ${reason}`, { reason, ...fields })
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
 *
 * هر مسیر شکست دقیقاً یک لاگ `[turnstile] rejected: <reason>` می‌نویسد؛ مقدار
 * بازگشتی با نسخه‌ی قبلی یکسان است (لاگ هیچ رفتاری را تغییر نمی‌دهد).
 */
export async function verifyTurnstile(
    token: string,
    options: VerifyTurnstileOptions = {},
): Promise<boolean> {
    const secret = process.env.TURNSTILE_SECRET_KEY
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const allowlist = parseAllowedHostnames(process.env[ALLOWED_HOSTNAMES_ENV])

    // زمینه‌ی تشخیصی مشترک — فقط اطلاعات غیرحساس (boolean/طول/نام‌ها).
    const baseDiagnostics = {
        hasSecret: typeof secret === "string" && secret.trim() !== "",
        hasToken: typeof token === "string" && token.trim() !== "",
        tokenLength: typeof token === "string" ? token.length : 0,
        expectedAction: options.expectedAction ?? null,
        allowlistConfigured: allowlist.length > 0,
        nodeEnv: process.env.NODE_ENV ?? null,
    }

    // پیکربندی ناقص یا ورودی خالی → fail-closed
    if (!secret || secret.trim() === "" || !token || token.trim() === "") {
        logDiagnostic(baseDiagnostics.hasSecret ? "EMPTY_TOKEN" : "MISSING_SECRET", baseDiagnostics)
        return false
    }

    // در production بدون allowlist نمی‌توان دامنه را اعتبارسنجی کرد → fail-closed.
    // (در محیط‌های توسعه/تست، نبودِ allowlist مجاز است تا dev بدون پیکربندی کار کند.)
    if (allowlist.length === 0 && process.env.NODE_ENV === "production") {
        logDiagnostic("PRODUCTION_WITHOUT_ALLOWLIST", baseDiagnostics)
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
            logDiagnostic("HTTP_ERROR", { ...baseDiagnostics, httpStatus: res.status })
            return false
        }

        const data = (await res.json().catch(() => null)) as SiteVerifyResponse | null
        if (!data) {
            logDiagnostic("INVALID_JSON", baseDiagnostics)
            return false
        }

        if (data.success !== true) {
            // error-codes دقیقاً همان چیزی است که علت رد را مشخص می‌کند
            // (مثلاً invalid-input-secret / invalid-input-response / timeout-or-duplicate).
            logDiagnostic("NOT_SUCCESS", {
                ...baseDiagnostics,
                errorCodes: data["error-codes"] ?? null,
                returnedHostname: data.hostname ?? null,
                returnedAction: data.action ?? null,
            })
            return false
        }

        // دامنه‌ی مجاز (در صورت پیکربندی allowlist)
        const hostnameAllowed = allowlist.length === 0 || isHostnameAllowed(data.hostname, allowlist)

        // action مورد انتظار سرور (هرگز از بدنه‌ی درخواست خوانده نمی‌شود)
        const actionAllowed =
            options.expectedAction === undefined || data.action === options.expectedAction

        if (!hostnameAllowed || !actionAllowed) {
            // هر دو نتیجه با هم لاگ می‌شوند تا در یک خط مشخص شود کدام شرط رد کرده است.
            logDiagnostic(hostnameAllowed ? "ACTION_MISMATCH" : "HOSTNAME_NOT_ALLOWED", {
                ...baseDiagnostics,
                returnedHostname: data.hostname ?? null,
                allowedHostnames: allowlist,
                hostnameAllowed,
                returnedAction: data.action ?? null,
                expectedAction: options.expectedAction ?? null,
                actionAllowed,
            })
            return false
        }

        return true
    } catch (error) {
        // تایماوت / خطای شبکه / پاسخ غیرقابل‌تجزیه → fail-closed (بدون کرش برنامه)
        logDiagnostic("NETWORK_ERROR", {
            ...baseDiagnostics,
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
        })
        return false
    }
}
