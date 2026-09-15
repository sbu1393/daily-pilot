"use client"

import { useEffect, useMemo, useState } from "react"
import moment from "moment-jalaali"
import { ChevronLeft, ChevronRight, Grid3X3, List } from "lucide-react"
import { useCalendar } from "@/app/contexts/CalenderContext"
import { getCanonicalToday, shiftCanonicalKey } from "@/app/lib/canonicalDay"
import { faDigits } from "@/app/lib/time"
import { useHistoryMarkers } from "@/app/hooks/useHistoryMarkers"
import JalaliMonthGrid from "./JalaliMonthGrid"
import {
    buildMonthGrid,
    canonicalKeyToJalali,
    jalaliMonthRange,
} from "./jalaliDate"
import styles from "./jalaliCalendar.module.css"

const PAST_DAYS = 7
const TOTAL_DAYS = 21

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

const WEEKDAYS = [
    "یکشنبه",
    "دوشنبه",
    "سه‌شنبه",
    "چهارشنبه",
    "پنجشنبه",
    "جمعه",
    "شنبه",
]

type View = "month" | "nearby"

type Day = {
    key: string
    weekday: string
    number: number
    month: string
}

export default function JalaliCalendar() {
    const { selectedDate, setSelectedDate, timezone } = useCalendar()
    const today = getCanonicalToday(timezone)
    const initialMonth = canonicalKeyToJalali(selectedDate || today)
    const [view, setView] = useState<View>("month")
    const [viewedMonth, setViewedMonth] = useState({
        year: initialMonth.year,
        month: initialMonth.month,
    })
    const [mounted, setMounted] = useState(false)

    useEffect(() => {
        setMounted(true)
    }, [])

    const monthRange = useMemo(
        () => jalaliMonthRange(viewedMonth.year, viewedMonth.month),
        [viewedMonth],
    )
    const rangeStart = useMemo(
        () => shiftCanonicalKey(today, -PAST_DAYS),
        [today],
    )
    const rangeEnd = useMemo(
        () => shiftCanonicalKey(today, TOTAL_DAYS - PAST_DAYS - 1),
        [today],
    )
    const history = useHistoryMarkers(
        view === "month" ? monthRange.from : rangeStart,
        view === "month" ? monthRange.to : rangeEnd,
    )
    const monthCells = useMemo(
        () => buildMonthGrid(viewedMonth.year, viewedMonth.month, today, selectedDate),
        [viewedMonth, today, selectedDate],
    )

    const days: Day[] = useMemo(() => {
        return Array.from({ length: TOTAL_DAYS }, (_, index) => {
            const key = shiftCanonicalKey(rangeStart, index)
            const date = canonicalKeyToJalali(key)
            const weekday = moment(key, "YYYY-MM-DD", true).day()

            return {
                key,
                weekday: WEEKDAYS[weekday],
                number: date.day,
                month: MONTHS[date.month - 1],
            }
        })
    }, [rangeStart])

    const moveMonth = (amount: number) => {
        const next = moment(
            `${viewedMonth.year}/${String(viewedMonth.month).padStart(2, "0")}/01`,
            "jYYYY/jMM/jDD",
            true,
        ).add(amount, "jMonth")
        setViewedMonth({ year: next.jYear(), month: next.jMonth() + 1 })
    }

    if (!mounted) return null

    return (
        <section className={styles.calendarWidget} aria-label="تقویم روزانه">
            <div className={styles.calendarToolbar}>
                <div className={styles.viewToggle} role="tablist" aria-label="نمای تقویم">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={view === "month"}
                        className={view === "month" ? styles.toggleActive : ""}
                        onClick={() => setView("month")}
                    >
                        <Grid3X3 size={16} /> ماه شمسی
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={view === "nearby"}
                        className={view === "nearby" ? styles.toggleActive : ""}
                        onClick={() => setView("nearby")}
                    >
                        <List size={16} /> روزهای نزدیک
                    </button>
                </div>
            </div>

            {view === "month" ? (
                <>
                    <div className={styles.monthNavigation}>
                        <button type="button" className={styles.monthNavButton} onClick={() => moveMonth(1)} aria-label="ماه بعد">
                            <ChevronLeft size={20} />
                        </button>
                        <div>
                            <strong>{MONTHS[viewedMonth.month - 1]}</strong>
                            <span>{faDigits(viewedMonth.year)}</span>
                        </div>
                        <button type="button" className={styles.monthNavButton} onClick={() => moveMonth(-1)} aria-label="ماه قبل">
                            <ChevronRight size={20} />
                        </button>
                    </div>
                    <JalaliMonthGrid
                        cells={monthCells}
                        markers={history.markers}
                        onSelect={setSelectedDate}
                    />
                </>
            ) : (
                <div className={styles.scroll} role="tablist" aria-label="انتخاب روز">
                    {days.map((day) => {
                        const isActive = day.key === selectedDate
                        const isToday = day.key === today
                        const marker = history.markers[day.key]

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
                                ].filter(Boolean).join(" ")}
                                onClick={() => setSelectedDate(day.key)}
                            >
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
            )}
        </section>
    )
}

export { JalaliCalendar }
