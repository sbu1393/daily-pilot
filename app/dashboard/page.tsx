"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {toast} from "react-toastify" 

import JalaliCalendar from "@/app/components/calender/jalili"
import DayStatsBar from "./DayStarBar"
import DayStartModal from "./DayStarModal"
import { useDaySummary } from "../hooks/UseDaySummary"
import { useCalendar } from "@/app/contexts/CalenderContext"
import DayTaskArea from "../components/task/DayTaskArea"
import { todayKey } from "@/app/lib/jalili"

interface ModalState {
    open: boolean
    isEdit?: boolean
}

export default function Dashboard() {
    const { selectedDate } = useCalendar()
    const { summary, loading, refresh } = useDaySummary()
    const [modal, setModal] = useState<ModalState>({ open: false, isEdit: false })
    const askedFor = useRef<string | null>(null)

    // بررسی اینکه آیا روز انتخاب شده امروز است و هنوز برنامه‌ای ندارد
    const isToday = selectedDate === todayKey()
    const isRequired = isToday && summary !== null && !summary.hasPlan

    // اولین بار که روز جاری بدون بودجه لود می‌شود -> باز شدن خودکار مودال
    useEffect(() => {
        if (!isRequired) return
        if (askedFor.current === selectedDate) return

        askedFor.current = selectedDate
        setModal({ open: true, isEdit: false })
    }, [isRequired, selectedDate])

    const handleSaved = useCallback(async () => {
        setModal({ open: false, isEdit: false })
        await refresh(true)
    }, [refresh])

    return (
        <div className="container">
            <JalaliCalendar />

            {summary && !loading && (
                <DayStatsBar 
                    summary={summary} 
                    onEdit={() => setModal({ open: true, isEdit: true })} 
                />
            )}

            <DayTaskArea />

            <DayStartModal
                open={modal.open}
                isEdit={modal.isEdit ?? summary?.hasPlan ?? false}
                initialMinutes={summary?.availableMinutes ?? 240}
                required={isRequired}
                onClose={() => {
                    if (isRequired) {
                        toast.error("برای ادامه باید زمان آزاد امروز را وارد کنید.")
                        return
                    }
                    setModal({ open: false, isEdit: false })
                }}
                onSaved={handleSaved}
            />
        </div>
    )
}
