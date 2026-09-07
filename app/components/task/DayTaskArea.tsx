"use client"

import { useCalendar } from "@/app/contexts/CalenderContext"
import { todayKey } from "../../lib/jalili"
import DayHistoryPanel from "./DayHistoryPanel"
import DailyTaskList from "./DailyTaskList"

// روزهای گذشته → تاریخچه | امروز و آینده → لیست عادی (ساخت/انجام کار)
export default function DayTaskArea() {
    const { selectedDate } = useCalendar()
    return selectedDate < todayKey() ? <DayHistoryPanel /> : <DailyTaskList />
}
