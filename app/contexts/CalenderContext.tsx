"use client"

import { createContext, useContext, useEffect, useState } from "react"
import { getCanonicalToday } from "@/app/lib/canonicalDay"

type CalendarContextType = {
    selectedDate: string
    setSelectedDate: (date: string) => void
    timezone: string
}

const DEFAULT_TIMEZONE = "Asia/Tehran"

const CalendarContext = createContext<CalendarContextType | null>(null)

export function CalendarProvider({ children }: { children: React.ReactNode }) {
    const [timezone, setTimezone] = useState<string>(DEFAULT_TIMEZONE)

    // نکته: مقدار اولیه را خالی می‌گذاریم تا SSR/CSR هم‌ارزش باشند
    const [selectedDate, setSelectedDate] = useState<string>("")

    // پس از mount، selectedDate را مقداردهی می‌کنیم
    useEffect(() => {
        // ابتدا با timezone فعلی (پیش‌فرض) مقدار بده
        setSelectedDate(getCanonicalToday(DEFAULT_TIMEZONE))

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
                // مهمان یا خطا → پیشفرض می‌ماند، selectedDate همان مقدار خط بالا می‌ماند
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
