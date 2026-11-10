"use client"

/*
 * یادآора — لایه‌ی کلاینت ثبت اشتراک Web Push
 * ---------------------------------------------------------------
 * مسئولیت: تبدیل کلید pública VAPID، گرفتن مجوز اعلان، ثبت در
 * `registration.pushManager.subscribe` و هم‌گام‌سازی اشتراک با سرور.
 *
 * همه‌ی توابع این ماژول «شکست‌ناپذیر» هستند: خروجی ساختاریافته با دلیل
 * (`reason`) برمی‌گردانند و هرگز throw نمی‌کند — چون یادآور داخلی (تایمر
 * صفحه) باید در هر شرایطی کار کند، حتی اگر Push در دسترس نباشد.
 *
 * نکته‌ی امنیتی: کلید خصوصی VAPID هرگز سمت کلاینت نمی‌آید؛ فقط
 * NEXT_PUBLIC_VAPID_PUBLIC_KEY خوانده می‌شود.
 *-------------------------------------------------------------------
 * distinct permission-flow for two platforms:
 *   • Capacitor (APK):  programmatic permission via LocalNotifications
 *     — no user gesture required; initial mount is fine.
 *   • Web / PWA:       soft‑prompt banner; request only on explicit click.
 */

import { ApiClientError, api } from "@/app/lib/api/client"
import { isNativeLocalNotificationPlatform } from "@/app/lib/native/local-notifications"
import {
    requestLocalNotificationPermission,
    LocalNotificationPermissionOutcome,
} from "@/app/lib/native/local-notifications"

export type PushFailureReason =
    | "UNSUPPORTED" // مرورگر/PWA از Push پشتیبانی نمی‌کند
    | "NOT_CONFIGURED" // NEXT_PUBLIC_VAPID_PUBLIC_KEY روی build تنظیم نشده
    | "PERMISSION_DENIED" // کاربر مجوز اعلان نداده
    | "NO_REGISTRATION" // Service Worker ثبت نشده/آماده نیست
    | "SUBSCRIBE_FAILED" // خودِ مرورگر اشتراک نساخت
    | "SERVER_REJECTED" // سرور اشتراک را نپذیرفت (کلیدها/DB)
    | "RATE_LIMITED" // تعداد تلاش‌ها از سقف سرور بیشتر شد

export type PushSubscribeOutcome =
    | { ok: true; alreadySubscribed: boolean }
    | { ok: false; reason: PushFailureReason }

export type PushSendOutcome =
    | { ok: true; sent: number; failed: number; removed: number }
    | { ok: false; reason: PushFailureReason }

const SW_READY_TIMEOUT_MS = 3_000

type Environment = {
    serviceWorker?: ServiceWorkerContainer
    notification?: { permission: string; requestPermission?: () => Promise<string> }
    pushManager?: unknown
}

function environment(): Environment | null {
    if (typeof window === "undefined" || typeof navigator === "undefined") return null

    return {
        serviceWorker: "serviceWorker" in navigator ? navigator.serviceWorker : undefined,
        notification:
            "Notification" in window
                ? (window as unknown as { Notification: Environment["notification"] }).Notification
                : undefined,
        pushManager: "PushManager" in window ? (window as unknown as { PushManager: unknown }).PushManager : undefined,
    }
}

/** کلید عمومی VAPID از باندل (NEXT_PUBLIC_* در زمان build inline می‌شود). */
export function getVapidPublicKey(): string | null {
    const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
    return typeof key === "string" && key.trim() !== "" ? key.trim() : null
}

export function isPushSupported(): boolean {
    const env = environment()
    if (!env) return false
    return Boolean(env.serviceWorker && env.notification && env.pushManager)
}

/** آیا مجوز اعلان همین حالا داده شده است؟ (بدون درخواست مجوز) */
export function hasNotificationPermission(): boolean {
    return environment()?.notification?.permission === "granted"
}

/**
 * درخواست مجوز اعلان به نکوی پلتفرمی.
 * - پلتفرم نیتیو (Capacitor APK):  `LocalNotifications.checkPermissions()`
 *   و `LocalNotifications.requestPermissions()` صدا زده می‌شود؛ gesture لازم نیست.
 * - مرورگر / PWA:  فقط وضعیت `Notification.permission` را می‌خواند.
 *   درخواست واقعیِ مجوز باید از یک تعامل کاربر بیاید و در
 *   `ensurePushSubscription({ requestPermission: true })` انجام می‌شود.
 */
export async function requestNotificationPermission(): Promise<{
    ok: boolean
    reason?: PushFailureReason
    platform: "native" | "web"
    permission?: "granted" | "denied" | "default"
}> {
    const native = isNativeLocalNotificationPlatform()

    if (native) {
        // ──native──────────────────────────────────────────────────────────
        const outcome = await requestLocalNotificationPermission()
        if (outcome.ok) {
            return { ok: true, platform: "native", permission: "granted" }
        }
        const reason =
            outcome.reason === "PERMISSION_DENIED"
                ? "PERMISSION_DENIED"
                : outcome.reason === "PERMISSION_PROMPT"
                ? "PERMISSION_DENIED"
                : "UNSUPPORTED"
        return { ok: false, reason, platform: "native", permission: "denied" }
    }

    // ──web────────────────────────────────────────────────────────────────
    const notification = environment()?.notification
    if (!notification) {
        return { ok: false, reason: "UNSUPPORTED", platform: "web" }
    }

    const perm = notification.permission
    if (perm === "granted") {
        return { ok: true, platform: "web", permission: "granted" }
    }
    if (perm === "denied") {
        return { ok: false, reason: "PERMISSION_DENIED", platform: "web", permission: "denied" }
    }
    // default (not yet requested)
    return { ok: false, reason: undefined, platform: "web", permission: "default" }
}

/**
 * encompass وجود اشتراک Push برای این دستگاه (idempotent).
 * - `requestPermission: true` فقط در پاسخ به یک تعامل کاربر (کلیک) استفاده شود；
 *   در آن حالت اگر مجوز وب هنوز `default` باشد، همان‌جا
 *   `Notification.requestPermission()` صدا زده می‌شود (پیش از subscribe).
 * - روی پی‌اچ‌وی/android (Capacitor) مجوز از طریق `requestNotificationPermission()`
 *   programmatic درخواست می‌شود؛ روی وب بدون کلیک فقط بازبینی می‌شود.
 * - اگر Already granted ، Subscription کاملاً بدون prompt recreated می‌شود .
 */
export async function ensurePushSubscription(
    options: { requestPermission?: boolean } = {},
): Promise<PushSubscribeOutcome> {
    if (!isPushSupported()) return { ok: false, reason: "UNSUPPORTED" }

    const publicKey = getVapidPublicKey()
    if (!publicKey) return { ok: false, reason: "NOT_CONFIGURED" }

    // ── platform‑aware permission check ──
    const permStatus = await requestNotificationPermission()

    if (!permStatus.ok) {
        // Explicit denial (or native denial) — a prompt cannot help.
        if (permStatus.reason === "PERMISSION_DENIED" || permStatus.permission === "denied") {
            return { ok: false, reason: "PERMISSION_DENIED" }
        }

        // Web, permission still "default": prompt only from an explicit user
        // gesture. Without it, report the current state and let the UI decide.
        if (permStatus.platform === "web" && permStatus.permission === "default") {
            if (!options.requestPermission) {
                return { ok: false, reason: "PERMISSION_DENIED" }
            }
            const granted = await promptPermission()
            if (!granted) return { ok: false, reason: "PERMISSION_DENIED" }
        } else {
            return { ok: false, reason: permStatus.reason ?? "PERMISSION_DENIED" }
        }
    }

    // permission granted — now proceed with registration
    if (!isPushSupported()) return { ok: false, reason: "UNSUPPORTED" }

    const registration = await getReadyRegistration()
    if (!registration) return { ok: false, reason: "NO_REGISTRATION" }

    const existing = await registration.pushManager.getSubscription().catch(() => null)

    return registerWithServer(registration, publicKey, existing)
}

/** فقط وقتی صدا زده می‌شود که کاربر با کلیک/تعامل، اجازه‌ی درخواست داده باشد. */
async function promptPermission(): Promise<boolean> {
    const notification = environment()?.notification
    if (!notification || typeof notification.requestPermission !== "function") return false

    try {
        return (await notification.requestPermission()) === "granted"
    } catch {
        return false
    }
}

function subscriptionPayload(subscription: PushSubscription): {
    endpoint: string
    keys: { p256dh: string; auth: string }
} | null {
    const json = subscription.toJSON()
    const endpoint = typeof json.endpoint === "string" ? json.endpoint : null
    const p256dh = typeof json.keys?.p256dh === "string" ? json.keys.p256dh : null
    const auth = typeof json.keys?.auth === "string" ? json.keys.auth : null

    if (!endpoint || !p256dh || !auth) return null

    return { endpoint, keys: { p256dh, auth } }
}

/** ثبت اشتراک در مرورگر + اطلاع به سرور. خطاها به `reason` نگاشت می‌شوند. */
async function registerWithServer(
    registration: ServiceWorkerRegistration,
    publicKey: string,
    existing: PushSubscription | null,
): Promise<PushSubscribeOutcome> {
    let subscription = existing

    // rotation کلید VAPID → اشتراک قدیمی بی‌استفاده است (لغو و ثبت دوباره)
    if (subscription && !subscriptionMatchesKey(subscription, publicKey)) {
        await subscription.unsubscribe().catch(() => false)
        subscription = null
    }

    if (!subscription) {
        try {
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: toApplicationServerKey(publicKey),
            })
        } catch {
            return { ok: false, reason: "SUBSCRIBE_FAILED" }
        }
    }

    const payload = subscriptionPayload(subscription)
    if (!payload) return { ok: false, reason: "SUBSCRIBE_FAILED" }

    try {
        await api("/api/notifications/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        })
    } catch (error) {
        if (error instanceof ApiClientError) {
            if (error.code === "PUSH_NOT_CONFIGURED") return { ok: false, reason: "NOT_CONFIGURED" }
            if (error.code === "RATE_LIMITED") return { ok: false, reason: "RATE_LIMITED" }
        }
        return { ok: false, reason: "SERVER_REJECTED" }
    }

    return { ok: true, alreadySubscribed: existing != null }
}

export function urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4)
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/")
    const raw = atob(base64)
    const output = new Uint8Array(raw.length)

    for (let i = 0; i < raw.length; i += 1) {
        output[i] = raw.charCodeAt(i)
    }

    return output
}

/** `applicationServerKey` در lib.dom از نوع BufferSource است، ولی Uint8Array ساخته‌شده
 *  از atob با ArrayBufferLike تعریف می‌شود (TS ≥5.7) — این cast فقط همان مرز نوع است.
 */
function toApplicationServerKey(base64: string): BufferSource {
    return urlBase64ToUint8Array(base64) as unknown as BufferSource
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), ms)
        promise.then(
            (value) => {
                clearTimeout(timer)
                resolve(value)
            },
            () => {
                clearTimeout(timer)
                resolve(null)
            },
        )
    })
}

async function getReadyRegistration(): Promise<ServiceWorkerRegistration | null> {
    const serviceWorker = environment()?.serviceWorker
    if (!serviceWorker) return null

    try {
        const existing = await serviceWorker.getRegistration()
        if (existing) return existing
        return await withTimeout(serviceWorker.ready, SW_READY_TIMEOUT_MS)
    } catch {
        return null
    }
}

/** encompass اشتراک — کاربر جاری. */
export function subscriptionMatchesKey(
    subscription: { options?: { applicationServerKey?: BufferSource | null } },
    publicKey: string,
): boolean {
    const current = subscription.options?.applicationServerKey
    if (!current) return true

    const expected = urlBase64ToUint8Array(publicKey)
    const actual = current instanceof Uint8Array ? current : new Uint8Array(current as ArrayBuffer)

    if (actual.length !== expected.length) return false

    for (let i = 0; i < expected.length; i += 1) {
        if (actual[i] !== expected[i]) return false
    }

    return true
}

/** لغو مشترک این دستگاه: اول سمت مرورگر، بعد اطلاع به سرور (best-effort). */
export async function removePushSubscription(): Promise<{ ok: boolean; reason?: PushFailureReason }> {
    if (!isPushSupported()) return { ok: false, reason: "UNSUPPORTED" }

    const registration = await getReadyRegistration()
    if (!registration) return { ok: false, reason: "NO_REGISTRATION" }

    const subscription = await registration.pushManager.getSubscription().catch(() => null)
    if (!subscription) return { ok: true } // همین حالا هم مشترک نیست

    const payload = subscriptionPayload(subscription)
    await subscription.unsubscribe().catch(() => false)

    if (!payload) return { ok: true }

    try {
        await api("/api/notifications/unsubscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: payload.endpoint }),
        })
    } catch {
        // ردیف سرور باقی می‌ماند؛ در اولین ارسال با 404/410 خودش prune می‌شود
        return { ok: false, reason: "SERVER_REJECTED" }
    }

    return { ok: true }
}

/** آینه‌کردم برنامه‌ی یادآور روی سرور (`reminderEnabled` + `reminderTime`). */
export async function syncReminderSchedule(input: {
    enabled: boolean
    time: string
}): Promise<{ ok: boolean; reason?: PushFailureReason }> {
    try {
        await api("/api/notifications/reminder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
        })
        return { ok: true }
    } catch (error) {
        if (error instanceof ApiClientError && error.code === "RATE_LIMITED") {
            return { ok: false, reason: "RATE_LIMITED" }
        }
        return { ok: false, reason: "SERVER_REJECTED" }
    }
}

export type ReminderScheduleSnapshot = { enabled: boolean; time: string }

/**
 * خواندن اسنپ‌شات یادآور از سرور (منبع حقیقت) هنگام mount.
 * `null` یعنی «سرور در دسترس/معتبر نیست» → کلاینت همان localStorage را نگه می‌دارد.
 */
export async function fetchReminderSchedule(): Promise<ReminderScheduleSnapshot | null> {
    try {
        const data = await api<ReminderScheduleSnapshot>("/api/notifications/reminder")
        if (typeof data?.enabled !== "boolean") return null
        if (typeof data?.time !== "string") return null
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(data.time)) return null
        return { enabled: data.enabled, time: data.time }
    } catch {
        return null
    }
}

/** ارسال اعلان آزمایشی به دستگاه‌های همین کاربر (دکمه‌ی «تست اعلان»). */
export async function sendTestNotification(): Promise<PushSendOutcome> {
    try {
        const data = await api<{ sent: number; failed: number; removed: number }>(
            "/api/notifications/test",
            { method: "POST" },
        )
        return { ok: true, sent: data.sent, failed: data.failed, removed: data.removed }
    } catch (error) {
        if (error instanceof ApiClientError) {
            if (error.code === "PUSH_NOT_CONFIGURED") return { ok: false, reason: "NOT_CONFIGURED" }
            if (error.code === "RATE_LIMITED") return { ok: false, reason: "RATE_LIMITED" }
        }
        return { ok: false, reason: "SERVER_REJECTED" }
    }
}