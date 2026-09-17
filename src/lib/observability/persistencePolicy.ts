// فاز ۲ — گام ۳: Persistence Policy (سند فاز ۲ §6/§19)
//
// shouldPersistError(errorCode) → boolean
// ErrorLog فقط تاریخچه‌ی عملیاتی مفید را نگه می‌دارد؛ خطاهای عادی کاربر آن را پر نمی‌کنند.
//
// Policy سند (§19) — persist=false:
//   VALIDATION_ERROR، MISSING_DAY_KEY، SAME_PASSWORD،
//   NOT_FOUND (expected)، TASK_NOT_FOUND، USER_NOT_FOUND، NO_ROLLOVER_CANDIDATES،
//   QUOTA_EXCEEDED، IDEMPOTENCY_CONFLICT (repeated request قابل replay نیست)،
//   PAYMENT_NOT_FOUND، PAYMENT_IDEMPOTENCY_CONFLICT (فاز ۵ — گام ۱۴)
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
//
// فاز ۵ — گام ۱۴: کدهای billing در همین policy دسته‌بندی شدند (سند فاز ۵ §۲۲ + سند فاز ۲ §۱۹):
// - شکست‌های عملیاتی billing (provider unavailable/rejected/invalid-response، state unresolved،
//   verification failure، amount mismatch، entitlement conflict، configuration failure) در
//   هیچ‌یک از دو فهرست نیستند و طبق default این policy **persist** می‌شوند — دقیقاً همان چیزی که
//   §۲۲ می‌خواهد («Record operational failures»).
// - تنها دو کد «انتظاری/بی‌سر‌و‌صدا» به فهرست ignore اضافه شدند: `PAYMENT_NOT_FOUND`
//   (معادل NOT_FOUND → ignore) و `PAYMENT_IDEMPOTENCY_CONFLICT` (معادل normal user conflict → ignore،
//   مثل IDEMPOTENCY_CONFLICT فاز ۱).

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
    // BILLING (فاز ۵ — گام ۱۴): انتظاری/تکراری و بدون ارزش عملیاتی در ErrorLog
    "PAYMENT_NOT_FOUND",
    "PAYMENT_IDEMPOTENCY_CONFLICT",
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
