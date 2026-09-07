"use client"

import { useCallback, useEffect, useState } from "react"

export type DayMarker = {
    dayKey: string
    doneCount: number
    savedMinutes: number
    overspentMinutes: number
}

export function useHistoryMarkers(from: string, to: string) {
    const [markers, setMarkers] = useState<Record<string, DayMarker>>({})
    const [loading, setLoading] = useState(false)

    const refresh = useCallback(async (silent = false) => {
        if (!silent) setLoading(true)
        try {
            const res = await fetch(`/api/planner/history?from=${from}&to=${to}`)
            const json = await res.json()
            if (!res.ok) throw new Error(json.message || "خطا در دریافت تاریخچه")
            const map: Record<string, DayMarker> = {}
            for (const m of json.data as DayMarker[]) map[m.dayKey] = m
            setMarkers(map)
        } catch (e) {
            console.error(e)
        } finally {
            if (!silent) setLoading(false)
        }
    }, [from, to])

    useEffect(() => { refresh() }, [refresh])

    // بعد از هر mutation (اتمام/حذف/rollover) نقطهها بیصدا آپدیت میشن
    useEffect(() => {
        const onMutated = () => refresh(true)
        window.addEventListener("planner:mutated", onMutated)
        return () => window.removeEventListener("planner:mutated", onMutated)
    }, [refresh])

    return { markers, loading, refresh }
}
