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

type Props = {
    dayKey: string
    tasks: TaskItem[]
    /** انتقال کارهای انتخاب‌شده به فردا؛ promise باید در موفقیت resolve شود */
    onRollover: (ids: number[]) => Promise<void>
    onOpenModal: (data: SuggestionData) => void;
}

export default function SuggestionCard({ dayKey, tasks, onRollover, onOpenModal }: Props) {
    const [suggestion, setSuggestion] = useState<SuggestionData | null>(null)
    const [modalOpen, setModalOpen] = useState(false)
    const requestSeq = useRef(0)

    const load = useCallback(
        async (silent = false) => {
            const seq = ++requestSeq.current
            if (!silent) setSuggestion(null)
            try {
                const data = await api<SuggestionData>(`/api/planner/suggestion?date=${dayKey}`)
                // فقط آخرین پاسخ معتبر است
                if (seq === requestSeq.current) setSuggestion(data)
            } catch {
                if (seq === requestSeq.current && !silent) setSuggestion(null)
            }
        },
        [dayKey],
    )

    useEffect(() => {
        const onMutated = () => {
            void load(true)
        }
        void load()
        window.addEventListener("planner:mutated", onMutated)
        return () => window.removeEventListener("planner:mutated", onMutated)
    }, [load])

    // شرط نمایش: پیشنهاد لود شده باشد، کار جاافتاده داشته باشیم و در لیست تسک‌ها کار غیر انجام شده باشد
    const actionable = suggestion !== null && tasks.length > 0;

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
                    onClick={() => onOpenModal(suggestion)} // اینجا پیشنهاد را پاس می‌دهیم
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
                    await onRollover(ids)
                    setModalOpen(false)
                }}
            />
        </>
    )
}
