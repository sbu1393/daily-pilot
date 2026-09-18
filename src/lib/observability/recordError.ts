// فاز صفر Observability — لاگ خطای ساختاریافته (Structured JSON)
// قرارداد Fail-Open: کل منطق داخل try/catch است؛ این تابع هرگز نباید ادامه‌ی
// پاسخ به کاربر را مختل کند.
//
// فاز ۲ — ارتقای recordError به pipeline کامل (سند فاز ۲ §14):
//   normalizeError → redactError → shouldPersistError → persistError → reportExternal
//
// - §14 (A3): تلاش persistence **همگام و پیش از پاسخ** است؛ `recordError` تا پایان
//   تلاش persist صبر می‌کند و آن را fire-and-forget رها نمی‌کند. persistError خودش
//   fail-open است (هرگز reject نمی‌کند) و timeout آن (۲ ثانیه) حفظ شده است.
// - §15: هیچ شکستی در telemetry به route نمی‌رسد؛ بدون retry loop و بدون recursion.
// - §21 (A4): پس از persist، رکورد redacted از مرز `reportExternal` می‌گذرد
//   (در فاز ۲ no-op و بدون vendor/network) و شکست آن swallow می‌شود.
// - §16 (A5): خروجی console یک فیلد `level` قطعی (مشتق از severity) دارد.
// - خروجی console فاز صفر دست‌نخورده باقی می‌ماند — رفتار قبلی حفظ شده است
//   (فقط فیلد الزامی `level` اضافه شده؛ سایر فیلدها/ترتیب/مقادیر تغییر نکرده‌اند).
// - بدون وابستگی به HTTP/Request/NextResponse؛ این ماژول کاملاً مستقل از لایه route است.

import { ServiceError } from "@/app/lib/services/errors"

import { normalizeError, type NormalizedErrorRecord } from "./normalizeError"
import { persistError } from "./persistError"
import { redactError } from "./redactError"
import { shouldPersistError } from "./persistencePolicy"
import { reportExternal } from "./reportExternal"
import { severityToConsoleLevel } from "./severityLevel"
import type { ErrorCategory, ErrorSeverity, ObservabilityContext } from "./types"

export interface RecordErrorMeta {
    category?: string
    severity?: string
}

// ---------- Redaction (فیلتر اطلاعات حساس قبل از چاپ) ----------

const SENSITIVE_KEY_PATTERN =
    /(password|passwd|pwd|passhash|passwordhash|password[_-]?hash|token|secret|credential|authorization|cookie|api[_-]?key|jwt|connection[_-]?string|database[_-]?url|private[_-]?key|card[_-]?number|cvc|cvv)/i
const INLINE_SECRET_PATTERN =
    /(password|passwd|pwd|passhash|passwordhash|password[_-]?hash|token|secret|credential|authorization|cookie|api[_-]?key|jwt|connection[_-]?string|database[_-]?url|private[_-]?key|card[_-]?number|cvc|cvv)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s'",;&}]+)/gi
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

// ---------- Phase 2 pipeline ----------

/** کد Prisma که normalization در metadata رکورد گذاشته (اگر وجود داشته باشد). */
function prismaCodeOf(record: NormalizedErrorRecord): string | undefined {
    const code = record.metadata?.prismaCode
    return typeof code === "string" ? code : undefined
}

/**
 * مرحله‌ی خالص pipeline فاز ۲: normalize → redact → policy.
 * - خروجی: رکورد redacted اگر policy اجازه‌ی persist بدهد؛ در غیر این صورت undefined.
 * - بدون I/O و بدون side effect (persist در caller و با await انجام می‌شود).
 */
function classifyForPersistence(
    error: unknown,
    context: ObservabilityContext,
): NormalizedErrorRecord | undefined {
    try {
        const normalized = normalizeError(error, context)
        const redacted = redactError(normalized)
        if (!shouldPersistError(redacted.errorCode, { prismaCode: prismaCodeOf(redacted) })) {
            return undefined
        }
        return redacted
    } catch {
        // fail-open مطلق — شکست classification هرگز مسیر درخواست را نمی‌شکند
        return undefined
    }
}

// ---------- Public API ----------

/**
 * خطا را به‌صورت Structured JSON در console.error چاپ می‌کند و (فاز ۲) پس از
 * normalize→redact→policy، در صورت مجوز policy در ErrorLog ذخیره می‌کند.
 *
 * §14/A3: تلاش persistence **همگام و پیش از بازگشت** است — این تابع یک Promise است و
 * تا پایان تلاش persist (با timeout محدود ۲ ثانیه) resolve نمی‌شود. هیچ
 * fire-and-forget ای وجود ندارد. در عین حال fail-open مطلق است و هرگز reject نمی‌کند،
 * پس await آن در route هرگز پاسخ کاربر را نمی‌شکند.
 *
 * قرارداد Phase 0 حفظ شده است: امضا (error, context, meta?) و خروجی console فاز صفر
 * (به‌علاوه‌ی فیلد الزامی `level` طبق §16) — تست‌های فاز صفر سبز می‌مانند.
 */
export async function recordError(
    error: unknown,
    context: ObservabilityContext,
    meta?: RecordErrorMeta,
): Promise<void> {
    // context نرمال‌شده — هم برای console و هم برای pipeline یکسان استفاده می‌شود
    // (بدون آن، رکورد persist در نبود context نمی‌توانست ساخته شود).
    const ctx: ObservabilityContext =
        context ?? { requestId: "unknown", endpoint: "unknown" }

    try {
        const isService = error instanceof ServiceError
        const normalized = normalizeForConsole(error)

        const category =
            meta && isCategory(meta.category)
                ? meta.category
                : isService
                  ? "BUSINESS_RULE"
                  : "UNKNOWN"
        const severity =
            meta && isSeverity(meta.severity) ? meta.severity : isService ? "WARNING" : "ERROR"

        const payload = {
            level: severityToConsoleLevel(severity),
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

    // فاز ۲ — pipeline persistence (بعد از console؛ شکستش مستقل از لاگ است)
    try {
        const redacted = classifyForPersistence(error, ctx)
        if (!redacted) return

        // A3 — تلاش همگام: تا پایان persist (یا timeout ۲ ثانیه‌ای آن) صبر می‌کنیم.
        // persistError هرگز reject نمی‌کند؛ بنابراین این await هرگز throw نمی‌کند.
        await persistError(redacted, ctx)

        // §14 گام ۵ / §21 — مرز external reporter (فاز ۲: no-op، بدون vendor/network).
        // عمداً await نمی‌شود تا هیچ درخواستی روی adapter آینده بلاک نشود (§29).
        reportExternal(redacted, ctx)
    } catch {
        // fail-open مطلق — حتی این نقطه هم هرگز throw نمی‌کند
    }
}
