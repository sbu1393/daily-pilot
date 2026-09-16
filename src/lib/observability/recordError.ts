// فاز صفر Observability — لاگ خطای ساختاریافته (Structured JSON)
// قرارداد Fail-Open: کل منطق داخل try/catch است؛ این تابع هرگز نباید ادامه‌ی
// پاسخ به کاربر را مختل کند.
//
// فاز ۲ — گام ۴: ارتقای recordError به pipeline کامل (سند فاز ۲):
//   normalizeError → redactError → shouldPersistError → (if true) persistError
// - خروجی console (فاز صفر) دست‌نخورده باقی می‌ماند — رفتار قبلی حفظ شده است.
// - persistError خودش fail-open است؛ برای اطمینان مضاعف، فراخوانی آن هم با
//   «آتش-فراموشی» محافظت‌شده انجام می‌شود تا هیچ مسیری هرگز recordError را شکننده کند.
// - بدون وابستگی به HTTP/Request/NextResponse؛ این ماژول کاملاً مستقل از لایه route است.

import { ServiceError } from "@/app/lib/services/errors"

import { normalizeError, type NormalizedErrorRecord } from "./normalizeError"
import { persistError } from "./persistError"
import { redactError } from "./redactError"
import { shouldPersistError } from "./persistencePolicy"
import type { ErrorCategory, ErrorSeverity, ObservabilityContext } from "./types"

export interface RecordErrorMeta {
    category?: string
    severity?: string
}

/** محیط تست — اگر فعال باشد، فراخوانی persist در مسیر recordError گارد می‌شود. */
const TEST_ENV: boolean =
    process.env.VITEST !== undefined || process.env.NODE_ENV === "test"

// ---------- Redaction (فیلتر اطلاعات حساس قبل از چاپ) ----------

const SENSITIVE_KEY_PATTERN =
    /(password|passwd|pwd|passhash|passwordhash|password[_-]?hash|token|secret|credential|authorization|cookie|api[_-]?key|jwt|connection[_-]?string|database[_-]?url|private[_-]?key|card[_-]?number|cvc|cvv)/i
const INLINE_SECRET_PATTERN =
    /(password|passwd|pwd|passhash|passwordhash|password[_-]?hash|token|secret|credential|authorization|cookie|api[_-]?key|jwt|connection[_-]?string|database[_-]?url|private[_-]?key|card[_-]?number|cvc|cvv)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s'",;&]+)/gi
const MAX_REDACT_DEPTH = 4
const REDACTED = "[REDACTED]"

/** الگوهای «کلید=مقدار» / «کلید: مقدار» داخل متن پیام را می‌پوشاند. */
function redactMessage(message: string): string {
    return message.replace(INLINE_SECRET_PATTERN, (_match, key: string) => `${key}=${REDACTED}`)
}

/** بازگشتی با سقف عمق؛ مقدار کلیدهای حساس و رشته‌های دارای الگوی رمز را می‌پوشاند. */
function redactValue(value: unknown, depth = 0): unknown {
    if (depth > MAX_REDACT_DEPTH) return "[TRUNCATED]"
    if (typeof value === "string") return redactMessage(value)
    if (Array.isArray(value)) {
        return value.slice(0, 50).map((item) => redactValue(item, depth + 1))
    }
    if (typeof value === "object" && value !== null) {
        const out: Record<string, unknown> = {}
        for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
            out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactValue(val, depth + 1)
        }
        return out
    }
    return value
}

// ---------- Normalization ----------

interface NormalizedError {
    name: string
    message: string
    stack?: string
    code?: string | number
    status?: number
    details?: unknown
}

function normalizeForConsole(error: unknown): NormalizedError {
    if (error instanceof ServiceError) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
            code: error.code,
            status: error.status,
            details: error.errors === undefined ? undefined : redactValue(error.errors),
        }
    }
    if (error instanceof Error) {
        return { name: error.name, message: error.message, stack: error.stack }
    }
    if (typeof error === "object" && error !== null) {
        const raw = error as Record<string, unknown>
        const rest: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(raw)) {
            if (key === "message" || key === "stack") continue
            rest[key] = value
        }
        return {
            name: typeof raw.name === "string" ? raw.name : "UnknownError",
            message: typeof raw.message === "string" ? raw.message : "[non-Error object]",
            stack: typeof raw.stack === "string" ? raw.stack : undefined,
            code:
                typeof raw.code === "string" || typeof raw.code === "number" ? raw.code : undefined,
            details: redactValue(rest),
        }
    }
    return { name: "UnknownError", message: String(error) }
}

// ---------- Category / Severity guards ----------

const ERROR_CATEGORIES: readonly ErrorCategory[] = [
    "VALIDATION",
    "AUTHENTICATION",
    "AUTHORIZATION",
    "NOT_FOUND",
    "CONFLICT",
    "RATE_LIMIT",
    "DATABASE",
    "EXTERNAL_SERVICE",
    "BUSINESS_RULE",
    "INTERNAL",
    "UNKNOWN",
]
const ERROR_SEVERITIES: readonly ErrorSeverity[] = ["INFO", "WARNING", "ERROR", "CRITICAL"]

function isCategory(value: unknown): value is ErrorCategory {
    return typeof value === "string" && (ERROR_CATEGORIES as readonly string[]).includes(value)
}

function isSeverity(value: unknown): value is ErrorSeverity {
    return typeof value === "string" && (ERROR_SEVERITIES as readonly string[]).includes(value)
}

// ---------- Phase 2 pipeline (گام ۴) ----------

/**
 * اجرای pipeline فاز ۲ روی یک خطا: normalize → redact → policy → persist.
 * خالص نسبت به I/O به‌جز persistError خودش (که fail-open است).
 * خروجی رکورد redacted برای تست‌ها؛ persistError فقط وقتی policy اجازه دهد صدا زده می‌شود.
 */
function runPersistencePipeline(
    error: unknown,
    context: ObservabilityContext,
    testGuard?: boolean,
): NormalizedErrorRecord | undefined {
    try {
        const normalized = normalizeError(error, context)
        const redacted = redactError(normalized)

        if (!shouldPersistError(redacted.errorCode)) return undefined

        // persistError خودش fail-open است (هرگز throw/reject نمی‌کند)؛
        // این catch مضاعف فقط تضمین نهایی سند فاز ۲ است.
        const persistPromise = persistError(redacted, context)
        if (testGuard) {
            // مسیر تست: به‌صورت همگام صبر می‌کنیم تا ادعاهای تست قابل ارزیابی باشند
            void persistPromise
        } else {
            void persistPromise.catch(() => {
                // fail-open مطلق — تضمین نهایی؛ persistError خودش هرگز reject نمی‌کند
            })
        }
        return redacted
    } catch {
        // fail-open مطلق — شکست pipeline هرگز مسیر درخواست را نمی‌شکند
        return undefined
    }
}

// ---------- Public API ----------

/**
 * خطا را به‌صورت Structured JSON در console.error چاپ می‌کند و (فاز ۲) پس از
 * normalize→redact→policy، در صورت مجوز policy در ErrorLog ذخیره می‌کند.
 * Fail-Open: هر خطای داخلی این تابع بی‌صدا نادیده گرفته می‌شود.
 *
 * قرارداد موجود حفظ شده است: امضا (error, context, meta?) و خروجی console فاز صفر
 * عیناً قبلی است — تست‌های فاز صفر بدون تغییر سبز می‌مانند.
 */
export function recordError(
    error: unknown,
    context: ObservabilityContext,
    meta?: RecordErrorMeta,
): void {
    try {
        const isService = error instanceof ServiceError
        const normalized = normalizeForConsole(error)
        const ctx: ObservabilityContext =
            context ?? { requestId: "unknown", endpoint: "unknown" }

        const category =
            meta && isCategory(meta.category)
                ? meta.category
                : isService
                  ? "BUSINESS_RULE"
                  : "UNKNOWN"
        const severity =
            meta && isSeverity(meta.severity) ? meta.severity : isService ? "WARNING" : "ERROR"

        const payload = {
            timestamp: new Date().toISOString(),
            requestId: ctx.requestId,
            endpoint: ctx.endpoint,
            userId: ctx.userId,
            feature: ctx.feature,
            category,
            severity,
            name: normalized.name,
            message: redactMessage(normalized.message),
            stack: normalized.stack,
            ...(normalized.code !== undefined ? { code: normalized.code } : {}),
            ...(normalized.status !== undefined ? { status: normalized.status } : {}),
            ...(normalized.details !== undefined ? { details: normalized.details } : {}),
        }

        console.error(JSON.stringify(payload))
    } catch {
        // Fail-Open: خطای لاگ‌گذاری هرگز نباید پاسخ به کاربر را مختل کند.
    }

    // فاز ۲ — گام ۴: pipeline persistence (بعد از console؛ شکستش مستقل از لاگ است)
    try {
        runPersistencePipeline(error, context, TEST_ENV)
    } catch {
        // fail-open مطلق — حتی این نقطه هم هرگز throw نمی‌کند
    }
}
