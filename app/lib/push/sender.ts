import webpush from "web-push"
import { resolvePushConfig, type PushEnvSource, type VapidConfig } from "./config"
import { taskReminderPayloadSchema } from "./payload"

// ADR-07 / Phase 3-A — abstraction ارسال Web Push (فقط سرور).
//
// این ماژول فقط «ارسال یک Push مشخص» را انجام می‌دهد. هیچ Scheduler، هیچ query
// `reminderAt <= now` و هیچ route زمان‌بندی در این فاز ساخته نمی‌شود؛ آماده‌سازی برای فاز بعد.
//
// - VAPID از config سرور configure می‌شود (کلید خصوصی هرگز به payload/client نمی‌رود).
// - payload قبل از ارسال با schema اعتبارسنجی می‌شود (ورودی نامعتبر = invalid_payload، بدون ارسال).
// - خطاهای Web Push مدیریت می‌شوند: 404/410 → gone (subscription مرده)، بقیه → failed.

export type PushSenderSubscription = {
    endpoint: string
    p256dh: string
    auth: string
}

export type SendPushResult =
    | { ok: true; statusCode: number }
    | { ok: false; reason: "not_configured" | "invalid_payload" | "gone" | "failed"; statusCode?: number }

/** فقط برای تست/سازگاری: یک بار VAPID را configure می‌کند (بدون no-op شدن روی اسرار). */
export function configureVapid(config: VapidConfig): void {
    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey)
}

function readStatusCode(error: unknown): number | undefined {
    if (typeof error !== "object" || error === null) return undefined
    const statusCode = (error as { statusCode?: unknown }).statusCode
    return typeof statusCode === "number" ? statusCode : undefined
}

/**
 * ارسال یک اعلان Web Push به یک subscription ذخیره‌شده.
 * @param envSource برای تست‌پذیری؛ پیش‌فرض `process.env`.
 */
export async function sendPushNotification(
    subscription: PushSenderSubscription,
    payload: unknown,
    options?: { ttlSeconds?: number; envSource?: PushEnvSource },
): Promise<SendPushResult> {
    const parsed = taskReminderPayloadSchema.safeParse(payload)
    if (!parsed.success) return { ok: false, reason: "invalid_payload" }

    const config = resolvePushConfig(options?.envSource ?? process.env)
    if (!config.ok) return { ok: false, reason: "not_configured" }

    try {
        configureVapid(config.config)
        const result = await webpush.sendNotification(
            {
                endpoint: subscription.endpoint,
                keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            JSON.stringify(parsed.data),
            { TTL: options?.ttlSeconds ?? 3600 },
        )
        return { ok: true, statusCode: result.statusCode }
    } catch (error) {
        const statusCode = readStatusCode(error)
        // subscription منقضی/نامعتبر → gone تا caller بعداً آن را پاک کند (فاز بعد)
        if (statusCode === 404 || statusCode === 410) return { ok: false, reason: "gone", statusCode }
        return { ok: false, reason: "failed", statusCode }
    }
}
