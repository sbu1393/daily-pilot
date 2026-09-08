"use client"

import { createContext, useContext, useEffect, useState } from "react"
import { getCanonicalToday } from "../lib/canonicalDay"

type CalendarContextType = {
    selectedDate: string // کلید روز canonical میلادی: "2026-01-02" (جلالی فقط برای نمایش)
    setSelectedDate: (date: string) => void
    timezone: string // timezone کاربر — مبنای محاسبهی «امروز» در کلاینت
}

// پیشفرض Prisma — تا وقتی پروفایل کاربر نرسیده (همهی کاربران فعلی همین را دارند)
const DEFAULT_TIMEZONE = "Asia/Tehran"

const CalendarContext = createContext<CalendarContextType | null>(null)

export function CalendarProvider({ children }: { children: React.ReactNode }) {
    const [timezone, setTimezone] = useState<string>(DEFAULT_TIMEZONE)
    const [selectedDate, setSelectedDate] = useState<string>(() => getCanonicalToday(DEFAULT_TIMEZONE))

    // timezone کاربر از پروفایل — کلیدهای canonical بر اساس همین tz محاسبه میشوند
    useEffect(() => {
        let cancelled = false
        fetch("/api/auth/profile")
            .then((res) => (res.ok ? res.json() : null))
            .then((json) => {
                const tz = (json as { data?: { timezone?: string } } | null)?.data?.timezone
                if (!cancelled && typeof tz === "string" && tz.length > 0) {
                    setTimezone(tz)
                    setSelectedDate(getCanonicalToday(tz))
                }
            })
            .catch(() => {
                /* مهمان یا خطا → پیشفرض میماند */
            })
        return () => {
            cancelled = true
        }
    }, [])

    return (
        <CalendarContext.Provider value={{ selectedDate, setSelectedDate, timezone }}>
            {children}
        </CalendarContext.Provider>
    )
}

export function useCalendar() {
    const context = useContext(CalendarContext)
    if (!context) throw new Error("useCalendar must be used inside CalendarProvider")
    return context
}
