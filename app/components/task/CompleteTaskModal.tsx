"use client"

import { useEffect, useState } from "react"
import { fmtMinutes, parseSpentMinutes } from "@/app/lib/time"
import { toast } from "react-toastify"
import { useSettings } from "@/app/contexts/SettingsContext"
import { api } from "@/app/lib/api/client"
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

    // ±۵ دقیقه دور مقدار فعلی؛ کف ۱ دقیقه (همان مرز SPENT_MINUTES_MIN)
    const stepMinutes = (delta: number) => {
        const current = Number(minutes)
        const base = Number.isFinite(current) && current > 0 ? current : 0
        setMinutes(String(Math.max(1, Math.min(600, base + delta))))
    }

    const submit = async () => {
        const parsed = parseSpentMinutes(minutes) // §5.4.1: Validate duration — ورودی نامعتبر هرگز به API نمی‌رسد
        if (!parsed.ok) {
            toast.error(parsed.error)
            return
        }
        const value = parsed.value
        setLoading(true)
        try {
            // ADR-04: پاسخ { ok, data: { task, result, summaries } } → data.result
            const body = await api<{ result?: { savedMinutes?: number; overspentMinutes?: number } }>(
                `/api/tasks/${task.id}/complete`,
                {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ spentMinutes: value }),
                },
            )
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
                        <p className={styles.taskTitle}>«{task.title}»</p>
                        {reference != null && (
                            <p className={styles.hint}>سهم این کار {fmtMinutes(reference)} است. چند دقیقه طول کشید؟</p>
                        )}
                        <div className={styles.minutesRow}>
                            <div className={styles.stepper}>
                                <button
                                    type="button"
                                    className={styles.stepBtn}
                                    onClick={() => stepMinutes(-5)}
                                    aria-label="کاهش ۵ دقیقه‌ای"
                                    disabled={loading}
                                >
                                    −۵
                                </button>
                                <input
                                    autoFocus
                                    className={styles.input}
                                    type="number"
                                    min={1}
                                    max={600}
                                    step={5}
                                    value={minutes}
                                    onChange={(e) => setMinutes(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === "Enter" && !loading) submit()
                                    }}
                                />
                                <button
                                    type="button"
                                    className={styles.stepBtn}
                                    onClick={() => stepMinutes(5)}
                                    aria-label="افزایش ۵ دقیقه‌ای"
                                    disabled={loading}
                                >
                                    +۵
                                </button>
                            </div>
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
