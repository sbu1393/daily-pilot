"use client"

import { useEffect, useState } from "react"
import { faRelativeTime } from "@/app/lib/time"

/**
 * نمایش «چند لحظه/دقیقه/ساعت/روز... پیش» به‌صورت زنده.
 * هر ۳۰ ثانیه خودش را به‌روز می‌کند تا مقادیر جدید همیشه صحیح بمانند.
 */
export default function TimeAgo({ date, className }: { date: string | number | Date; className?: string }) {
    const [label, setLabel] = useState("")

    useEffect(() => {
        const update = () => setLabel(faRelativeTime(date))
        update()
        const timer = setInterval(update, 30_000)
        return () => clearInterval(timer)
    }, [date])

    if (!label) return null // جلوگیری از mismatch بین رندر سرور و کلاینت

    return <span className={className}>{label}</span>
}
