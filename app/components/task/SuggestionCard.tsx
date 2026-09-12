"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "@/app/lib/api/client"
import { faDigits } from "@/app/lib/time"
import { type TaskItem } from "./taskTypes"
import SuggestionModal, { type SuggestionData } from "./SuggestionModal"
import taskStyles from "./task.module.css"
import styles from "./suggestion.module.css"

// ADR-006 (Phase S3/S4) — کارت/بنر پیشنهاد روز.
// فقط وقتی نشان داده می‌شود که روز شلوغ باشد و کارِ جاافتاده وجود داشته باشد.
// خودش mutation ندارد؛ انتقال از طریق onRollover والد (POST /api/tasks/rollover موجود) انجام می‌شود.

type Props = {
    dayKey: string
    tasks: TaskItem[]
    /** انتقال کارهای انتخاب‌شده به فردا؛ promise باید در موفقیت resolve شود */
    onRollover: (ids: number[]) => Promise<void>
}

export default function SuggestionCard({ dayKey, tasks, onRollover }: Props) {
    const [suggestion, setSuggestion] = useState<SuggestionData | null>(null)
    const [modalOpen, setModalOpen] = useState(false)
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

    // فقط وقتی actionable است: پیشنهاد بارگذاری شده، کار جاافتاده وجود دارد و کار بازیافته هم هست
    const actionable =
        suggestion !== null && suggestion.unfitted.length > 0 && tasks.some((t) => t.status !== "DONE")

    if (!actionable || suggestion === null) return null

    return (
        <>
            <div className={styles.banner} role="status">
                <span className={styles.bannerText}>
                    🧭 {faDigits(suggestion.unfitted.length)} کار در ظرفیت امروز جا نشده — پیشنهادی برای
                    برنامه‌ات دارم.
                </span>
                <button
                    className={taskStyles.btnPrimary}
                    onClick={() => setModalOpen(true)}
                    aria-label="نمایش پیشنهاد برنامه امروز"
                >
                    دیدن پیشنهاد
                </button>
            </div>

            <SuggestionModal
                open={modalOpen}
                onClose={() => setModalOpen(false)}
                suggestion={suggestion}
                tasks={tasks}
                onRollover={async (ids) => {
                    // موفقیت → مودال بسته می‌شود؛ رفرش و پیام را والد انجام می‌دهد
                    await onRollover(ids)
                    setModalOpen(false)
                }}
            />
        </>
    )
}
