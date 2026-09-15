"use client"

import { useCalendar } from "@/app/contexts/CalenderContext"
import { getCanonicalToday } from "@/app/lib/canonicalDay"
import { formatCanonicalToJalali } from "@/app/lib/time"
import styles from "./dashboard.module.css"

export default function DayHeader({ onEdit }: { onEdit: () => void }) {
    const { selectedDate, timezone } = useCalendar()
    const today = getCanonicalToday(timezone)
    const targetDate = selectedDate || today
    const isToday = targetDate === today
    const isPast = targetDate < today

    return (
        <header className={styles.dayHeader}>
            <h2 className={styles.dayTitle}>
                {isToday ? "برنامه امروز" : `برنامهٔ روز ${formatCanonicalToJalali(targetDate)}`}
            </h2>
            {!isPast && (
                <button type="button" className={styles.editBtn} onClick={onEdit}>
                    تنظیم وقت روز
                </button>
            )}
        </header>
    )
}
