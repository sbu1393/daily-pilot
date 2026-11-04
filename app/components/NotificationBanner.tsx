"use client"

import { useEffect, useState } from "react"
import {
    requestNotificationPermission,
    ensurePushSubscription,
} from "@/app/lib/pushSubscription"

type NotificationBannerProps = {
    /** Optional override for the dismiss-storage key */
    dismissedKey?: string
}

/**
 * Soft-prompt notification banner for Web Push.
 * - Capacitor (native): never shows this banner (permission handled programmatically).
 * - Web / PWA: shows once on mount if permission is "default" (not yet requested).
 * - User can dismiss; dismissed state persists in localStorage.
 */
export function NotificationBanner({ dismissedKey = "dismissed_notification_banner" }: NotificationBannerProps) {
    const [isVisible, setIsVisible] = useState(false)
    const [permission, setPermission] = useState<"granted" | "denied" | "default">()

    useEffect(() => {
        // If user previously dismissed, never show again
        const previouslyDismissed = localStorage.getItem(dismissedKey) === "true"
        if (previouslyDismissed) {
            setIsVisible(false)
            return
        }

        // Request permission check
        void requestNotificationPermission().then(
            ({ platform, permission: perm }) => {
                // Only show on Web when permission is still "default" (not yet requested)
                if (platform === "web" && perm === "default") {
                    setIsVisible(true)
                    setPermission("default")
                } else {
                    // On native or already-granted/denied, hide banner
                    setIsVisible(false)
                    // Set permission based on platform
                    if (platform === "native") {
                        setPermission("granted")
                    } else if (perm !== undefined) {
                        setPermission(perm)
                    } else {
                        setPermission("denied")
                    }
                }
            },
        )
    }, [dismissedKey])

    // If user explicitly dismissed, mark in localStorage
    useEffect(() => {
        if (!isVisible) {
            localStorage.setItem(dismissedKey, "true")
        }
    }, [isVisible])

    if (!isVisible) return null

    return (
        <div
            className="dp-notification-banner fixed top-0 left-0 right-0 z-50 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 shadow-sm"
            style={{ transform: "translateY(0)" }}
        >
            <div className="max-w-7xl mx-auto px-4 py-2 flex items-center justify-between">
                <span className="text-gray-700 dark:text-gray-200 font-medium">
                    🔔 برای دریافت به موقع یادآور تسک‌ها، الاعانات را فعال کنید
                </span>
                <div className="flex items-center gap-2">
                    <button
                        className="dp-btn dp-btn-sm dp-btn-ghost text-sm"
                        onClick={async () => {
                            setIsVisible(false)
                            localStorage.setItem(dismissedKey, "true")
                            const result = await ensurePushSubscription({ requestPermission: true })
                            if (!result.ok) {
                                // If subscription failed, re-show banner
                                setIsVisible(true)
                            }
                        }}>
                        فعال‌سازی
                    </button>
                    <button
                        className="dp-btn dp-btn-sm dp-btn-ghost text-sm"
                        onClick={() => {
                            setIsVisible(false)
                            localStorage.setItem(dismissedKey, "true")
                        }}>
                        ✕
                    </button>
                </div>
            </div>
        </div>
    )
}