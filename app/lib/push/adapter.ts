/*
 * Web Push — آداپتر ارسال (تنها جایی که پکیج web-push صدا زده می‌شود)
 * ---------------------------------------------------------------
 * چرا آداپتر جدا؟ همان الگوی `app/lib/billing/zarinpal.adapter.ts`: سرویس دامنه
 * به SDK وابسته نیست و تست‌ها می‌توانند این مرز را mock کنند.
 *
 * قواعد امنیتی/عملیاتی:
 * - payload فقط JSON قراردادی می‌رود: { title, body, url, tag, icon } — هیچ
 *   محتوای تسک، ایمیل یا شناسه‌ی کاربر ارسال نمی‌شود.
 * - کلید خصوصی فقط از config سرور می‌آید و هرگز log/برگردانده نمی‌شود.
 * - خطای provider هرگز throw نمی‌شود؛ خروجی ساختاریافته است تا سرویس تصمیم
 *   بگیرد (اشتراک مرده = 404/410 → حذف، بقیه = شکست موقت).
 */

import webpush from "web-push"

import type { PushConfig } from "@/app/lib/push/config"

export type PushTarget = {
    endpoint: string
    p256dh: string
    auth: string
}

/** قرارداد payload بین سرور و handler رویداد `push` در public/sw.js. */
export type PushPayload = {
    title: string
    body: string
    url?: string
    tag?: string
    icon?: string
    /** فقط برای دیباگ/همبستگی — در UI نمایش داده نمی‌شود. */
    requestId?: string
}

export type PushDelivery =
    | { ok: true; statusCode: number }
    | { ok: false; gone: boolean; statusCode: number | null }

/** کدهایی که یعنی «این اشتراک دیگر معتبر نیست» → ردیف باید پاک شود. */
export function isGoneStatusCode(statusCode: number | null | undefined): boolean {
    return statusCode === 404 || statusCode === 410
}

let configuredWith: string | null = null

/**
 * `setVapidDetails` فقط وقتی کلیدها عوض شده باشند صدا زده می‌شود (کش در سطح پروسه).
 * خطای آن throw می‌شود چون یعنی کلیدها نامعتبرند و ادامه دادن بی‌معناست.
 */
export function ensureVapidDetails(config: PushConfig): void {
    const fingerprint = `${config.subject}|${config.publicKey}`
    if (configuredWith === fingerprint) return

    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey)
    configuredWith = fingerprint
}

/** تست‌ها برای ایزوله‌سازی — کش پیکربندی در سطح ماژول را پاک می‌کند. */
export function resetVapidCache(): void {
    configuredWith = null
}

const PUSH_TTL_SECONDS = 60 * 60 // ۱ ساعت: یادآور کهنه معنایی ندارد
const PUSH_TIMEOUT_MS = 10_000

/**
 * ارسال یک اعلان به یک اشتراک. هرگز throw نمی‌کند.
 * متن خطای provider برگردانده نمی‌شود؛ فقط statusCode (برای تصمیم حذف).
 */
export async function deliverPush(
    target: PushTarget,
    payload: PushPayload,
    config: PushConfig,
): Promise<PushDelivery> {
    try {
        ensureVapidDetails(config)
    } catch {
        return { ok: false, gone: false, statusCode: null }
    }

    try {
        const response = await webpush.sendNotification(
            {
                endpoint: target.endpoint,
                keys: { p256dh: target.p256dh, auth: target.auth },
            },
            JSON.stringify(payload),
            { TTL: PUSH_TTL_SECONDS, timeout: PUSH_TIMEOUT_MS },
        )

        return { ok: true, statusCode: response?.statusCode ?? 201 }
    } catch (error) {
        const statusCode =
            typeof (error as { statusCode?: unknown })?.statusCode === "number"
                ? (error as { statusCode: number }).statusCode
                : null

        return { ok: false, gone: isGoneStatusCode(statusCode), statusCode }
    }
}
