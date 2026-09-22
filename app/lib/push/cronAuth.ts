// ADR-07 فاز ۳-B — احراز مجوز endpoint زمان‌بند.
//
// هیچ endpoint عمومی برای trigger کردن Scheduler ساخته نمی‌شود. فقط با secret سرور
// (`CRON_SECRET`) قابل اجراست. اگر secret تنظیم نشده باشد، endpoint اجرا نمی‌شود
// (fail-closed) — نه اینکه بدون محافظت باز بماند.

export const CRON_SECRET_ENV = "CRON_SECRET" as const

export type CronAuthResult =
    | { ok: true }
    | { ok: false; status: number; code: string; message: string }

/** مقایسه‌ی constant-time بدون وابستگی به crypto (کاهش ریسک timing). */
function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i += 1) {
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
    }
    return diff === 0
}

/**
 * ورودی secret پذیرفته‌شده:
 * - `Authorization: Bearer <secret>`
 * - یا `x-cron-secret: <secret>`
 */
export function authorizeCronRequest(
    headers: { get: (name: string) => string | null },
    secret: string | undefined,
): CronAuthResult {
    const configured = typeof secret === "string" ? secret.trim() : ""
    if (!configured) {
        return {
            ok: false,
            status: 503,
            code: "CRON_NOT_CONFIGURED",
            message: "زمان‌بند پیکربندی نشده است",
        }
    }

    const authHeader = headers.get("authorization") ?? ""
    const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : ""
    const altHeader = (headers.get("x-cron-secret") ?? "").trim()
    const provided = bearer || altHeader

    if (!provided || !safeEqual(provided, configured)) {
        return { ok: false, status: 401, code: "UNAUTHORIZED", message: "Unauthorized" }
    }

    return { ok: true }
}
