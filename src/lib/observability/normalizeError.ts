// فاز ۲ — گام ۲: Normalization مرکزی و خالص (سند فاز ۲ §10)
//
// normalizeError(error, context) خطای خام را به ساختار normalized و امن برای مراحل
// بعدی (redaction → policy → persistence) تبدیل می‌کند.
//
// قواعد سند فاز ۲ (§10):
// - ServiceError: کد/status/پیام امن حفظ؛ category/severity از taxonomy §6 مشتق می‌شود.
// - Prisma (duck-typing روی error.code — بدون import از @prisma/client، مرز §9.11):
//     P2002 → CONFLICT / DATABASE ، P2025 → NOT_FOUND / DATABASE
// - Quota: QUOTA_EXCEEDED → 429 ، QUOTA_UNAVAILABLE → 503 (از taxonomy §6 — کد/status خود ServiceError)
// - Provider: AI_PROVIDER_UNAVAILABLE → 503
// - Billing/Entitlement (فاز ۵ — گام ۱۴): کدهای §20 در CODE_TAXONOMY نگاشت شده‌اند تا category/severity
//   اعلام‌شده‌ی خودشان حفظ شود (نه fallback INTERNAL/ERROR)
// - Unknown: INTERNAL / 500 با پیام امن generic
// - Serialization failure: رکورد حداقلی امن INTERNAL
//
// این تابع:
// - pure است (بدون side effect، بدون I/O)
// - persistence و console را صدا نمی‌زند
// - مسئول redaction کامل نیست (گام ۳) — اما هرگز داده‌ی حساس را عمداً از context/new metadata وارد خروجی نمی‌کند
// - implementation فاز صفر را replace نمی‌کند؛ این ماژول مستقل و canonical برای فاز ۲ است

import { ServiceError } from "@/app/lib/services/errors"

import type { ObservabilityContext } from "./types"

/** قرارداد خروجی سند فاز ۲ §10 */
export interface NormalizedErrorRecord {
    errorCode: string
    statusCode: number
    category: string
    severity: string
    safeMessage: string
    stack?: string
    metadata?: Record<string, unknown>
}

// ---------- Taxonomy (سند فاز ۲ §6) ----------
// کد → دسته/شدت. statusCode از خود ServiceError می‌آید (کدها با status ثبت شده‌اند).

const CODE_TAXONOMY: Record<string, { category: string; severity: string }> = {
    // VALIDATION — 400 — info
    VALIDATION_ERROR: { category: "VALIDATION", severity: "INFO" },
    MISSING_DAY_KEY: { category: "VALIDATION", severity: "INFO" },
    SAME_PASSWORD: { category: "VALIDATION", severity: "INFO" },
    // AUTH — 401 — warning
    INVALID_CREDENTIALS: { category: "AUTHENTICATION", severity: "WARNING" },
    UNAUTHORIZED: { category: "AUTHENTICATION", severity: "WARNING" },
    WRONG_PASSWORD: { category: "AUTHENTICATION", severity: "WARNING" },
    // NOT_FOUND — 404 — info
    NOT_FOUND: { category: "NOT_FOUND", severity: "INFO" },
    TASK_NOT_FOUND: { category: "NOT_FOUND", severity: "INFO" },
    USER_NOT_FOUND: { category: "NOT_FOUND", severity: "INFO" },
    NO_ROLLOVER_CANDIDATES: { category: "NOT_FOUND", severity: "INFO" },
    // CONFLICT — 409 — warning
    CONFLICT: { category: "CONFLICT", severity: "WARNING" },
    EMAIL_TAKEN: { category: "CONFLICT", severity: "WARNING" },
    USERNAME_TAKEN: { category: "CONFLICT", severity: "WARNING" },
    PLAN_STALE: { category: "CONFLICT", severity: "WARNING" },
    // BUSINESS — 400 — warning
    TASK_ALREADY_DONE: { category: "BUSINESS_RULE", severity: "WARNING" },
    TASK_NOT_ANALYZEABLE: { category: "BUSINESS_RULE", severity: "WARNING" },
    OVERDUE_TASK: { category: "BUSINESS_RULE", severity: "WARNING" },
    // QUOTA
    QUOTA_EXCEEDED: { category: "RATE_LIMIT", severity: "WARNING" }, // 429 — persist: NO
    QUOTA_UNAVAILABLE: { category: "DATABASE", severity: "ERROR" }, // 503 — persist: YES
    // PROVIDER
    AI_PROVIDER_UNAVAILABLE: { category: "EXTERNAL_SERVICE", severity: "ERROR" }, // 503 — persist: YES
    // CONFLICT (phase 1)
    IDEMPOTENCY_CONFLICT: { category: "CONFLICT", severity: "INFO" }, // 409
    AI_USAGE_CONFLICT: { category: "CONFLICT", severity: "WARNING" }, // 409
    // BILLING / ENTITLEMENT (Phase 5) — گام ۱۴ observability integration (سند فاز ۵ §۲۰/§۲۱/§۲۲)
    // category/severity دقیقاً همان مقداری است که taxonomy بیلینگ (app/lib/services/errors.ts)
    // اعلام می‌کند؛ پیش از این گام این کدها در فهرست نبودند و همه با fallback
    // INTERNAL/ERROR نرمال می‌شدند (اطلاعات operational taxonomy از دست می‌رفت).
    PAYMENT_PROVIDER_UNAVAILABLE: { category: "EXTERNAL_SERVICE", severity: "ERROR" }, // 503 — provider outage/timeout (persist)
    PAYMENT_PROVIDER_REJECTED: { category: "EXTERNAL_SERVICE", severity: "ERROR" }, // 503 — provider rejected create (persist)
    PAYMENT_PROVIDER_INVALID_RESPONSE: { category: "EXTERNAL_SERVICE", severity: "ERROR" }, // 503 — malformed provider response (persist)
    PAYMENT_STATE_UNRESOLVED: { category: "EXTERNAL_SERVICE", severity: "ERROR" }, // 503 — unreconcilable payment state (persist)
    PAYMENT_VERIFICATION_FAILED: { category: "EXTERNAL_SERVICE", severity: "ERROR" }, // 402 — definitive verification failure (persist)
    PAYMENT_INVALID_AMOUNT: { category: "CONFLICT", severity: "CRITICAL" }, // 409 — high-severity operational event (persist)
    PAYMENT_CONFIGURATION_ERROR: { category: "INTERNAL", severity: "CRITICAL" }, // 500 — invalid/missing server config (persist)
    ENTITLEMENT_CONFLICT: { category: "CONFLICT", severity: "WARNING" }, // 409 — invariant/concurrency failure (persist)
    PAYMENT_IDEMPOTENCY_CONFLICT: { category: "CONFLICT", severity: "INFO" }, // 409 — expected replay/compat conflict (ignore)
    PAYMENT_NOT_FOUND: { category: "NOT_FOUND", severity: "INFO" }, // 404 — expected not-found (ignore)
}

/** پیام امن generic برای خطاهای ناشناخته — جزئیات خام هرگز به کلاینت/لاگ نمی‌رود (§10) */
const UNKNOWN_SAFE_MESSAGE = "An unexpected error occurred"

// ---------- Helpers (pure) ----------

function isPrismaUniqueViolation(error: unknown): boolean {
    return (error as { code?: unknown })?.code === "P2002"
}

function isPrismaRecordNotFound(error: unknown): boolean {
    return (error as { code?: unknown })?.code === "P2025"
}

function safeExtractStack(error: unknown): string | undefined {
    const stack = (error as { stack?: unknown })?.stack
    return typeof stack === "string" ? stack : undefined
}

/**
 * پراپرتی‌های primitive خودِ خطای Prisma (به‌جز code/message/stack) به‌عنوان متادیتای
 * تشخیصی حفظ می‌شود تا لایه‌ی redaction (گام ۳) بتواند مقادیر حساس را redact کند.
 * فقط primitive (string/number/boolean) — آبجکت/آرایه (مثل meta) وارد خروجی نمی‌شود؛
 * قرارداد §10: محتوا عمداً و بدون سقف به رکورد تزریق نمی‌شود (bounded: حداکثر ۱۰ پراپرتی).
 */
function prismaExtraMetadata(error: object): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    try {
        const raw = error as Record<string, unknown>
        for (const key of Object.keys(raw)) {
            if (key === "code" || key === "message" || key === "stack") continue
            if (Object.keys(out).length >= 10) break
            const val = raw[key]
            if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
                out[key] = val
            }
        }
    } catch {
        return {}
    }
    return out
}

/** پیام را به رشته‌ی امن محدود می‌کند؛ در صورت شکست serialization، undefined (record حداقلی). */
function trySafeMessage(error: unknown): string | undefined {
    try {
        const raw = (error as { message?: unknown })?.message
        if (typeof raw === "string") return raw
        if (typeof error === "string") return error
        if (typeof error === "number" || typeof error === "boolean") return String(error)
        return undefined
    } catch {
        return undefined
    }
}

// ---------- Public API ----------

/**
 * normalizeError — نقطه‌ی مرکزی و خالص normalizing خطا (سند فاز ۲ §10).
 * خروجی فقط داده؛ هیچ persistence، console، یا side effect دیگری ندارد.
 */
export function normalizeError(
    error: unknown,
    context?: ObservabilityContext,
): NormalizedErrorRecord {
    try {
        // 1) ServiceError — کد/status/پیام امن حفظ، category/severity از taxonomy
        if (error instanceof ServiceError) {
            const tax = CODE_TAXONOMY[error.code] ?? {
                category: "INTERNAL",
                severity: "ERROR",
            }
            return {
                errorCode: error.code,
                statusCode: error.status,
                category: tax.category,
                severity: tax.severity,
                safeMessage: error.message,
                stack: safeExtractStack(error),
            }
        }

        // 2) Prisma known errors — duck-typing روی code (مرز §9.11، بدون import از @prisma/client)
        if (typeof error === "object" && error !== null) {
            if (isPrismaUniqueViolation(error)) {
                return {
                    errorCode: "CONFLICT",
                    statusCode: 409,
                    category: "CONFLICT",
                    severity: "WARNING",
                    safeMessage: "این مقدار قبلاً ثبت شده است",
                    stack: safeExtractStack(error),
                    metadata: { ...prismaExtraMetadata(error), prismaCode: "P2002" },
                }
            }
            if (isPrismaRecordNotFound(error)) {
                return {
                    errorCode: "NOT_FOUND",
                    statusCode: 404,
                    category: "NOT_FOUND",
                    severity: "INFO",
                    safeMessage: "رکورد موردنظر پیدا نشد",
                    stack: safeExtractStack(error),
                    metadata: { ...prismaExtraMetadata(error), prismaCode: "P2025" },
                }
            }
        }

        // 3) خطای دامنه‌ای شناخته‌شده با code — نگاشت بر اساس کد (بدون ServiceError بودن)
        if (typeof error === "object" && error !== null) {
            const code = (error as { code?: unknown }).code
            if (typeof code === "string" && CODE_TAXONOMY[code]) {
                const tax = CODE_TAXONOMY[code]
                const status = (error as { status?: unknown }).status
                return {
                    errorCode: code,
                    statusCode: typeof status === "number" ? status : 500,
                    category: tax.category,
                    severity: tax.severity,
                    safeMessage: trySafeMessage(error) ?? UNKNOWN_SAFE_MESSAGE,
                    stack: safeExtractStack(error),
                }
            }
        }

        // 4) Error استاندارد بدون code — INTERNAL با پیام امن generic (جزئیات خام خارج)
        if (error instanceof Error) {
            return {
                errorCode: "INTERNAL",
                statusCode: 500,
                category: "INTERNAL",
                severity: "ERROR",
                safeMessage: UNKNOWN_SAFE_MESSAGE,
                stack: safeExtractStack(error),
            }
        }

        // 5) مقادیر primitive — INTERNAL با پیام امن
        if (typeof error === "string" || typeof error === "number" || typeof error === "boolean") {
            return {
                errorCode: "INTERNAL",
                statusCode: 500,
                category: "INTERNAL",
                severity: "ERROR",
                safeMessage: UNKNOWN_SAFE_MESSAGE,
            }
        }

        // 6) آبجکت ناشناخته — INTERNAL، بدون واردکردن محتوای آن به خروجی
        return {
            errorCode: "INTERNAL",
            statusCode: 500,
            category: "INTERNAL",
            severity: "ERROR",
            safeMessage: UNKNOWN_SAFE_MESSAGE,
        }
    } catch {
        // Serialization failure (§10): رکورد حداقلی امن — حتی شکست normalize خودش خطا تولید نمی‌کند
        return {
            errorCode: "INTERNAL",
            statusCode: 500,
            category: "INTERNAL",
            severity: "ERROR",
            safeMessage: UNKNOWN_SAFE_MESSAGE,
        }
    }
}
