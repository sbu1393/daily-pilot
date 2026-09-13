"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useCalendar } from "@/app/contexts/CalenderContext"
import { readCachedDay } from "@/app/lib/offline"
import { api } from "@/app/lib/api/client"

// M5/M6 (Phase 2B) — چرخه‌ی کامل درخواست: گارد ترتیب پاسخ (A1 Phase 2) + AbortController.
// اگر `api` سیگنال را بپذیرد، درخواست واقعاً لغو می‌شود؛ در غیر این صورت فقط پاسخ کهنه دور ریخته می‌شود.
// خطای AbortError (لغو عمدی خودمان) هرگز خطای کاربر شمرده نمی‌شود — بی‌صدا تمام می‌شود.
const isAbort = (e: unknown): boolean =>
    e instanceof DOMException
        ? e.name === "AbortError"
        : typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError"

// A1 Phase 2 — نمای سمت کلاینت باید با app/lib/planner/summary.ts (منبع حقیقت سمت سرور)
// یکی باشد: GET /api/planner/day دقیقاً همین ساختار را برمی‌گرداند.
//
// planVersion/rebalancedVersion اختیاری‌اند چون اندپوینت فعلی — بدون هیچ تغییر بک‌اند —
// آن‌ها را برنمی‌گرداند؛ برای گارد تعارض Phase 4 رزرو شده‌اند و در کش آفلاین هم وجود ندارند.
export type DaySummary = {
    dayKey: string
    hasPlan: boolean
    availableMinutes: number
    spentMinutes: number
    savedMinutes: number
    committedMinutes: number
    openBudgetMinutes: number
    overspentMinutes: number
    poolMinutes: number
    overCommittedMinutes: number
    totalTasks: number
    doneTasks: number
    openTasks: number
    planVersion?: number
    rebalancedVersion?: number | null
}

export function useDaySummary() {
    const { selectedDate } = useCalendar()
    const [summary, setSummary] = useState<DaySummary | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    // فقط آخرین درخواست اجازه‌ی نوشتن روی state را دارد.
    // منابع رقیب: تایمر ۳۰ ثانیه‌ای، رویداد planner:mutated و تعویض سریع روز.
    const requestSeq = useRef(0)

    const refresh = useCallback(
        async (silent = false, signal?: AbortSignal) => {
            // rebase: گارد «تاریخ آماده نیست» (نسخه‌ی remote) + گارد ترتیب پاسخ (A1 Phase 2)
            if (!selectedDate || selectedDate.trim() === "") {
                if (!silent) setLoading(false)
                return
            }

            if (signal?.aborted) return // لغو پیش از شروع

            const seq = ++requestSeq.current
            if (!silent) setLoading(true)
            try {
                // ADR-04: { ok, data: summary } → خود data خلاصه است
                // M6: درخواست با AbortController لغو می‌شود (وقتی api آن را می‌پذیرد)
                const data = await api<DaySummary>(`/api/planner/day?dayKey=${selectedDate}`, {
                    signal,
                })
                if (seq !== requestSeq.current || signal?.aborted) return // پاسخ قدیمی/لغوشده → دور ریخته می‌شود
                setSummary(data)
                setError(null)
            } catch (e) {
                // لغو عمدی (تعویض روز/unmount) خطا نیست — همان رفتار «پاسخ قدیمی» را دارد
                if (seq !== requestSeq.current || signal?.aborted || isAbort(e)) return
                /* آفلاین: نمایش خلاصه‌ی کش‌شده تا نوار آمار از بین نرود */
                const cached = readCachedDay(selectedDate)
                if (cached?.summary) {
                    setSummary(cached.summary)
                    setError(null)
                } else {
                    setError(e instanceof Error ? e.message : "خطای ناشناخته")
                }
            } finally {
                // فقط درخواست جاری loading را می‌بندد؛ پاسخ قدیمی نباید اسپینر را
                // وسط یک درخواست تازه قطع کند (منبع flicker).
                if (seq === requestSeq.current && !signal?.aborted) setLoading(false)
            }
        },
        [selectedDate],
    )

    // لود اولیه و تایمر دوره‌ای
    useEffect(() => {
        // rebase: لود اولیه‌ی غیرسایلنت (نسخه‌ی remote) + بی‌اعتبارسازی درخواست‌های
        // در پرواز هنگام unmount/تعویض روز (A1 Phase 2)
        if (!selectedDate) return

        // M5: هر چرخه‌ی روز AbortController خودش را دارد؛ تعویض سریع روز یا unmount
        // درخواستِ در پرواز را واقعاً لغو می‌کند (نه فقط دور ریختن پاسخ).
        const controller = new AbortController()
        void refresh(false, controller.signal)
        const timer = setInterval(() => {
            if (document.visibilityState === "hidden") return // M5: تب مخفی → بدون درخواست
            void refresh(true, controller.signal)
        }, 30_000)

        // M5: توقف/ادامه‌ی polling با visibility — تب مخفی بیکار می‌ماند، برگشت دوباره شروع می‌کند
        const handleVisibility = () => {
            if (document.visibilityState === "visible") {
                void refresh(true, controller.signal)
            }
        }
        document.addEventListener("visibilitychange", handleVisibility)

        return () => {
            clearInterval(timer)
            document.removeEventListener("visibilitychange", handleVisibility)
            controller.abort() // تعویض روز/unmount → درخواست در پرواز لغو می‌شود
            requestSeq.current += 1
        }
    }, [selectedDate, refresh])

    // گوش دادن به رویدادی که در برنامه فایر می‌شود
    useEffect(() => {
        const handleMutated = () => {
            void refresh(true)
        }

        window.addEventListener("planner:mutated", handleMutated)
        return () => {
            window.removeEventListener("planner:mutated", handleMutated)
        }
    }, [refresh])

    return { summary, loading, error, refresh }
}
