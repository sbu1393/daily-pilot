// فاز ۲ — گام ۳: Persistence Policy (سند فاز ۲ §6/§19)
//
// shouldPersistError(errorCode) → boolean
// ErrorLog فقط تاریخچه‌ی عملیاتی مفید را نگه می‌دارد؛ خطاهای عادی کاربر آن را پر نمی‌کنند.
//
// Policy سند (§19) — persist=false:
//   VALIDATION_ERROR، MISSING_DAY_KEY، SAME_PASSWORD،
//   NOT_FOUND (expected)، TASK_NOT_FOUND، USER_NOT_FOUND، NO_ROLLOVER_CANDIDATES،
//   QUOTA_EXCEEDED، IDEMPOTENCY_CONFLICT (repeated request قابل replay نیست)
//   AUTH subset (INVALID_CREDENTIALS/UNAUTHORIZED/WRONG_PASSWORD): «subset منتخب» سند —
//   در فاز ۲ default سیاست: ignore (تا security-telemetry bounded آینده تصمیم بگیرد)
//   CONFLICT/BUSINESS «selected operational cases»: در فاز ۲ default: ignore (حدس نزدیم)
//
// persist=true (سند §19):
//   QUOTA_UNAVAILABLE، AI_PROVIDER_UNAVAILABLE،
//   DATABASE infrastructure (CONFLICT/P2002-mapped، NOT_FOUND/P2025-mapped infra، سایر infra)،
//   INTERNAL، INTERNAL-classified unknowns
//
// نکته‌ی ambiguity صریح (گزارش‌شده در پایان گام):
// - «selected operational cases» برای CONFLICT/BUSINESS/AUTH در سند باز گذاشته شده؛
//   حدس نزدیم و همه را ignore کردیم. فعال‌سازی موارد خاص نیازمند تصمیم مهدی است.

/** کدهایی که طبق §19 هرگز نباید در ErrorLog ذخیره شوند */
const NON_PERSISTENT_CODES: ReadonlySet<string> = new Set([
    // VALIDATION
    "VALIDATION_ERROR",
    "MISSING_DAY_KEY",
    "SAME_PASSWORD",
    // AUTH (subset منتخب سند — default: ignore)
    "INVALID_CREDENTIALS",
    "UNAUTHORIZED",
    "WRONG_PASSWORD",
    // NOT_FOUND (expected)
    "NOT_FOUND",
    "TASK_NOT_FOUND",
    "USER_NOT_FOUND",
    "NO_ROLLOVER_CANDIDATES",
    // QUOTA
    "QUOTA_EXCEEDED",
    // CONFLICT (expected user/business — selected cases نیازمند تصمیم صریح است)
    "CONFLICT",
    "EMAIL_TAKEN",
    "USERNAME_TAKEN",
    "PLAN_STALE",
    "IDEMPOTENCY_CONFLICT",
    "AI_USAGE_CONFLICT",
    // BUSINESS (expected user errors)
    "TASK_ALREADY_DONE",
    "TASK_NOT_ANALYZEABLE",
    "OVERDUE_TASK",
])

/** کدهایی که طبق §19 همیشه باید ذخیره شوند */
const PERSISTENT_CODES: ReadonlySet<string> = new Set([
    "QUOTA_UNAVAILABLE",
    "AI_PROVIDER_UNAVAILABLE",
    "INTERNAL",
])

/**
 * shouldPersistError — تعیین ذخیره‌سازی رکورد خطا در ErrorLog.
 * - کد شناخته‌شده → طبق جدول سند
 * - کد ناشناخته → محافظه‌کارانه persist=true (خطای عملیاتی قابل مشاهده باشد؛ fail-open تلمتری مستقل از این تصمیم است)
 */
export function shouldPersistError(errorCode: string): boolean {
    if (PERSISTENT_CODES.has(errorCode)) return true
    if (NON_PERSISTENT_CODES.has(errorCode)) return false
    return true
}
