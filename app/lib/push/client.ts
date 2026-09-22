import { api } from "@/app/lib/api/client"

// ADR-07 — helper سمت client برای اشتراک Web Push.
// این ماژول فقط subscription را می‌سازد/ثبت می‌کند؛ هیچ scheduler یا ارسال نوتیفیکیشنی ندارد.
// فراخوانی آن در نقطه‌ی صریح UX (فعال‌سازی یادآوری) انجام می‌شود، نه در login/page-load.

export type PushSubscribeResult =
    | { ok: true }
    | { ok: false; reason: "unsupported" | "permission_denied" | "no_vapid_key" | "error" }

export type PushSubscribePayload = {
    endpoint: string
    keys: { p256dh: string; auth: string }
}

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

/**
 * تبدیل base64url (فرمت VAPID) به Uint8Array — پیاده‌سازی خالص و مستقل از atob/Buffer
 * تا هم در مرورگر و هم در محیط تست node یکسان کار کند.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
    const normalized = base64String.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "")
    const bytes: number[] = []
    let buffer = 0
    let bits = 0

    for (const ch of normalized) {
        const value = BASE64_CHARS.indexOf(ch)
        if (value < 0) continue // کاراکتر غیرمجاز نادیده گرفته می‌شود (ورودی خراب → کلید کوتاه/خالی)
        buffer = (buffer << 6) | value
        bits += 6
        if (bits >= 8) {
            bits -= 8
            bytes.push((buffer >> bits) & 0xff)
        }
    }

    return new Uint8Array(bytes)
}

/** استخراج payload قابل‌ارسال از یک PushSubscription مرورگر (بدون اعتماد به شکل خام). */
export function subscriptionToPayload(sub: PushSubscription | null | undefined): PushSubscribePayload | null {
    if (!sub) return null

    let json: PushSubscriptionJSON
    try {
        json = typeof sub.toJSON === "function" ? sub.toJSON() : (sub as unknown as PushSubscriptionJSON)
    } catch {
        return null
    }

    const endpoint = json.endpoint
    const p256dh = json.keys?.p256dh
    const auth = json.keys?.auth

    if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string") {
        return null
    }

    return { endpoint, keys: { p256dh, auth } }
}

/** آیا محیط فعلی از Web Push پشتیبانی می‌کند؟ */
export function isPushSupported(): boolean {
    return (
        typeof window !== "undefined" &&
        typeof navigator !== "undefined" &&
        "serviceWorker" in navigator &&
        "PushManager" in window &&
        "Notification" in window
    )
}

/**
 * کلید عمومی VAPID: اول از env قابل‌درج در client، در غیر این صورت از endpoint سرور.
 * کلید خصوصی هرگز در client وجود ندارد.
 */
export async function getVapidPublicKey(): Promise<string | null> {
    const fromEnv = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim()
    if (fromEnv) return fromEnv

    try {
        const data = await api<{ publicKey: string | null }>("/api/push/vapid-public-key")
        return data?.publicKey ?? null
    } catch {
        return null
    }
}

/**
 * ثبت اشتراک Web Push کاربر جاری.
 * - مجوز اعلان فقط در همین لحظه (تعامل صریح) درخواست می‌شود.
 * - Service Worker موجود (`serviceWorker.ready`) استفاده می‌شود؛ SW برای push تغییر نمی‌کند.
 * - subscription به POST /api/push/subscribe ارسال می‌شود (userId سمت سرور تعیین می‌گردد).
 */
export async function subscribeToPush(): Promise<PushSubscribeResult> {
    if (!isPushSupported()) return { ok: false, reason: "unsupported" }

    try {
        if (Notification.permission === "denied") return { ok: false, reason: "permission_denied" }
        if (Notification.permission !== "granted") {
            const permission = await Notification.requestPermission()
            if (permission !== "granted") return { ok: false, reason: "permission_denied" }
        }

        const publicKey = await getVapidPublicKey()
        if (!publicKey) return { ok: false, reason: "no_vapid_key" }

        const registration = await navigator.serviceWorker.ready
        const existing = await registration.pushManager.getSubscription()
        const subscription =
            existing ??
            (await registration.pushManager.subscribe({
                userVisibleOnly: true,
                // TS: buffer نوع BufferSource مورد نیاز PushManager است
                applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
            }))

        const payload = subscriptionToPayload(subscription)
        if (!payload) return { ok: false, reason: "error" }

        await api("/api/push/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        })

        return { ok: true }
    } catch {
        return { ok: false, reason: "error" }
    }
}

/**
 * حذف اشتراک مرورگر و ثبت حذف در سرور.
 * فقط subscription خود کاربر حذف می‌شود (سرور با userId محدود می‌کند).
 */
export async function unsubscribeFromPush(): Promise<boolean> {
    if (!isPushSupported()) return false

    try {
        const registration = await navigator.serviceWorker.ready
        const subscription = await registration.pushManager.getSubscription()
        if (!subscription) return false

        const payload = subscriptionToPayload(subscription)
        await subscription.unsubscribe()

        if (payload) {
            await api(`/api/push/subscribe?endpoint=${encodeURIComponent(payload.endpoint)}`, {
                method: "DELETE",
            })
        }

        return true
    } catch {
        return false
    }
}
