// فاز ۲ — گام ۳: Redaction مرکزی + Metadata limits + Message/Stack safety (سند فاز ۲ §11/§12/§13)
//
// redactError(record): رکورد normalized گام ۲ را به نسخه‌ی امن برای persistence/console می‌کند.
// قرارداد سند §11: centralized، recursive، deterministic، fail-safe، قبل از هر persistence/external/console.
//
// تضمین‌ها:
// - pure: ورودی mutate نمی‌شود؛ بدون I/O؛ بدون console
// - deterministic: ورودی یکسان → خروجی یکسان
// - هرگز throw نمی‌کند (fail-safe؛ حتی throwing getter/toJSON/circular)
// - مقدار secret هرگز truncate/hash نمی‌شود؛ کامل [REDACTED] می‌شود
// - stack هرگز وارد safeMessage نمی‌شود

import type { NormalizedErrorRecord } from "./normalizeError"

// ---------- Sensitive key families (سند §11) ----------

const SENSITIVE_KEY_PATTERN =
    /(password|passwd|pwd|passhash|passwordhash|password_hash|hash|token|access[_-]?token|refresh[_-]?token|jwt|cookie|authorization|api[_-]?key|apikey|secret|private[_-]?key|connection[_-]?string|database[_-]?url|prompt|system[_-]?prompt|user[_-]?prompt|request[_-]?body|raw[_-]?request|body|response|raw[_-]?response|card|card[_-]?number|card[_-]?holder|cvc|cvv|pan|payment|billing|invoice|ssn|email|phone|address|firstname|first[_-]?name|lastname|last[_-]?name|username|authority|merchant[_-]?id|ref[_-]?id|reference|card[_-]?pan|card[_-]?hash)/i

/**
 * الگوهای inline «کلید=مقدار» / «کلید: مقدار» داخل متن‌ها.
 *
 * افزوده‌ی امنیتی (authority/merchant_id/ref_id/reference/card_pan/card_hash):
 * توکن‌های پرداخت زرین‌پال (Authority و ref_id و merchant_id) و داده‌ی کارت هرگز نباید
 * به‌صورت خام در message/stack/console ظاهر شوند — حتی اگر یک خطای آینده آن‌ها را در متن بگذارد.
 */
const INLINE_SECRET_PATTERN =
    /(password|passwd|pwd|passhash|passwordhash|token|access[_-]?token|refresh[_-]?token|jwt|cookie|authorization|api[_-]?key|apikey|secret|private[_-]?key|connection[_-]?string|database[_-]?url|cvc|cvv|authority|merchant[_-]?id|ref[_-]?id|reference|card[_-]?pan|card[_-]?hash)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s'",;&}]+)/gi

// ---------- Limits (قرارداد Phase 2) ----------

export const REDACTION_LIMITS = {
    /** حداکثر طول message بعد از sanitize (سند §12: حدود 2KB) */
    MESSAGE_MAX_CHARS: 2048,
    /** حداکثر طول stack بعد از sanitize (سند §12: حدود 4KB) */
    STACK_MAX_CHARS: 4096,
    /** حداکثر عمق metadata (قرارداد Phase 2) */
    METADATA_MAX_DEPTH: 2,
    /** حداکثر پراپرتی در هر آبجکت metadata */
    METADATA_MAX_PROPS: 20,
    /** حداکثر طول رشته در metadata */
    METADATA_STRING_MAX_CHARS: 128,
    /** حداکثر حجم serialized metadata (بایت UTF-8 ~ کاراکتر) */
    METADATA_MAX_SERIALIZED: 4096,
} as const

const REDACTED = "[REDACTED]"
const TRUNCATED = "[TRUNCATED]"
const REDACTION_FAILURE = "[REDACTION_FAILURE]"
const CIRCULAR = "[CIRCULAR]"
const MAX_ARRAY_ITEMS = 20

// ---------- Core helpers (pure) ----------

/** الگوهای inline secret داخل متن را می‌پوشاند؛ متن اصلی را truncate نمی‌کند. */
function redactInlineSecrets(text: string): string {
    try {
        return text.replace(INLINE_SECRET_PATTERN, (_m, key: string) => `${key}=${REDACTED}`)
    } catch {
        return text
    }
}

function truncate(text: string, max: number): string {
    return text.length <= max ? text : text.slice(0, max) + `…[${TRUNCATED}]`
}

function sanitizeText(text: string, max: number): string {
    try {
        return truncate(redactInlineSecrets(text), max)
    } catch {
        return ""
    }
}

/** خواندن امن پراپرتی — getter/Proxy انفجاری هرگز نباید redactor را ببیند. */
function safeEntries(value: Record<string, unknown>): [string, unknown][] {
    try {
        return Object.entries(value)
    } catch {
        // Object.entries با یک getter انفجاری به‌صورت کلی پرتاب می‌کند —
        // در حالت fallback کلیدبه‌کلید می‌خوانیم و کلید خراب را نشانگر شکست می‌گذاریم.
    }
    let keys: string[]
    try {
        keys = Object.getOwnPropertyNames(value)
    } catch {
        return []
    }
    const out: [string, unknown][] = []
    for (const key of keys) {
        try {
            out.push([key, (value as Record<string, unknown>)[key]])
        } catch {
            out.push([key, REDACTION_FAILURE])
        }
    }
    return out
}

/** مقدار کلید حساس → کاملاً [REDACTED] (هرگز truncate/hash نمی‌شود — §11) */
function redactSensitiveValue(): string {
    return REDACTED
}

/** فاصله‌گذاری امن در رشته — PII کامل حذف نمی‌شود؛ فقط length-limit (قرارداد گام ۳). */
function safeString(value: string, max: number): string {
    try {
        return truncate(redactInlineSecrets(value), max)
    } catch {
        return ""
    }
}

// ---------- Metadata limits (§13) ----------

interface MetaBudget {
    remaining: number // بودجه‌ی serialized باقی‌مانده
}

function estimateSize(value: unknown): number {
    try {
        const s = JSON.stringify(value)
        return s === undefined ? 0 : s.length
    } catch {
        return 0
    }
}

/**
 * sanitize بازگشتی metadata با سقف عمق/پراپرتی/طول/حجم.
 * در overflow: پراپرتی‌های اضافه حذف و کلید نشانگر [TRUNCATED] گذاشته می‌شود.
 *
 * معنای عمق (قرارداد Phase 2 — «max depth: 2» برای سطوح آبجکتی):
 * - ورود به آبجکت تودرتو یک سطح عمق مصرف می‌کند؛ آبجکتی با عمق > 2 → [TRUNCATED]
 * - آرایه «شفاف» است: سطح عمقی مصرف نمی‌کند تا sensitive keys داخل آرایه‌های
 *   تودرتو در هر عمق مجاز redact شوند (آیتم‌ها در همان عمقِ آرایه پردازش می‌شوند)
 * - seen-guard: مرجع حلقوی (آبجکت/آرایه) → [CIRCULAR] بدون crash
 */
function sanitizeMetadata(
    value: unknown,
    depth: number,
    budget: MetaBudget,
    seen: WeakSet<object>,
): unknown {
    if (budget.remaining <= 0) return TRUNCATED

    if (typeof value === "string") return safeString(value, REDACTION_LIMITS.METADATA_STRING_MAX_CHARS)
    if (typeof value === "number" || typeof value === "boolean" || value === null) return value

    if (Array.isArray(value)) {
        if (seen.has(value)) return CIRCULAR
        seen.add(value)
        const out: unknown[] = []
        for (const item of value.slice(0, MAX_ARRAY_ITEMS)) {
            // آرایه شفاف است — آیتم‌ها در همان عمق پردازش می‌شوند
            out.push(sanitizeMetadata(item, depth, budget, seen))
            if (budget.remaining <= 0) {
                out.push(TRUNCATED)
                break
            }
        }
        budget.remaining -= estimateSize(out)
        return out
    }

    if (typeof value === "object") {
        if (depth > REDACTION_LIMITS.METADATA_MAX_DEPTH) return TRUNCATED
        if (seen.has(value)) return CIRCULAR
        seen.add(value)

        const entries = safeEntries(value as Record<string, unknown>)
        const out: Record<string, unknown> = {}
        for (const [key, val] of entries.slice(0, REDACTION_LIMITS.METADATA_MAX_PROPS)) {
            if (budget.remaining <= 0) {
                out[TRUNCATED] = TRUNCATED
                break
            }
            // کلید حساس در metadata هم کامل redact می‌شود
            if (SENSITIVE_KEY_PATTERN.test(key)) {
                out[key] = redactSensitiveValue()
                continue
            }
            // آبجکت تودرتو یک سطح عمق مصرف می‌کند؛ آرایه/پریمیتیو در همان عمق می‌مانند
            const childDepth =
                val !== null && typeof val === "object" && !Array.isArray(val) ? depth + 1 : depth
            out[key] = sanitizeMetadata(val, childDepth, budget, seen)
        }
        budget.remaining -= estimateSize(out)
        if (entries.length > REDACTION_LIMITS.METADATA_MAX_PROPS) {
            out[TRUNCATED] = TRUNCATED
        }
        return out
    }

    // undefined / function / symbol و … — غیرقابل serialize، حذف امن
    return undefined
}

/** متادیتای نهایی: سقف 4KB serialized با fail-safe fallback */
function safeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (metadata === undefined) return undefined
    const budget: MetaBudget = { remaining: REDACTION_LIMITS.METADATA_MAX_SERIALIZED }
    const seen = new WeakSet<object>()
    try {
        const out = sanitizeMetadata(metadata, 0, budget, seen) as Record<string, unknown>
        if (estimateSize(out) > REDACTION_LIMITS.METADATA_MAX_SERIALIZED) {
            // fail-safe: به جای پرتاب، رکورد حداقلی
            return { [TRUNCATED]: TRUNCATED }
        }
        return out
    } catch {
        return { [TRUNCATED]: TRUNCATED }
    }
}

// ---------- Public API ----------

/**
 * redactError — رکورد normalized را به نسخه‌ی امن تبدیل می‌کند.
 * - sensitive keys (case-insensitive) در هر عمق → کامل [REDACTED]
 * - inline secrets داخل safeMessage/stack ماسک می‌شوند
 * - message ≤ 2KB، stack ≤ 4KB، stack هرگز وارد safeMessage نمی‌شود
 * - metadata: depth 2، 20 props، string 128، serialized ≤ 4KB — با fail-safe fallback
 * - ورودی mutate نمی‌شود؛ deterministic؛ هرگز throw نمی‌کند
 */
export function redactError(record: NormalizedErrorRecord): NormalizedErrorRecord {
    try {
        const out: NormalizedErrorRecord = {
            errorCode: record.errorCode,
            statusCode: record.statusCode,
            category: record.category,
            severity: record.severity,
            safeMessage: sanitizeText(record.safeMessage ?? "", REDACTION_LIMITS.MESSAGE_MAX_CHARS),
        }

        const stack = record.stack
        out.stack = typeof stack === "string" ? sanitizeText(stack, REDACTION_LIMITS.STACK_MAX_CHARS) : undefined

        const meta = safeMetadata(record.metadata)
        out.metadata = meta

        return out
    } catch {
        // fail-safe: حتی شکست کل redaction باید یک رکورد امن برگرداند
        return {
            errorCode: "INTERNAL",
            statusCode: 500,
            category: "INTERNAL",
            severity: "ERROR",
            safeMessage: "[REDACTION_FAILURE]",
        }
    }
}

/**
 * redactValue — نسخه‌ی عمومی برای مقدارهای دلخواه (nested object/array).
 * برای تست و مصرف آینده‌ی external reporter. همان قواعد sensitive keys.
 * depth سقف عمق بازگشت؛ مقدار secret کامل [REDACTED] می‌شود.
 */
export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
    try {
        if (depth > 8) return TRUNCATED
        if (typeof value === "string") return safeString(value, REDACTION_LIMITS.METADATA_STRING_MAX_CHARS)
        if (typeof value === "number" || typeof value === "boolean" || value === null) return value

        if (typeof value === "object") {
            if (seen.has(value as object)) return "[CIRCULAR]"
            seen.add(value as object)

            if (Array.isArray(value)) {
                return value.slice(0, MAX_ARRAY_ITEMS).map((v) => redactValue(v, depth + 1, seen))
            }

            const out: Record<string, unknown> = {}
            for (const [key, val] of safeEntries(value as Record<string, unknown>)) {
                out[key] = SENSITIVE_KEY_PATTERN.test(key)
                    ? redactSensitiveValue()
                    : redactValue(val, depth + 1, seen)
            }
            return out
        }

        return undefined // function / symbol / undefined
    } catch {
        return "[REDACTION_FAILURE]"
    }
}
