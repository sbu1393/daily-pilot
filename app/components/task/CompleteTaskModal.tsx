"use client"

import { useEffect, useState } from "react"
import { fmtMinutes } from "@/app/lib/time"
import { toast } from "react-toastify"
import { useSettings } from "@/app/contexts/SettingsContext"
import AnimatedModal from "../motion/AnimatedModal" // مودال با انیمیشن فر머-موشن
import { type TaskItem } from "./taskTypes"
import styles from "./task.module.css"

type Props = {
    task: TaskItem | null
    onClose: () => void
    onCompleted: () => void
}

type Result = { saved: number; overspent: number; spent: number }

export default function CompleteTaskModal({ task, onClose, onCompleted }: Props) {
    const [minutes, setMinutes] = useState("")
    const [loading, setLoading] = useState(false)
    const [result, setResult] = useState<Result | null>(null)
    const { playBeep } = useSettings()

    useEffect(() => {
        if (task) {
            setMinutes(String(task.allocatedMinutes ?? task.estimatedTime ?? ""))
            setResult(null)
        }
    }, [task])

    useEffect(() => {
        if (!task) return
        const h = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose()
        }
        window.addEventListener("keydown", h)
        return () => window.removeEventListener("keydown", h)
    }, [task, onClose])

    if (!task) return null

    const reference = task.allocatedMinutes ?? task.estimatedTime

    const submit = async () => {
        const value = Number(minutes)
        if (!Number.isFinite(value) || value < 1 || value > 600) {
            toast.error("مدت باید بین ۱ تا ۶۰۰ دقیقه باشد")
            return
        }
        setLoading(true)
        try {
            const res = await fetch(`/api/tasks/${task.id}/complete`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ durationMinutes: value }),
            })
            const json = await res.json().catch(() => ({}))
            if (!res.ok) throw new Error((json as { message?: string }).message || "خطا در ثبت اتمام")

            // سرور پاسخ را به شکل { result: { savedMinutes, overspentMinutes } } برمی‌گرداند
            const body = json as { result?: { savedMinutes?: number; overspentMinutes?: number } }
            const saved = body.result?.savedMinutes ?? 0
            const overspent = body.result?.overspentMinutes ?? 0

            setResult({ saved, overspent, spent: value })
            playBeep()
        } catch (e) {
            toast.error(e instanceof Error ? e.message : "خطا در ثبت اتمام")
        } finally {
            setLoading(false)
        }
    }

    return (
        <AnimatedModal open={task !== null} onClose={onClose}>
            {!result ? (
                    <>
                        <div className={styles.modalHead}>
                            <h4>تمام کردن تسک</h4>
                            <button className={styles.closeBtn} onClick={onClose} aria-label="بستن">✕</button>
                        </div>
                        <p className={styles.taskTitle}>«{task.text}»</p>
                        {reference != null && (
                            <p className={styles.hint}>سهم این کار {fmtMinutes(reference)} است. چند دقیقه طول کشید؟</p>
                        )}
                        <div className={styles.minutesRow}>
                            <input
                                autoFocus
                                className={styles.input}
                                type="number"
                                min={1}
                                max={600}
                                value={minutes}
                                onChange={(e) => setMinutes(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" && !loading) submit()
                                }}
                            />
                            <span className={styles.unit}>دقیقه</span>
                        </div>
                        <div className={styles.modalActions}>
                            <button className={styles.btnPrimary} onClick={submit} disabled={loading}>
                                {loading ? "در حال ثبت…" : "ثبت و تمام شد ✅"}
                            </button>
                            <button className={styles.btnGhost} onClick={onClose} disabled={loading}>
                                انصراف
                            </button>
                        </div>
                    </>
                ) : (
                    <div className={styles.resultBox}>
                        {result.saved > 0 && (
                            <div className={styles.resultSaved}>
                                <div className={styles.resultEmoji}>🎉</div>
                                <h4>{fmtMinutes(result.saved)} زمان سیو شد!</h4>
                                <p>این زمان آزاد است و می‌توانی برای بقیه کارهای امروز استفاده کنی.</p>
                            </div>
                        )}
                        {result.overspent > 0 && (
                            <div className={styles.resultOverspent}>
                                <div className={styles.resultEmoji}>⚠️</div>
                                <h4>{fmtMinutes(result.overspent)} بیشتر از سهم طول کشید</h4>
                                <p>زمان کارهای باقی‌مانده دوباره تنظیم شد.</p>
                            </div>
                        )}
                        {result.saved === 0 && result.overspent === 0 && (
                            <div className={styles.resultSaved}>
                                <div className={styles.resultEmoji}>✅</div>
                                <h4>تسک تمام شد</h4>
                                <p>مدت واقعی: {fmtMinutes(result.spent)}</p>
                            </div>
                        )}
                        <button
                            className={styles.btnPrimary}
                            onClick={() => {
                                onClose()
                                onCompleted()
                            }}
                        >
                            باشه
                        </button>
                    </div>
                )}
        </AnimatedModal>
    )
}
