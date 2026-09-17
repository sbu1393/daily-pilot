// فاز ۳ — گام ۳: قرارداد ProductEvent (Taxonomy + Validation)
// Source of Truth: monitoring/فاز سه.docx — §7 (Taxonomy), §8 (Allowlists), §10 (Validation)
//
// این ماژول کاملاً pure و deterministic است:
// - هیچ وابستگی به Prisma، HTTP، request object یا runtime state ندارد.
// - هیچ‌وقت throw نمی‌کند؛ همیشه یک ProductEventValidationResult امن برمی‌گرداند.
// - هیچ serialization خودکار از آبجکت دلخواه انجام نمی‌دهد؛ فقط allowlist صریح.
// - سازگار با redaction/whitelist فاز ۰/۲: خروجی فقط شامل مقادیر safe و bounded است.

// ============================================================================
// Taxonomy — دقیقاً ۱۱ رویداد (§7). هر نام خارج از این لیست reject می‌شود.
// ============================================================================

export const PRODUCT_EVENT_NAMES = [
    "auth.login_succeeded",
    "task.created",
    "task.updated",
    "task.completed",
    "task.deleted",
    "task.rolled_over",
    "ai.analysis_succeeded",
    "planner.day_viewed",
    "planner.suggestion_viewed",
    "planner.history_viewed",
    "profile.updated",
] as const

export type ProductEventName = (typeof PRODUCT_EVENT_NAMES)[number]

// ============================================================================
// Property allowlists — دقیقاً طبق §8 سند. هیچ کلید خارج از این لیست‌ها
// (case-sensitive) پذیرفته نمی‌شود.
// ============================================================================

/** auth.login_succeeded — هیچ propertyی تعریف نشده است. */
const AUTH_LOGIN_SUCCEEDED = [] as const

/** task.created — فقط شناسه و متادیتای safe؛ هرگز محتوای task (title/description). */
const TASK_CREATED = ["taskId", "category", "status"] as const

/** task.updated — شناسه + نام فیلدهای تغییرکرده (نه مقادیر). */
const TASK_UPDATED = ["taskId", "changedFields"] as const

/** task.completed — شناسه + متادیتای اتمام. */
const TASK_COMPLETED = ["taskId", "category", "status"] as const

/** task.deleted — فقط شناسه. */
const TASK_DELETED = ["taskId"] as const

/** task.rolled_over — شناسه + مقصد انتقال (dayKey). */
const TASK_ROLLED_OVER = ["taskId", "toDayKey"] as const

/**
 * ai.analysis_succeeded — فقط متادیتای safe که هم‌اکنون در context در دسترس است.
 * هرگز prompt/response/provider payload/داده‌ی خام AI.
 */
const AI_ANALYSIS_SUCCEEDED = ["units", "aiSource", "status"] as const

/** planner.* — هیچ propertyی. */
const PLANNER_DAY_VIEWED = [] as const
const PLANNER_SUGGESTION_VIEWED = [] as const
const PLANNER_HISTORY_VIEWED = [] as const

/**
 * profile.updated — فقط نام فیلدهای تغییرکرده؛ هرگز email/phone/مقدار.
 */
const PROFILE_UPDATED = ["changedFields"] as const

/** نگاشت event → allowlist (readonly tuple از نام‌های مجاز). */
const ALLOWLISTS: Readonly<Record<ProductEventName, readonly string[]>> = {
    "auth.login_succeeded": AUTH_LOGIN_SUCCEEDED,
    "task.created": TASK_CREATED,
    "task.updated": TASK_UPDATED,
    "task.completed": TASK_COMPLETED,
    "task.deleted": TASK_DELETED,
    "task.rolled_over": TASK_ROLLED_OVER,
    "ai.analysis_succeeded": AI_ANALYSIS_SUCCEEDED,
    "planner.day_viewed": PLANNER_DAY_VIEWED,
    "planner.suggestion_viewed": PLANNER_SUGGESTION_VIEWED,
    "planner.history_viewed": PLANNER_HISTORY_VIEWED,
    "profile.updated": PROFILE_UPDATED,
}

/** دسترسی فقط‌خواندنی به allowlist یک event (برای تست/مستندسازی). */
export function getAllowedProperties(eventName: ProductEventName): readonly string[] {
    return ALLOWLISTS[eventName]
}

// ============================================================================
// محدودیت‌های قرارداد (§10) — قفل‌شده
// ============================================================================

export const PRODUCT_EVENT_LIMITS = {
    /** حداکثر تعداد property در یک رویداد. */
    maxProperties: 20,
    /** حداکثر طول هر کلید. */
    maxKeyLength: 128,
    /** حداکثر عمق nesting (depth 1 = مقدار scalar؛ depth 2 = یک سطح تو در تو مجاز). */
    maxDepth: 2,
    /** حداکثر حجم JSON serialized (UTF-8 bytes). */
    maxSerializedBytes: 4 * 1024,
} as const

// ============================================================================
// انواع خروجی
// ============================================================================

export type ProductEventProperty = string | number | boolean | null

/** properties امن‌شده: فقط allowlist، فقط scalar (depth 1) یا آرایه‌ی scalar (depth 2). */
export type ProductEventProperties = Record<string, ProductEventProperty | ProductEventProperty[]>

export type ProductEventValidationResult =
    | { valid: true; eventName: ProductEventName; properties: ProductEventProperties }
    | { valid: false; reason: ProductEventValidationFailure }

export type ProductEventValidationFailure =
    | "unknown_event"
    | "properties_not_object"
    | "unknown_property"
    | "too_many_properties"
    | "key_too_long"
    | "depth_exceeded"
    | "value_not_serializable"
    | "payload_too_large"

// ============================================================================
// Validation — pure، deterministic، بدون throw
// ============================================================================

/** تشخیص آبجکت ساده (نه آرایه، نه wrapperهای Date/Map/Set/RegExp). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        !isBuiltInWrapper(value)
    )
}

function isBuiltInWrapper(value: object): boolean {
    return (
        value instanceof Date ||
        value instanceof Map ||
        value instanceof Set ||
        value instanceof RegExp
    )
}

/**
 * اعتبارسنجی یک رویداد ProductEvent.
 *
 * قواعد (§10):
 * - eventName خارج از taxonomy → invalid (unknown_event)
 * - properties باید آبجکت ساده باشد (undefined/null → {})
 * - کلید خارج از allowlist → invalid (unknown_property)
 * - بیش از ۲۰ property → invalid
 * - کلید بلندتر از ۱۲۸ → invalid
 * - عمق بیشتر از ۲ → invalid (آبجکت تو در تو، آبجکت داخل آرایه)
 * - مقدار غیر JSON-primitive → invalid
 * - JSON serialized > 4KB → invalid
 * - هرگز throw نمی‌کند — هر ورودی خرابی مسیر امن invalid را طی می‌کند.
 */
export function validateProductEvent(
    eventName: unknown,
    properties: unknown,
): ProductEventValidationResult {
    // Fail-safe بیرونی: هیچ ورودی خصمانه‌ای نباید باعث throw شود
    // (Proxy با ownKeys/get انفجاری، Object.keys خراب و...).
    try {
        return validateProductEventInner(eventName, properties)
    } catch {
        return { valid: false, reason: "value_not_serializable" }
    }
}

function validateProductEventInner(
    eventName: unknown,
    properties: unknown,
): ProductEventValidationResult {
    // 1) eventName باید دقیقاً عضو taxonomy باشد
    if (
        typeof eventName !== "string" ||
        !(PRODUCT_EVENT_NAMES as readonly string[]).includes(eventName)
    ) {
        return { valid: false, reason: "unknown_event" }
    }
    const name = eventName as ProductEventName

    // 2) properties: undefined/null → {}؛ غیر آبجکت → reject
    if (properties === undefined || properties === null) {
        return { valid: true, eventName: name, properties: {} }
    }
    if (!isPlainObject(properties)) {
        return { valid: false, reason: "properties_not_object" }
    }

    const allowed = ALLOWLISTS[name]
    const keys = safeKeys(properties)

    // 3) سقف تعداد property (قبل از پیمایش؛ شامل کلیدهای unknown هم هست)
    if (keys.length > PRODUCT_EVENT_LIMITS.maxProperties) {
        return { valid: false, reason: "too_many_properties" }
    }

    const safe: ProductEventProperties = {}

    // 4) پیمایش deterministic (کلیدها به ترتیب درج)
    for (const key of keys) {
        // 4a) محدودیت طول کلید — قبل از allowlist تا خروجی برای کلیدهای بلند
        //     همیشه key_too_long باشد (deterministic و قابل تست)
        if (key.length > PRODUCT_EVENT_LIMITS.maxKeyLength) {
            return { valid: false, reason: "key_too_long" }
        }
        // 4b) allowlist صریح — هیچ serialization دلخواه مجاز نیست
        if (!allowed.includes(key)) {
            return { valid: false, reason: "unknown_property" }
        }

        const value = readSafe(properties, key)
        if (value === READ_FAILED) {
            return { valid: false, reason: "value_not_serializable" }
        }

        // 4c) نرمال‌سازی و بررسی عمق/نوع
        const normalized = normalizeValue(value)
        if (normalized === INVALID) {
            return { valid: false, reason: "value_not_serializable" }
        }
        if (normalized === TOO_DEEP) {
            return { valid: false, reason: "depth_exceeded" }
        }
        safe[key] = normalized
    }

    // 5) سقف حجم serialized (4KB — UTF-8 bytes)
    const serialized = JSON.stringify(safe)
    if (serialized !== undefined && byteLength(serialized) > PRODUCT_EVENT_LIMITS.maxSerializedBytes) {
        return { valid: false, reason: "payload_too_large" }
    }

    return { valid: true, eventName: name, properties: safe }
}

// ---------------------------------------------------------------------------
// کمکی‌های داخلی pure
// ---------------------------------------------------------------------------

const INVALID = Symbol("invalid")
const TOO_DEEP = Symbol("too_deep")
const READ_FAILED = Symbol("read_failed")

type Normalized =
    | ProductEventProperty
    | ProductEventProperty[]
    | typeof INVALID
    | typeof TOO_DEEP

/**
 * نرمال‌سازی یک مقدار:
 * - depth 1: string/number/boolean/null مستقیم؛ undefined حذف نمیشود بلکه INVALID نیست —
 *   کلید با مقدار undefined به‌صورت invalid نیست ولی در JSON حذف می‌شود؛ برای deterministic
 *   بودن، آن را invalid نمی‌کنیم و مستقیم null می‌گیریم.
 * - depth 2 (سقف): آرایه‌ی یک‌بعدی از scalarها (طبق §22 برای changedFields).
 * - depth 3+: آبجکت تو در تو یا آبجکت/آرایه داخل آرایه → TOO_DEEP.
 */
function normalizeValue(value: unknown): Normalized {
    if (value === undefined) return null
    if (value === null) return null
    const t = typeof value
    if (t === "string") return value as string
    if (t === "number") {
        // NaN/Infinity در JSON.stringify به null تبدیل می‌شوند → غیردقیق؛ reject
        if (!Number.isFinite(value as number)) return INVALID
        return value as number
    }
    if (t === "boolean") return value as boolean
    if (t === "bigint") return INVALID

    if (Array.isArray(value)) {
        const out: ProductEventProperty[] = []
        for (const item of value) {
            if (item === undefined) {
                out.push(null)
                continue
            }
            const it = typeof item
            if (it === "string") {
                out.push(item as string)
            } else if (it === "number" && Number.isFinite(item as number)) {
                out.push(item as number)
            } else if (it === "boolean") {
                out.push(item as boolean)
            } else if (item === null) {
                out.push(null)
            } else {
                // آبجکت/آرایه/undefined-های خاص داخل آرایه → عمق ۳ → reject
                return TOO_DEEP
            }
        }
        return out
    }

    // آبجکت ساده در depth 1 → کل مقدار آبجکت depth 3 حساب می‌شود (allowlist ما
    // هیچ کلید آبجکتی ندارد) → TOO_DEEP؛ wrapperهای Date/Map/... هم همین‌طور.
    return TOO_DEEP
}

/** خواندن امن یک property — getter انفجاری/Proxy خراب هرگز throw نمی‌کند. */
function readSafe(obj: Record<string, unknown>, key: string): unknown {
    try {
        return obj[key]
    } catch {
        return READ_FAILED
    }
}

/** فهرست کلیدهای امن — ownKeys انفجاری هرگز throw نمی‌کند. */
function safeKeys(obj: Record<string, unknown>): string[] {
    try {
        return Object.keys(obj)
    } catch {
        return []
    }
}

/** طول UTF-8 رشته (بدون TextEncoder برای سازگاری — محاسبه‌ی دستی deterministic). */
function byteLength(str: string): number {
    let bytes = 0
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i)
        if (code < 0x80) bytes += 1
        else if (code < 0x800) bytes += 2
        else if (code >= 0xd800 && code <= 0xdbff) {
            // surrogate pair → یک کاراکتر ۴ بایتی
            bytes += 4
            i++
        } else bytes += 3
    }
    return bytes
}
