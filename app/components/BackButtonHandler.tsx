"use client"

import { useEffect } from "react"
import { usePathname, useRouter } from "next/navigation"
import { App as CapacitorApp, type BackButtonListenerEvent } from "@capacitor/app"
import { Capacitor } from "@capacitor/core"

import { closeTopOverlay } from "@/app/lib/backButton"

/**
 * مدیریت دکمهٔ بازگشت سخت‌افزاری اندروید.
 *
 * ترتیب اولویت:
 *   1) اگر مدال/منو/دراور باز است → همان بسته می‌شود.
 *   2) اگر تاریخچهٔ ناوبری وجود دارد و در ریشه نیستیم → به صفحهٔ قبل برمی‌گردیم.
 *   3) در غیر این صورت (ریشهٔ اپ بدون تاریخچه) → خروج از اپ.
 *
 * فقط در محیط نیتیو (Capacitor) فعال است؛ در مرورگر رفتار عادی مرورگر حفظ
 * می‌شود و هیچ لیسنری ثبت نمی‌شود.
 */

const ROOT_PATHS = new Set(["/", "/dashboard"])

function normalizePath(path: string | null): string {
    if (!path) return "/"
    return path.length > 1 ? path.replace(/\/+$/, "") : path
}

export default function BackButtonHandler() {
    const router = useRouter()
    const pathname = usePathname()

    useEffect(() => {
        if (!Capacitor.isNativePlatform()) return

        let disposed = false
        let handle: { remove: () => Promise<void> } | null = null

        const onBack = (event: BackButtonListenerEvent) => {
            // ۱) هر overlay باز (مدال/منو/دراور) اول بسته می‌شود.
            if (closeTopOverlay()) return

            const atRoot = ROOT_PATHS.has(normalizePath(pathname))
            const canGoBack = event.canGoBack || window.history.length > 1

            // ۲) در صفحات داخلی، به صفحهٔ قبل برگرد.
            if (!atRoot && canGoBack) {
                router.back()
                return
            }

            // ۳) ریشهٔ اپ بدون صفحهٔ قبلی → خروج.
            void CapacitorApp.exitApp()
        }

        void CapacitorApp.addListener("backButton", onBack).then((listener) => {
            if (disposed) {
                void listener.remove()
            } else {
                handle = listener
            }
        })

        return () => {
            disposed = true
            void handle?.remove()
        }
    }, [pathname, router])

    return null
}
