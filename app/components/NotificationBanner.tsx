"use client"

import { useEffect, useState } from "react"
import {
    ensurePushSubscription,
    requestNotificationPermission,
    type PushFailureReason,
} from "@/app/lib/pushSubscription"

type NotificationBannerProps = {
    /** Optional override for the dismiss-storage key */
    dismissedKey?: string
}

const REASON_MESSAGE: Record<PushFailureReason, string> = {
    UNSUPPORTED: "مرورگر شما از اعلان‌های Push پشتیبانی نمی‌کند.",
    NOT_CONFIGURED: "ارسال اعلان روی سرور هنوز تنظیم نشده است؛ لطفاً بعداً دوباره تلاش کنید.",
    PERMISSION_DENIED:
        "مرورگر اجازهٔ اعلان را نداده است. از آیکن قفل کنار نوار آدرس، اعلان‌ها را برای این سایت «اجازه» کنید و دوباره تلاش کنید.",
    NO_REGISTRATION: "سرویس‌ورکر برنامه آماده نیست. صفحه را یک‌بار دوباره بارگذاری کنید.",
    SUBSCRIBE_FAILED: "ثبت اشتراک اعلان ناموفق بود؛ دوباره تلاش کنید.",
    SERVER_REJECTED: "سرور اشتراک اعلان را نپذیرفت؛ چند دقیقه بعد دوباره تلاش کنید.",
    RATE_LIMITED: "تعداد تلاش‌ها زیاد بود؛ کمی صبر کنید و دوباره امتحان کنید.",
}

/**
 * Soft-prompt notification banner for Web Push.
 * - Capacitor (native): never shows this banner (permission handled programmatically).
 * - Web / PWA: shows on mount if permission is "default" (not yet requested).
 * - Dismissal is persisted only after the user explicitly closes the banner or a
 *   subscription is confirmed — never automatically on mount.
 */
export function NotificationBanner({
    // v2: کاربرانی که نسخهٔ قبلی پرچم را به‌اشتباه روی mount ذخیره کرده‌اند، دوباره ببینند.
    dismissedKey = "dismissed_notification_banner_v2",
}: NotificationBannerProps) {
    const [isVisible, setIsVisible] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        let cancelled = false

        // Only skip when the user explicitly dismissed (or already enabled) before.
        if (localStorage.getItem(dismissedKey) === "true") return

        void requestNotificationPermission().then(({ platform, permission }) => {
            if (cancelled) return
            setIsVisible(platform === "web" && permission === "default")
        })

        return () => {
            cancelled = true
        }
    }, [dismissedKey])

    if (!isVisible) return null

    const dismiss = () => {
        localStorage.setItem(dismissedKey, "true")
        setIsVisible(false)
    }

    const enable = async () => {
        setBusy(true)
        setError(null)
        try {
            // Called from a real click, so this may show the browser permission prompt.
            const result = await ensurePushSubscription({ requestPermission: true })
            if (!result.ok) {
                // Keep the banner visible and explain what the user can do.
                setError(REASON_MESSAGE[result.reason] ?? "فعال‌سازی اعلان‌ها ناموفق بود؛ دوباره تلاش کنید.")
                return
            }
            // Success: hide for this session. Do not persist dismissal — only an
            // explicit user dismiss should do that. The next mount will hide it
            // anyway because the permission is now "granted".
            setIsVisible(false)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div
            role="region"
            aria-label="فعال‌سازی اعلان‌ها"
            style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "12px",
                flexWrap: "wrap",
                marginBottom: "16px",
                padding: "12px 18px",
                background: "var(--surface-solid)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-md)",
                boxShadow: "var(--shadow-sm)",
            }}
        >
            <div style={{ display: "grid", gap: "4px", minWidth: 0 }}>
                <span style={{ color: "var(--ink)", fontWeight: 700, lineHeight: 1.8 }}>
                    🔔 برای دریافت به‌موقع یادآور تسک‌ها، اعلان‌ها را فعال کنید
                </span>
                {error && (
                    <span role="alert" style={{ color: "var(--danger)", fontSize: ".85rem", lineHeight: 1.8 }}>
                        {error}
                    </span>
                )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <button
                    type="button"
                    className="dp-btn dp-btn-primary"
                    style={{ padding: "8px 18px", fontSize: ".85rem" }}
                    disabled={busy}
                    onClick={() => void enable()}
                >
                    {busy ? "در حال فعال‌سازی..." : "فعال‌سازی"}
                </button>
                <button
                    type="button"
                    className="dp-btn dp-btn-ghost"
                    style={{ padding: "8px 12px" }}
                    aria-label="بستن اعلان"
                    disabled={busy}
                    onClick={dismiss}
                >
                    ✕
                </button>
            </div>
        </div>
    )
}
