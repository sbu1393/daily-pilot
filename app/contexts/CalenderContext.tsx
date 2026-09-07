"use client"

import { createContext, useContext, useState } from "react"
import { todayKey } from "../lib/jalili"

type CalendarContextType = {
    selectedDate: string // کلید روز جلالی: "1403-05-17"
    setSelectedDate: (date: string) => void
}

const CalendarContext = createContext<CalendarContextType | null>(null)

export function CalendarProvider({ children }: { children: React.ReactNode }) {
    const [selectedDate, setSelectedDate] = useState<string>(todayKey())

    return (
        <CalendarContext.Provider value={{ selectedDate, setSelectedDate }}>
            {children}
        </CalendarContext.Provider>
    )
}

export function useCalendar() {
    const context = useContext(CalendarContext)
    if (!context) throw new Error("useCalendar must be used inside CalendarProvider")
    return context
}
