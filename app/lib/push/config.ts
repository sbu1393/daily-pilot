/*
 * Web Push (VAPID) — پیکربندی سرور
 * ---------------------------------------------------------------
 * سه متغیر محیطی لازم است (هیچ‌کدام مقدار پیش‌فرض ندارند):
 *
 *   NEXT_PUBLIC_VAPID_PUBLIC_KEY  کلید عمومی VAPID (Base64URL، ~87 کاراکتر)
 *                                 «NEXT_PUBLIC_» است چون مرورگر هم باید آن را
 *                                 به pushManager.subscribe بدهد؛ بنابراین باید
 *                                 در **زمان build** هم موجود باشد.
 *   VAPID_PRIVATE_KEY             کلید خصوصی VAPID — فقط سرور (هرگز به client
 *                                 نمی‌رود، هرگز log نمی‌شود).
 *   VAPID_SUBJECT                 شناسه‌ی تماس مالک کلید: `mailto:you@example.com`
 *                                 یا یک URL https.
 *
 * تولید کلیدها: `npm run vapid:keys` (اسکریپت scripts/generate-vapid-keys.ts).
 *
 * این ماژول هیچ‌وقت throw نمی‌کند؛ مصرف‌کننده با `configured` تصمیم می‌گیرد
 * (تا نبودِ کلیدها فقط باعث «اعلان غیرفعال» شود، نه 500 در مسیرهای دیگر).
 */

export const PUSH_ENV = {
    publicKey: "NEXT_PUBLIC_VAPID_PUBLIC_KEY",
    privateKey: "VAPID_PRIVATE_KEY",
    subject: "VAPID_SUBJECT",
} as const

export type PushConfig = {
    publicKey: string
    privateKey: string
    subject: string
}

export type PushConfiguration =
    | { configured: true; config: PushConfig; missing: [] }
    | { configured: false; config: null; missing: string[] }

export type EnvLike = Record<string, string | undefined>

/** یک URL https یا mailto معتبر لازم است (قرارداد VAPID). */
export function isValidVapidSubject(subject: string): boolean {
    const trimmed = subject.trim()
    if (trimmed.startsWith("mailto:")) {
        return /^mailto:[^\s@]+@[^\s@]+$/.test(trimmed)
    }

    try {
        return new URL(trimmed).protocol === "https:"
    } catch {
        return false
    }
}

/**
 * خواندن پیکربندی Push از env. `missing` نام متغیرهای غایب/نامعتبر را برمی‌گرداند
 * تا پیام خطا و لاگ دقیق باشد — **هرگز مقدارها را برنمی‌گرداند**.
 */
export function readPushConfiguration(env: EnvLike = process.env): PushConfiguration {
    const publicKey = (env[PUSH_ENV.publicKey] ?? "").trim()
    const privateKey = (env[PUSH_ENV.privateKey] ?? "").trim()
    const subject = (env[PUSH_ENV.subject] ?? "").trim()

    const missing: string[] = []
    if (!publicKey) missing.push(PUSH_ENV.publicKey)
    if (!privateKey) missing.push(PUSH_ENV.privateKey)
    if (!subject) missing.push(PUSH_ENV.subject)
    else if (!isValidVapidSubject(subject)) missing.push(PUSH_ENV.subject)

    if (missing.length > 0) {
        return { configured: false, config: null, missing }
    }

    return { configured: true, config: { publicKey, privateKey, subject }, missing: [] }
}

export function isPushConfigured(env: EnvLike = process.env): boolean {
    return readPushConfiguration(env).configured
}
