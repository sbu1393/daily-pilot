// G-09 — Service Layer: خطاهای سرویس
// Route فقط status/message را به شکل Envelope ADR-04 ({ ok:false, error:{code,message,errors?} })
// به Client برمی‌گرداند (A6).

// فاز صفر Observability — دسته‌بندی/شدت اختیاری خطا.
// کاملاً Backward Compatible: پارامترهای جدید اختیاری‌اند و هیچ فراخوانی قبلی سازنده نمی‌شکند.
import type { ErrorCategory, ErrorSeverity } from "@/src/lib/observability/types"

export class ServiceError extends Error {
    readonly status: number
    readonly code: string
    readonly errors?: unknown
    readonly category?: ErrorCategory
    readonly severity?: ErrorSeverity

    constructor(
        status: number,
        code: string,
        message: string,
        errors?: unknown,
        category?: ErrorCategory,
        severity?: ErrorSeverity,
    ) {
        super(message)
        this.name = new.target.name
        this.status = status
        this.code = code
        this.errors = errors
        this.category = category
        this.severity = severity
    }
}

// A6 — بدنه‌ی خالص Envelope خطا (بدون NextResponse — قابل تست در vitest)
// ترتیب: ابتدا ServiceError دامنه؛ سپس نگاشت زیرساخت (Prisma known errors) — E1/§9.11.
// خطاهای ناشناخته → null تا مسیر 500 عمومی بدون تغییر بماند.
export function toServiceErrorBody(
    error: unknown,
): { ok: false; error: { code: string; message: string; errors?: unknown } } | null {
    if (error instanceof ServiceError) {
        const body: { ok: false; error: { code: string; message: string; errors?: unknown } } = {
            ok: false,
            error: { code: error.code, message: error.message },
        }
        if (error.errors !== undefined) body.error.errors = error.errors
        return body
    }

    const infra = toServiceErrorFromInfrastructure(error)
    if (infra) return toServiceErrorBody(infra)

    return null
}

// ---------- Infrastructure: known Prisma error mapping (E1 — §9.11 boundary) ----------
// طبق §9.11: Domain هرگز نباید به کد خطای Prisma وابسته باشد؛ شناخت کد Prisma فقط
// در همین مرز خطا/زیرساخت انجام می‌شود. تشخیص با duck-typing روی error.code است —
// بدون import از @prisma/client (وابستگی ساختاری، نه نوعی).
// جدول کدها از §9.3/§9.4 معماری: 409 CONFLICT / 404 NOT_FOUND.

const PRISMA_UNIQUE_VIOLATION = "P2002"
const PRISMA_RECORD_NOT_FOUND = "P2025"

/**
 * اگر خطا یک Prisma known-request error شناخته‌شده باشد، معادل ServiceError را برمی‌گرداند؛
 * در غیر این صورت null — تا مسیر خطای عمومی فعلی بدون تغییر ادامه یابد.
 * جزئیات خام Prisma هرگز به Client نمی‌رسد.
 */
export function toServiceErrorFromInfrastructure(error: unknown): ServiceError | null {
    if (typeof error !== "object" || error === null) return null
    const code = (error as { code?: unknown }).code
    if (typeof code !== "string") return null

    switch (code) {
        case PRISMA_UNIQUE_VIOLATION:
            return new ServiceError(409, "CONFLICT", "این مقدار قبلاً ثبت شده است")
        case PRISMA_RECORD_NOT_FOUND:
            return new ServiceError(404, "NOT_FOUND", "رکورد موردنظر پیدا نشد")
        default:
            return null
    }
}

// ---------- Tasks ----------

export class TaskNotFoundError extends ServiceError {
    constructor() {
        super(404, "TASK_NOT_FOUND", "تسک پیدا نشد")
    }
}

export class MissingDayKeyError extends ServiceError {
    constructor() {
        super(400, "MISSING_DAY_KEY", "تاریخ برنامه‌ریزی تسک نامعتبر است")
    }
}

export class TaskAlreadyDoneError extends ServiceError {
    constructor() {
        super(400, "TASK_ALREADY_DONE", "این تسک قبلاً تمام شده است")
    }
}

export class TaskNotAnalyzeableError extends ServiceError {
    constructor(status: "DONE" | "IN_PROGRESS") {
        super(
            400,
            "TASK_NOT_ANALYZEABLE",
            status === "DONE"
                ? "تسک انجام‌شده را نمی‌توان دوباره تحلیل کرد"
                : "تسک در حال انجام را نمی‌توان دوباره تحلیل کرد",
        )
    }
}

export class OverdueTaskError extends ServiceError {
    constructor() {
        super(400, "OVERDUE_TASK", "این تسک مربوط به روزهای گذشته است؛ اول آن را به امروز منتقل کن.")
    }
}

export class NoRolloverCandidatesError extends ServiceError {
    constructor() {
        super(404, "NO_ROLLOVER_CANDIDATES", "تسکی برای انتقال پیدا نشد")
    }
}

// ---------- Planner / Blueprint (A1 Phase 4) ----------

/**
 * A1 Phase 4 — گارد نسخه‌ی blueprint: کاربر پیشنهادی را تأیید می‌کند که بر اساس نسخه‌ی
 * پلنی ساخته شده که دیگر جاری نیست (§6.3.2: هر mutation مؤثر planVersion را بالا می‌برد).
 * 409 Conflict → Client فقط باید پیشنهاد تازه بگیرد؛ هیچ داده‌ای نوشته نمی‌شود.
 */
export class PlanStaleError extends ServiceError {
    constructor() {
        super(
            409,
            "PLAN_STALE",
            "برنامه‌ی امروز با تغییرات اخیر همخوان نیست؛ پیشنهاد تازه را ببین و دوباره تأیید کن",
        )
    }
}

// ---------- Auth / Users ----------

export class EmailTakenError extends ServiceError {
    constructor() {
        super(409, "EMAIL_TAKEN", "این ایمیل قبلا ثبت شده")
    }
}

export class InvalidCredentialsError extends ServiceError {
    constructor() {
        super(401, "INVALID_CREDENTIALS", "ایمیل یا رمز عبور اشتباه است")
    }
}

export class UserNotFoundError extends ServiceError {
    constructor() {
        super(404, "USER_NOT_FOUND", "کاربری یافت نشد")
    }
}

export class WrongPasswordError extends ServiceError {
    constructor() {
        super(401, "WRONG_PASSWORD", "رمز عبور فعلی اشتباه است")
    }
}

export class SamePasswordError extends ServiceError {
    constructor() {
        super(400, "SAME_PASSWORD", "رمز عبور جدید باید با رمز فعلی متفاوت باشد")
    }
}

export class UsernameTakenError extends ServiceError {
    constructor() {
        super(409, "USERNAME_TAKEN", "این نام کاربری قبلاً استفاده شده است")
    }
}

// ---------- فاز ۱ — Quota / Idempotency ----------
// نگاشت کدها طبق سند فاز یک (§19/§20):
// QUOTA_EXCEEDED / IDEMPOTENCY_CONFLICT / AI_USAGE_CONFLICT → business/conflict → recordError = false
// QUOTA_UNAVAILABLE / AI_PROVIDER_UNAVAILABLE → زیرساختی/وابستگی → recordError = true (fail-closed)
// category/severity برای recordError و فیلتر آینده‌ی لاگ‌ها هستند (فاز صفر).

/** 429 — ظرفیت ماهانه تمام شده؛ business/expected — recordError = false */
export class QuotaExceededError extends ServiceError {
    constructor() {
        super(429, "QUOTA_EXCEEDED", "سهمیه‌ی ماهانه‌ی هوش مصنوعی تمام شده است", undefined, "RATE_LIMIT", "INFO")
    }
}

/** 503 — خرابی DB کووتا؛ infrastructure fail-closed — recordError = true */
export class QuotaUnavailableError extends ServiceError {
    constructor() {
        super(503, "QUOTA_UNAVAILABLE", "سرویس سهمیه در دسترس نیست؛ بعداً تلاش کن", undefined, "DATABASE", "CRITICAL")
    }
}

/** 503 — شکست نهایی provider؛ dependency failure — recordError = true */
export class AiProviderUnavailableError extends ServiceError {
    constructor() {
        super(503, "AI_PROVIDER_UNAVAILABLE", "سرویس هوش مصنوعی در دسترس نیست؛ بعداً تلاش کن", undefined, "EXTERNAL_SERVICE", "ERROR")
    }
}

/** 409 — درخواست تکراری با requestId مشابه غیرقابل replay — recordError = false */
export class IdempotencyConflictError extends ServiceError {
    constructor() {
        super(409, "IDEMPOTENCY_CONFLICT", "این درخواست قبلاً ثبت شده است", undefined, "CONFLICT", "INFO")
    }
}

/** 409 — transition نامعتبر در چرخه‌ی حیات event — recordError = false مگر unexpected */
export class AiUsageConflictError extends ServiceError {
    constructor() {
        super(409, "AI_USAGE_CONFLICT", "وضعیت رویداد مصرف با درخواست سازگار نیست", undefined, "CONFLICT", "WARNING")
    }
}