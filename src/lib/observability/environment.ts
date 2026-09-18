// فاز ۲ — گام ۵: منبع محیط برای ستون `ErrorLog.environment` (سند فاز ۲ §8)
//
// قرارداد سند §8: «environment — optional — sourced from deployment/config — never hard-coded».
// بنابراین در این ماژول هیچ مقدار ثابتِ `production`/`development`/`staging` وجود ندارد؛
// فقط کلیدهای صریحی که deployment می‌تواند ست کند به ترتیب اولویت خوانده می‌شوند و
// در نبود همه‌ی آن‌ها مقدار `null` برمی‌گردد (ستون nullable است و همین رفتار حفظ می‌شود).
//
// الگوی ماژول: دقیقاً مثل `app/lib/billing/config.ts` — تابع خالص روی یک منبع env تزریق‌پذیر
// (`resolve*(env)`)، بدون cache و بدون خواندن در زمان import، تا تست‌پذیر و بدون side effect بماند.

/** منبع env — ساختار حداقلی و تزریق‌پذیر (سازگار با `process.env`). */
export type EnvironmentSource = Record<string, string | undefined>

/**
 * کلیدهای config محیط به ترتیب اولویت — اولین کلید ست‌شده برنده است.
 * `NODE_ENV` آخرین fallback است چون توسط runtime/platform مقداردهی می‌شود
 * (deployment می‌تواند با یکی از کلیدهای صریح قبلی آن را override کند).
 */
export const ENVIRONMENT_ENV_KEYS = [
    "APP_ENV",
    "DEPLOYMENT_ENV",
    "ENVIRONMENT",
    "NODE_ENV",
] as const

/**
 * resolveEnvironment — نام محیط برای رکورد ErrorLog.
 * - مقدار از config خوانده می‌شود (هرگز hard-code نمی‌شود).
 * - مقادیر خالی/whitespace نادیده گرفته می‌شوند.
 * - در نبود همه‌ی کلیدها → `null` (ستون nullable؛ هیچ مقدار حدسی ساخته نمی‌شود).
 */
export function resolveEnvironment(env: EnvironmentSource = process.env): string | null {
    for (const key of ENVIRONMENT_ENV_KEYS) {
        const raw = env[key]
        if (typeof raw !== "string") continue
        const value = raw.trim()
        if (value !== "") return value
    }
    return null
}
