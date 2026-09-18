// فاز ۲ — گام ۳: Persistence Policy (سند فاز ۲ §6/§19)
//
// shouldPersistError(errorCode, classification) → boolean
// ErrorLog فقط تاریخچه‌ی عملیاتی مفید را نگه می‌دارد؛ خطاهای عادی کاربر آن را پر نمی‌کنند.
//
// تصمیم قفل‌شده (قرارداد implementation — A1/A2):
//   persist=true:
//     QUOTA_UNAVAILABLE، AI_PROVIDER_UNAVAILABLE، INTERNAL
//     + database infrastructure failures، از جمله خطای Prisma که **normalization contract**
//       آن را infrastructure علامت زده باشد (P2002 → metadata.prismaCode = "P2002").
//     (P2025 یک not-found انتظاری است و تابع همین policy باقی می‌ماند — §6)
//   persist=false:
//     QUOTA_EXCEEDED، validation errors، authentication/authorization errors،
//     not-found errors، expected user/business conflicts (CONFLICT/EMAIL_TAKEN/…).
//
// نکته‌ی مهم: سیاست فقط بر پایه‌ی کد (و صراحتاً classification خطای Prisma) تصمیم می‌گیرد؛
// هرگز از HTTP status برای استنتاج persistence استفاده نمی‌شود.
// کد «CONFLICT» به‌صورت **عام** persistent نمی‌شود (expected user conflict)؛ فقط P2002 —
// که در normalization به همان کد نگاشت می‌شود ولی در metadata با prismaCode متمایز است — persistent است.
//
// Policy سند (§19) — persist=false (continued):
//   VALIDATION_ERROR، MISSING_DAY_KEY، SAME_PASSWORD،
//   NOT_FOUND (expected)، TASK_NOT_FOUND، USER_NOT_FOUND، NO_ROLLOVER_CANDIDATES،
//   QUOTA_EXCEEDED، IDEMPOTENCY_CONFLICT (repeated request قابل replay نیست)،
//   PAYMENT_NOT_FOUND، PAYMENT_IDEMPOTENCY_CONFLICT (فاز ۵ — گام ۱۴)
//   AUTH subset (INVALID_CREDENTIALS/UNAUTHORIZED/WRONG_PASSWORD): «subset منتخب» سند —
//   در فاز ۲ default سیاست: ignore (تا security-telemetry bounded آینده تصمیم بگیرد)
//   CONFLICT/BUSINESS «selected operational cases»: در فاز ۲ default: ignore (حدس نزدیم)
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
 * کدهای Prisma که برای observability «database infrastructure» محسوب می‌شوند (سند §6 — A2).
 * این کدها در `metadata.prismaCode` رکورد normalized حاضرند (normalization contract).
 * `P2025` عمداً این‌جا نیست: یک not-found انتظاری است و تابع همین policy می‌ماند (ignore).
 */
export const PERSISTENT_PRISMA_CODES: ReadonlySet<string> = new Set(["P2002"])

/** طبقه‌بندی تکمیلی که normalization در metadata رکورد می‌گذارد. */
export interface PersistenceClassification {
    /** کد Prisma (P2002/P2025/…) — از `record.metadata.prismaCode` */
    prismaCode?: string | null
}

/**
 * shouldPersistError — تعیین ذخیره‌سازی رکورد خطا در ErrorLog.
 * - کد شناخته‌شده → طبق جدول سند
 * - کد ناشناخته → محافظه‌کارانه persist=true (خطای عملیاتی قابل مشاهده باشد؛ fail-open تلمتری مستقل از این تصمیم است)
 */
export function shouldPersistError(
    errorCode: string,
    classification: PersistenceClassification = {},
): boolean {
    // database infrastructure طبق §6 — قبل از جدول کدها، چون کد عمومی «CONFLICT»
    // در جدول NON_PERSISTENT است و نباید P2002 را با conflict انتظاری کاربر قاطی کند.
    const prismaCode = classification.prismaCode
    if (typeof prismaCode === "string" && PERSISTENT_PRISMA_CODES.has(prismaCode)) return true

    if (PERSISTENT_CODES.has(errorCode)) return true
    if (NON_PERSISTENT_CODES.has(errorCode)) return false
    return true
}
