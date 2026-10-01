"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toTicketRequestError, type TicketRequestError } from "@/app/lib/tickets/ticketClient"

// T5 — هوک دادهٔ خواندنیِ تیکت (الگوی رسمی مخزن: useAiQuota / useDaySuggestion).
//
// - فقط GET؛ هیچ mutation و هیچ تصمیم authorization اینجا نیست.
// - محافظت از race: AbortController (لغو واقعی درخواست قبلی) + گارد ترتیب
//   (`requestSeq`) تا پاسخِ دیرهنگامِ درخواست قبلی هرگز روی state نوشته نشود.
// - خطا به `{ status, code, message }` تبدیل می‌شود تا UI بتواند 401/403/404 را
//   از هم تفکیک کند (و 403 ادمین را به access-gate بفرستد).

export type UseTicketQueryResult<T> = {
    data: T | null
    loading: boolean
    error: TicketRequestError | null
    /** تازه‌سازی دستی — همان نقش `refetch` در `useAdminQuery`. */
    refetch: () => void
}

export function useTicketQuery<T>(
    /** کلید query؛ تغییرش refetch می‌کند (URL کامل). */
    key: string,
    fetcher: (signal: AbortSignal) => Promise<T>,
): UseTicketQueryResult<T> {
    const [data, setData] = useState<T | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<TicketRequestError | null>(null)

    const requestSeq = useRef(0)
    const inflight = useRef<AbortController | null>(null)
    // هوک‌های فراخوانی هر رندر ساخته می‌شوند؛ برای پایداریِ وابستگی در useEffect
    // آخرین نسخه در ref نگه داشته می‌شود (همان ترفند `useAdminQuery`).
    const fetcherRef = useRef(fetcher)
    fetcherRef.current = fetcher

    const run = useCallback(() => {
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
                if (e instanceof Error && e.name === "AbortError") return
                setError(toTicketRequestError(e))
            })
            .finally(() => {
                if (seq === requestSeq.current && !controller.signal.aborted) setLoading(false)
            })
    }, [])

    // `key` در وابستگی‌هاست تا تغییر URL/pagination باعث درخواست تازه شود.
    useEffect(() => {
        run()
        return () => {
            inflight.current?.abort()
            requestSeq.current += 1
        }
    }, [key, run])

    const refetch = useCallback(() => {
        run()
    }, [run])

    return { data, loading, error, refetch }
}
