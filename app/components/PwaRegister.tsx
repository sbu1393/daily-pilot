"use client"

import { useEffect } from "react"

/**
 * ثبت Service Worker برای PWA شدن برنامه.
 * در محیط‌های غیر امن (http) یا مرورگرهای قدیمی بی‌صدا رد می‌شود.
 */
export default function PwaRegister() {
    useEffect(() => {
        if (!("serviceWorker" in navigator)) return
        if (window.location.protocol !== "https:" && window.location.hostname !== "localhost") return

        // نسخه‌ی جدید سرویس‌کاربر در همان نصب، skipWaiting می‌شود (فایل sw.js)
        navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
            /* ثبت سرویس‌کاربر ممکن نیست — مشکلی نیست */
        })
    }, [])

    return null
}
