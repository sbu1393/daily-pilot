"use client"

// فاز ۴ — Step 7: هوک مشترک GET برای صفحات Admin (الگوی رسمی repo: useDaySuggestion)
//
// - فقط GET (read-only)؛ هیچ mutation.
// - AbortController + requestSeq: پاسخ قدیمی هرگز روی state نوشته نمی‌شود.
// - 401/403 → accessGate (صفحه‌ی پیام؛ بدون داده‌ی admin) — فقط UX؛
//   امنیت همچنان فقط server-side توسط requireAdmin تضمین می‌شود.
// - 404 → NOT_FOUND (صفحه‌ی «یافت نشد»).

import { useCallback, useEffect, useRef, useState } from "react"
import { ApiClientError } from "@/app/lib/api/client"
import { toAdminRequestError, type AdminRequestError } from "./adminClient"

export type UseAdminQueryResult<T> = {
    data: T | null
    loading: boolean
    error: AdminRequestError | null
    /** تابع تازه‌سازی دستی — همان نقش refetch در useDaySuggestion. */
    refetch: () => void
}

export function useAdminQuery<T>(
    /** کلید query — تغییرش refetch می‌کند (URL کامل؛ رشته خالی = غیرفعال). */
    key: string,
    fetcher: (signal: AbortSignal) => Promise<T>,
    options: { enabled?: boolean } = {},
): UseAdminQueryResult<T> {
    const enabled = options.enabled ?? true
    const [data, setData] = useState<T | null>(null)
    const [loading, setLoading] = useState(enabled && key !== "")
    const [error, setError] = useState<AdminRequestError | null>(null)

    const requestSeq = useRef(0)
    const inflight = useRef<AbortController | null>(null)
    // fetcher از renderer صفحات می‌آید؛ برای وابستگی پایدار در useEffect
    // آخرین نسخه در ref نگه داشته می‌شود (بدون اجرای مجدد به‌خاطر identity).
    const fetcherRef = useRef(fetcher)
    fetcherRef.current = fetcher

    const run = useCallback(() => {
        if (!enabled || key === "") {
            inflight.current?.abort()
            requestSeq.current += 1
            setData(null)
            setError(null)
            setLoading(false)
            return
        }

        inflight.current?.abort()
        const controller = new AbortController()
        inflight.current = controller

        const seq = ++requestSeq.current
        setLoading(true)
        fetcherRef
            .current(controller.signal)
            .then((result) => {
                if (seq !== requestSeq.current || controller.signal.aborted) return
                setData(result)
                setError(null)
            })
            .catch((e: unknown) => {
                if (seq !== requestSeq.current || controller.signal.aborted) return
                if (e instanceof ApiClientError || (e instanceof Error && e.name === "AbortError")) {
                    if (e instanceof ApiClientError) {
                        setError(toAdminRequestError(e))
                    }
                    return
                }
                setError(toAdminRequestError(e))
            })
            .finally(() => {
                if (seq === requestSeq.current && !controller.signal.aborted) setLoading(false)
            })
    }, [enabled, key])

    useEffect(() => {
        run()
        return () => {
            inflight.current?.abort()
            requestSeq.current += 1
        }
    }, [run])

    const refetch = useCallback(() => {
        run()
    }, [run])

    return { data, loading, error, refetch }
}
