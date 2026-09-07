"use client"

import { useMemo } from "react"
import moment from "moment-jalaali"
import { useCalendar } from "@/app/contexts/CalenderContext"
import { todayKey, shiftDayKey, fromDayKey } from "../../lib/jalili"
import { faDigits } from "@/app/lib/time"
import { useHistoryMarkers } from "@/app/hooks/useHistoryMarkers"
import styles from "./jalaliCalendar.module.css"

const WEEKDAYS = ["یکشنبه", "دوشنبه", "سهشنبه", "چهارشنبه", "پنجشنبه", "جمعه", "شنبه"]
const MONTHS = ["فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور", "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند"]

type Day = { key: string; weekday: string; number: number; month: string }

const PAST_DAYS = 7   // روزهای قبل از امروز که نمایش داده میشن
const TOTAL_DAYS = 21 // ۷ قبل + امروز + ۱۳ بعد

export default function JalaliCalendar() {
    const { selectedDate, setSelectedDate } = useCalendar()
    const today = todayKey()

    // بازهی نمایش = همان محدودهی ۲۱ روز → هم برای ساخت روزها، هم برای کوئری مارکرها
    const rangeStart = useMemo(() => shiftDayKey(today, -PAST_DAYS), [today])
    const rangeEnd = useMemo(() => shiftDayKey(today, TOTAL_DAYS - PAST_DAYS - 1), [today])
    const { markers } = useHistoryMarkers(rangeStart, rangeEnd)

    const days: Day[] = useMemo(() => {
        return Array.from({ length: TOTAL_DAYS }, (_, i) => {
            const key = shiftDayKey(rangeStart, i)
            const [y, m, d] = key.split("-").map(Number)
            const weekday = WEEKDAYS[moment(fromDayKey(key)).day()]
            return { key, weekday, number: d, month: MONTHS[m - 1] }
        })
    }, [rangeStart])

    return (
        <div className={styles.scroll} role="tablist" aria-label="انتخاب روز">
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
                        className={`${styles.dayBtn} ${isActive ? styles.active : ""} ${isToday ? styles.today : ""}`}
                        onClick={() => setSelectedDate(day.key)}
                    >
                        {/* نقطه/شمارندهی تاریخچه: فقط روزهایی که تسک انجامشده دارن */}
                        {marker && marker.doneCount > 0 && (
                            <span className={styles.dayMarker} title={`${faDigits(marker.doneCount)} کار انجام شده`}>
                                {marker.doneCount > 9 ? "۹+" : faDigits(marker.doneCount)}
                            </span>
                        )}
                        <span className={styles.dayName}>{day.weekday}</span>
                        <span className={styles.dayNumber}>{faDigits(day.number)}</span>
                        <span className={styles.dayMonth}>{day.month}</span>
                    </button>
                )
            })}
        </div>
    )
}
