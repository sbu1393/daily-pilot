"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "@/app/lib/api/client"
import { faDigits } from "@/app/lib/time"
import { type TaskItem } from "./taskTypes"
import { type SuggestionData } from "./SuggestionModal"
import taskStyles from "./task.module.css"
import styles from "./suggestion.module.css"

// ADR-006 (Phase S3/S4) + A1 Phase 3 — کارت/بنر پیشنهاد روز.
//
// A1 Phase 3 — مالکیت state: این کارت تنها مالکِ state پیشنهاد (fetch + نگه‌داری) است؛
// مودال «ارائه‌دهنده»ی خالص است و والد (DailyTaskList) با onOpenModal داده را می‌گیرد و
// جهشِ تأییدشده را تزریق می‌کند. به همین دلیل هیچ state موازی‌ای برای blueprint وجود ندارد.
//
// نمایش:
// - Actionable (کار جاافتاده دارد): بنر پیشنهاد + دکمه‌ی «دیدن پیشنهاد».
// - Plan Stale (§6.3.2): چیپِ کم‌سر‌و‌صدای «برنامه با تغییرات اخیر همخوان نیست».
// خودش mutation ندارد؛ انتقال از طریق onRollover والد (POST /api/tasks/rollover موجود) انجام می‌شود.
//
// rebase: دکمه‌ی «دیدن پیشنهاد» داده را به والد می‌دهد (onOpenModal — ساختار نسخه‌ی remote)؛
// منطق A1 (گیتِ actionable و چیپ کهنه) دست‌نخورده باقی مانده است.

type Props = {
    dayKey: string
    tasks: TaskItem[]
    /** A1: تحویل blueprint به والد که مالک مودال و جهش تأییدشده است */
    onOpenModal: (data: SuggestionData) => void
}

export default function SuggestionCard({ dayKey, tasks, onOpenModal }: Props) {
    const [suggestion, setSuggestion] = useState<SuggestionData | null>(null)
    const requestSeq = useRef(0)

    const load = useCallback(
        async (silent = false) => {
            const seq = ++requestSeq.current
            if (!silent) setSuggestion(null)
            try {
                const data = await api<SuggestionData>(`/api/planner/suggestion?date=${dayKey}`)
                // فقط آخرین پاسخ معتبر است (محافظ تعویض سریع روز)
                if (seq === requestSeq.current) setSuggestion(data)
            } catch {
                // فقط خواندنی — خطا هیچ‌وقت نباید نمای روز را خراب کند؛ کارت بی‌صدا حذف می‌شود
                if (seq === requestSeq.current && !silent) setSuggestion(null)
            }
        },
        [dayKey],
    )

    // لود اولیه + رفرش بی‌صدا بعد از هر mutation برنامه (تغییر بودجه/ساخت/حذف/انتقال)
    useEffect(() => {
        const onMutated = () => {
            void load(true)
        }
        void load()
        window.addEventListener("planner:mutated", onMutated)
        return () => window.removeEventListener("planner:mutated", onMutated)
    }, [load])

    if (suggestion === null) return null

    // فقط وقتی actionable است: کار جاافتاده وجود دارد و کار بازیافته هم هست
    const actionable =
        suggestion.unfitted.length > 0 && tasks.some((t) => t.status !== "DONE")

    // A1 Phase 3 — «برنامه کهنه» (§6.3.2): stale ⇔ rebalancedVersion خالی یا planVersion > rebalancedVersion.
    // نبودِ رکورد DailyPlan هم طبق فاز ۱ «stale» است؛ ولی برای پرهیز از تکرار پیامِ
    // «وقت آزاد امروز را وارد کن»، بنر فقط وقتی می‌آید که یک پلن واقعی عقب افتاده باشد (planVersion > 0).
    const stale = suggestion.state === "stale" && (suggestion.basis?.planVersion ?? 0) > 0

    if (!actionable && !stale) return null

    return (
        <div
            className={`${styles.banner} ${stale && !actionable ? styles.bannerStale : ""}`}
            role="status"
        >
            {stale && (
                <span className={styles.staleChip}>
                    🕓 برنامه‌ی امروز با تغییرات اخیر همخوان نیست
                </span>
            )}
            {actionable && (
                <>
                    <span className={styles.bannerText}>
                        🧭 {faDigits(suggestion.unfitted.length)} کار در ظرفیت امروز جا نشده — پیشنهادی
                        برای برنامه‌ات دارم.
                    </span>
                    <button
                        className={taskStyles.btnPrimary}
                        onClick={() => onOpenModal(suggestion)}
                        aria-label="نمایش پیشنهاد برنامه امروز"
                    >
                        دیدن پیشنهاد
                    </button>
                </>
            )}
        </div>
    )
}
