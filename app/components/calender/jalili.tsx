"use client"

import { useEffect, useMemo, useState } from "react"
import moment from "moment-jalaali"
import { useCalendar } from "@/app/contexts/CalenderContext"
import {
    getCanonicalToday,
    shiftCanonicalKey,
} from "@/app/lib/canonicalDay"
import { faDigits } from "@/app/lib/time"
import { useHistoryMarkers } from "@/app/hooks/useHistoryMarkers"
import styles from "./jalaliCalendar.module.css"

const WEEKDAYS = [
    "یکشنبه",
    "دوشنبه",
    "سه‌شنبه",
    "چهارشنبه",
    "پنجشنبه",
    "جمعه",
    "شنبه",
]

const MONTHS = [
    "فروردین",
    "اردیبهشت",
    "خرداد",
    "تیر",
    "مرداد",
    "شهریور",
    "مهر",
    "آبان",
    "آذر",
    "دی",
    "بهمن",
    "اسفند",
]

type Day = {
    key: string
    weekday: string
    number: number
    month: string
}

const PAST_DAYS = 7
const TOTAL_DAYS = 21

export default function JalaliCalendar() {
    const { selectedDate, setSelectedDate, timezone } = useCalendar()
    const [mounted, setMounted] = useState(false)

    useEffect(() => {
        setMounted(true)
    }, [])

    const today = getCanonicalToday(timezone)

    const rangeStart = useMemo(
        () => shiftCanonicalKey(today, -PAST_DAYS),
        [today],
    )

    const rangeEnd = useMemo(
        () =>
            shiftCanonicalKey(
                today,
                TOTAL_DAYS - PAST_DAYS - 1,
            ),
        [today],
    )

    const { markers } = useHistoryMarkers(rangeStart, rangeEnd)

    const days: Day[] = useMemo(() => {
        return Array.from({ length: TOTAL_DAYS }, (_, i) => {
            const key = shiftCanonicalKey(rangeStart, i)
            const date = moment(key, "YYYY-MM-DD")

            return {
                key,
                weekday: WEEKDAYS[date.day()],
                number: date.jDate(),
                month: MONTHS[date.jMonth()],
            }
        })
    }, [rangeStart])

    // سرور و اولین رندر مرورگر هر دو خروجی یکسان دارند.
    if (!mounted) {
        return null
    }

    return (
        <div
            className={styles.scroll}
            role="tablist"
            aria-label="انتخاب روز"
        >
            {days.map((day) => {
                const isActive = day.key === selectedDate
                const isToday = day.key === today
                const marker = markers[day.key]

                return (
                    <button
                        key={day.key}
                        type="button"
                        role="tab"
                        aria-selected={isActive}
                        className={[
                            styles.dayBtn,
                            isActive ? styles.active : "",
                            isToday ? styles.today : "",
                        ]
                            .filter(Boolean)
                            .join(" ")}
                        onClick={() => setSelectedDate(day.key)}
                    >
                        {marker && marker.doneCount > 0 && (
                            <span
                                className={styles.dayMarker}
                                title={`${faDigits(marker.doneCount)} کار انجام شده`}
                            >
                                {marker.doneCount > 9
                                    ? "۹+"
                                    : faDigits(marker.doneCount)}
                            </span>
                        )}

                        <span className={styles.dayName}>
                            {day.weekday}
                        </span>

                        <span className={styles.dayNumber}>
                            {faDigits(day.number)}
                        </span>

                        <span className={styles.dayMonth}>
                            {day.month}
                        </span>
                    </button>
                )
            })}
        </div>
    )
}
