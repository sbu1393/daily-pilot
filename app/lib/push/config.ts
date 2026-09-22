// ADR-07 / Phase 3-A — VAPID configuration (سرور-محور).
//
// مسئولیت: فقط کلیدهای لازم برای ارسال Web Push از env خوانده می‌شوند.
// - کلید خصوصی هرگز log/return نمی‌شود و هرگز به client نمی‌رسد.
// - برخلاف billing (که fail-fast throw می‌کند)، نبود config این‌جا «ghost» نیست بلکه یک
//   حالت قابل‌انتظار است (ارسال Push اختیاری است): resolver نتیجه‌ی discriminated برمی‌گرداند
//   و هیچ‌جا crash نمی‌کند. نام کلیدها در پیام می‌آید، مقدار هرگز.
// - Public key سمت client همان `NEXT_PUBLIC_VAPID_PUBLIC_KEY` باقی می‌ماند (فاز ۲).

export const PUSH_ENV = {
    /** کلید عمومی VAPID سمت سرور (web-push). */
    publicKey: "VAPID_PUBLIC_KEY",
    /** کلید خصوصی VAPID — فقط سرور؛ هرگز به client نمی‌رسد. */
    privateKey: "VAPID_PRIVATE_KEY",
    /** subject (mailto: یا URL) — موردنیاز web-push. */
    subject: "VAPID_SUBJECT",
    /** کلید عمومی سمت client (فاز ۲) — همان مقدار کلید عمومی، نام متفاوت. */
    clientPublicKey: "NEXT_PUBLIC_VAPID_PUBLIC_KEY",
} as const

/** منبع env — تزریق‌پذیر تا resolver خالص و بدون env واقعی قابل تست باشد. */
export type PushEnvSource = Record<string, string | undefined>

export interface VapidConfig {
    readonly publicKey: string
    readonly privateKey: string
    readonly subject: string
}

export type PushConfigResult =
    | { ok: true; config: VapidConfig }
    | { ok: false; missing: string[] }

/** subject معتبر برای web-push: `mailto:` یا URL مطلق http(s). */
function isValidSubject(subject: string): boolean {
    if (subject.startsWith("mailto:")) return subject.length > "mailto:".length
    try {
        const url = new URL(subject)
        return url.protocol === "https:" || url.protocol === "http:"
    } catch {
        return false
    }
}

/**
 * resolve پیکربندی VAPID از یک منبع env — خالص و بدون I/O.
 * خروجی `ok:false` فقط نام کلیدهای غایب/نامعتبر را می‌دهد (هیچ مقدار secretی برنمی‌گردد).
 */
export function resolvePushConfig(env: PushEnvSource): PushConfigResult {
    const read = (key: string): string => (typeof env[key] === "string" ? env[key]!.trim() : "")

    const missing: string[] = []
    const publicKey = read(PUSH_ENV.publicKey)
    const privateKey = read(PUSH_ENV.privateKey)
    const subject = read(PUSH_ENV.subject)

    if (!publicKey) missing.push(PUSH_ENV.publicKey)
    if (!privateKey) missing.push(PUSH_ENV.privateKey)
    if (!subject) missing.push(PUSH_ENV.subject)
    else if (!isValidSubject(subject)) missing.push(PUSH_ENV.subject)

    if (missing.length > 0) return { ok: false, missing }

    return { ok: true, config: { publicKey, privateKey, subject } }
}

/** پیکربندی VAPID از environment فرایند (خواندن در لحظه‌ی فراخوانی، بدون cache). */
export function getPushConfig(): PushConfigResult {
    return resolvePushConfig(process.env)
}
