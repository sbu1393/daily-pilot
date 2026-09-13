"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "@/app/lib/api/client"

// Phase 1 — هوک دادهٔ «پیشنهاد روز» (فقط خواندنی).
// ------------------------------------------------------------------
// - منبع: GET /api/planner/suggestion?date=YYYY-MM-DD (ADR-006 / Phase S2).
// - کاملاً read-only: هیچ mutation، هیچ persist، هیچ AI — فقط fetch.
// - محافظت از race: AbortController (لغو واقعیِ درخواستِ قبلی) + گارد ترتیب
//   (requestSeq) — تعویض سریع روز فقط نتیجهٔ آخرین درخواست را اعمال می‌کند.
// - همگام‌سازی: با رویداد سراسری «planner:mutated» خودکار refetch می‌شود
//   (همان قراردادی که useDaySummary استفاده می‌کند).
//
// نمای سمت کلاینت باید با منبع حقیقت سمت سرور یکی بماند:
// app/lib/planner/suggestion.ts (DaySuggestion) + DaySuggestionResponse در
// app/lib/services/planner.service.ts.

export type SuggestionPlannedItem = {
    taskId: number
    estimatedMinutes: number
    suggestedMinutes: number
    partial: boolean
    weight: number
}

export type SuggestionUnfittedItem = {
    taskId: number
    estimatedMinutes: number
    weight: number
}

export type SuggestionBasis = {
    planVersion: number
    rebalancedVersion: number | null
    availableMinutes: number
    taskCount: number
}

/** §6.3.2: fresh ⇔ پلن هست و rebalancedVersion == planVersion؛ در غیر این صورت stale */
export type SuggestionState = "fresh" | "stale"

export type SuggestionData = {
    dayKey: string
    protectedTaskIds: number[]
    capacityMinutes: number
    planned: SuggestionPlannedItem[]
    unfitted: SuggestionUnfittedItem[]
    plannedMinutes: number
    remainingMinutes: number
    usedDefaultEstimate: number[]
    basis: SuggestionBasis
    state: SuggestionState
}

export type UseDaySuggestionResult = {
    suggestion: SuggestionData | null
    loading: boolean
    error: string | null
    refetch: () => void
}

const isAbort = (e: unknown): boolean =>
    typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError"

/**
 * پیشنهاد برنامهٔ روز را از سرور می‌گیرد.
 *
 * @param dayKey روزِ کانونیکال (YYYY-MM-DD)
 * @param enabled اگر false باشد هیچ درخواستی زده نمی‌شود (و داده پاک می‌شود)
 * @returns `{ suggestion, loading, error, refetch }` — پیشنهاد فعلی/نال، وضعیت بارگذاری،
 *          پیام خطا، و تابع refetch دستی. پاسخ‌های کهنه هرگز روی state نوشته نمی‌شوند
 *          (لغو AbortController + گارد ترتیب requestSeq).
 */
export function useDaySuggestion(dayKey: string, enabled: boolean = true): UseDaySuggestionResult {
    const [suggestion, setSuggestion] = useState<SuggestionData | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    // فقط آخرین درخواست اجازهٔ نوشتن روی state را دارد.
    const requestSeq = useRef(0)
    // درخواست در پرواز — با هر refresh جدید یا unmount لغو می‌شود.
    const inflight = useRef<AbortController | null>(null)

    const refresh = useCallback(async () => {
        if (!enabled || dayKey.trim() === "") return

        // لغو درخواست قبلی: تعویض سریع روز یا refetch پشت‌سرهم → فقط آخرین می‌ماند
        inflight.current?.abort()
        const controller = new AbortController()
        inflight.current = controller

        const seq = ++requestSeq.current
        setLoading(true)
        try {
            // ADR-04: { ok, data: suggestion } → خود data پیشنهاد است
            const data = await api<SuggestionData>(`/api/planner/suggestion?date=${dayKey}`, {
                signal: controller.signal,
            })
            if (seq !== requestSeq.current || controller.signal.aborted) return
            setSuggestion(data)
            setError(null)
        } catch (e) {
            // لغو عمدی (تعویض روز/unmount/refetch جدید) خطای کاربر نیست
            if (seq !== requestSeq.current || controller.signal.aborted || isAbort(e)) return
            setError(e instanceof Error ? e.message : "خطای ناشناخته")
        } finally {
            // فقط درخواست جاری loading را می‌بندد؛ پاسخ کهنه وسط درخواست تازه قطعش نمی‌کند
            if (seq === requestSeq.current && !controller.signal.aborted) setLoading(false)
        }
    }, [dayKey, enabled])

    // لود اولیه + لغو در پرواز هنگام تعویض روز/unmount
    useEffect(() => {
        if (!enabled || dayKey.trim() === "") {
            inflight.current?.abort()
            requestSeq.current += 1
            setSuggestion(null)
            setError(null)
            setLoading(false)
            return
        }

        void refresh()

        return () => {
            inflight.current?.abort()
            requestSeq.current += 1
        }
    }, [dayKey, enabled, refresh])

    // تغییر کارها در برنامه → پیشنهاد تازه
    useEffect(() => {
        if (!enabled) return

        const handleMutated = () => {
            void refresh()
        }

        window.addEventListener("planner:mutated", handleMutated)
        return () => {
            window.removeEventListener("planner:mutated", handleMutated)
        }
    }, [enabled, refresh])

    const refetch = useCallback(() => {
        void refresh()
    }, [refresh])

    return { suggestion, loading, error, refetch }
}
