"use client"

import { useCallback, useEffect, useState } from "react"
import { useCalendar } from "@/app/contexts/CalenderContext"
import { readCachedDay } from "@/app/lib/offline"

export type DaySummary = {
    dayKey: string
    hasPlan: boolean
    availableMinutes: number
    spentMinutes: number
    savedMinutes: number
    committedMinutes: number
    openBudgetMinutes: number
    poolMinutes: number
    overCommittedMinutes: number
    totalTasks: number
    doneTasks: number
    openTasks: number
}

export function useDaySummary() {
    const { selectedDate } = useCalendar()
    const [summary, setSummary] = useState<DaySummary | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    const refresh = useCallback(
        async (silent = false) => {
            if (!silent) setLoading(true)
            try {
                const res = await fetch(`/api/planner/day?dayKey=${selectedDate}`)
                const json = await res.json()
                if (!res.ok) throw new Error(json.message || "خطا در دریافت خلاصه روز")
                setSummary(json.summary)
                setError(null)
            } catch (e) {
                /* آفلاین: نمایش خلاصه‌ی کش‌شده تا نوار آمار از بین نرود */
                const cached = readCachedDay(selectedDate)
                if (cached?.summary) {
                    setSummary(cached.summary)
                    setError(null)
                } else {
                    setError(e instanceof Error ? e.message : "خطای ناشناخته")
                }
            } finally {
                if (!silent) setLoading(false)
            }
        },
        [selectedDate],
    )

    // لود اولیه و تایمر دوره‌ای
    useEffect(() => {
        refresh(true)
        const timer = setInterval(() => refresh(true), 30_000)
        return () => clearInterval(timer)
    }, [refresh])

    // 👇 گوش دادن به رویدادی که در DailyTaskList فایر می‌شود
    useEffect(() => {
        const handleMutated = () => {
            refresh(true)
        }

        window.addEventListener("planner:mutated", handleMutated)
        return () => {
            window.removeEventListener("planner:mutated", handleMutated)
        }
    }, [refresh])

    return { summary, loading, error, refresh }
}
