"use client"

import { useEffect, useState } from "react"
import { isOffline, onOnline, syncQueue } from "@/app/lib/offline"

/**
 * نشانگر وضعیت آنلاین/آفلاین + تلاش خودکار برای سینک صف هنگام اتصال مجدد.
 * فقط یک نمونه در ریشه‌ی اپ (layout) نصب می‌شود.
 */
export default function OfflineIndicator() {
    const [offline, setOffline] = useState(false)
    const [justSynced, setJustSynced] = useState(false)

    useEffect(() => {
        setOffline(isOffline())

        const goOnline = async () => {
            setOffline(false)
            const synced = await syncQueue()
            if (synced > 0) {
                setJustSynced(true)
                setTimeout(() => setJustSynced(false), 4000)
            }
        }

        const goOffline = () => setOffline(true)

        const off = onOnline(goOnline)
        window.addEventListener("offline", goOffline)

        // هنگام لود صفحه اگر آنلاین هستیم، صف معوق را سینک کن
        if (!isOffline()) void syncQueue()

        return () => {
            off()
            window.removeEventListener("offline", goOffline)
        }
    }, [])

    if (!offline && !justSynced) return null

    return (
        <div className="dp-offline-chip" role="status">
            {offline
                ? "🔌 حالت آفلاین — تسک‌ها محلی ذخیره می‌شوند و بعد از اتصال سینک می‌شوند"
                : "✅ اتصال برقرار شد؛ تسک‌های آفلاین سینک شدند"}
        </div>
    )
}
