"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "@/app/lib/api/client"
import { AI_QUOTA_CHANGED_EVENT } from "@/app/lib/aiQuotaEvents"

export interface AiQuotaStatusResponse {
    analyze: {
        remaining: number
        granted: number
        consumed: number
        promoRemaining: number
    }
    plan: {
        remaining: number
        granted: number
        consumed: number
        promoRemaining: number
    }
    mode: "LEGACY" | "NEW"
    periodStart: string
}

/** فاصلهٔ همگام‌سازی پس‌زمینه — فقط برای گرفتن تغییرهای خارج از اپ (مثل تمدید/تغییر policy ادمین). */
const REFRESH_INTERVAL_MS = 60_000

export function useAiQuota() {
    const [status, setStatus] = useState<AiQuotaStatusResponse | null>(null)
    const [loading, setLoading] = useState(true)

    // فقط آخرین درخواست اجازهٔ نوشتن روی state را دارد (درخواست‌های روی هم).
    const requestSeq = useRef(0)

    const refresh = useCallback(async (silent = false) => {
        const seq = ++requestSeq.current
        if (!silent) setLoading(true)
        try {
            const data = await api<AiQuotaStatusResponse>("/api/ai/quota")
            if (seq !== requestSeq.current) return
            setStatus(data)
        } catch {
            // endpoint شکست خورد → وضعیت را خالی می‌گذاریم. عمداً عددِ صفر یا
            // حدس نمایش نمی‌دهیم، چون «۰ باقی‌مانده» با «نمی‌دانیم» فرق دارد و
            // نباید کاربر را بی‌دلیل نگران کند.
            if (seq !== requestSeq.current) return
            setStatus(null)
        } finally {
            if (seq === requestSeq.current) setLoading(false)
        }
    }, [])

    // لود اولیه + همگام‌سازی دوره‌ای
    useEffect(() => {
        void refresh(false)
        const timer = setInterval(() => void refresh(true), REFRESH_INTERVAL_MS)
        return () => {
            clearInterval(timer)
            requestSeq.current += 1
        }
    }, [refresh])

    // بعد از هر عملیات AI: هم موفق، هم ناموفق (چون release عدد را برمی‌گرداند).
    useEffect(() => {
        const onChanged = () => {
            void refresh(true)
        }
        window.addEventListener(AI_QUOTA_CHANGED_EVENT, onChanged)
        return () => window.removeEventListener(AI_QUOTA_CHANGED_EVENT, onChanged)
    }, [refresh])

    return { status, loading, refresh }
}
