"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {toast} from "react-toastify" 

import JalaliCalendar from "@/app/components/calender/jalili"
import DayHeader from "./DayHeader"
import DayStatsBar from "./DayStarBar"
import DayStartModal from "./DayStarModal"
import AiQuotaStatusBar from "./AiQuotaStatusBar"
import { useDaySummary } from "../hooks/useDaySummary"
import { useCalendar } from "@/app/contexts/CalenderContext"
import DayTaskArea from "../components/task/DayTaskArea"
import { getCanonicalToday } from "@/app/lib/canonicalDay"

interface ModalState {
    open: boolean
    isEdit?: boolean
}

export default function Dashboard() {
    const { selectedDate, timezone } = useCalendar()
    const { summary, loading, refresh } = useDaySummary()
    const [modal, setModal] = useState<ModalState>({ open: false, isEdit: false })
    const askedFor = useRef<string | null>(null)

    // بررسی اینکه آیا روز انتخاب شده امروز است و هنوز برنامه‌ای ندارد
    const isToday = selectedDate === getCanonicalToday(timezone)
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
        // Phase 4.4 (Step 4/Scenario E) — تغییر ظرفیت یک mutationِ برنامه است: با همان رویداد
        // سراسری موجود، proposal باز discard و پیشنهاد/چیدمان تازه می‌شود (بدون سیستم event دوم).
        window.dispatchEvent(new Event("planner:mutated"))
    }, [refresh])

    return (
        <div className="container">
            <JalaliCalendar />

            <DayHeader onEdit={() => setModal({ open: true, isEdit: true })} />

            {summary && !loading && (
                <DayStatsBar summary={summary} />
            )}

            {/* وضعیت سهمیهٔ AI — فقط خواندنی، کنار آمار روز. خودش از
                /api/ai/quota می‌خواند و بعد از هر عملیات AI تازه می‌شود. */}
            <AiQuotaStatusBar />

            {/* ورود کد هدیه عمداً این‌جا نیست؛ به /subscription منتقل شده تا داشبورد
                فقط روی کارهای روزانه متمرکز بماند. نوار سهمیهٔ بالا برای بازخوردِ
                وضعیت کافی است و خودش هنگام اتمام سهمیه لینک می‌دهد. */}
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
