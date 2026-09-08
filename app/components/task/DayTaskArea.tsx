"use client"

import { useCalendar } from "@/app/contexts/CalenderContext"
import { getCanonicalToday } from "../../lib/canonicalDay"
import DayHistoryPanel from "./DayHistoryPanel"
import DailyTaskList from "./DailyTaskList"

// روزهای گذشته → تاریخچه | امروز و آینده → لیست عادی (ساخت/انجام کار)
export default function DayTaskArea() {
    const { selectedDate, timezone } = useCalendar()
    return selectedDate < getCanonicalToday(timezone) ? <DayHistoryPanel /> : <DailyTaskList />
}
