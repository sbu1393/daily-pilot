"use client"

import { useCallback, useEffect, useState } from "react"
import { api } from "@/app/lib/api/client"

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
            // ADR-04: { ok, data: markers } → خود data آرایه‌ی مارکرهاست
            const data = await api<DayMarker[]>(`/api/planner/history?from=${from}&to=${to}`)
            const map: Record<string, DayMarker> = {}
            for (const m of data) map[m.dayKey] = m
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
