"use client"

import { useEffect, useMemo, useState, useRef } from "react"
import { faDigits, fmtMinutes } from "@/app/lib/time"
import { type TaskItem, type TaskPriority } from "./taskTypes"
import AnimatedModal from "../motion/AnimatedModal"
import taskStyles from "./task.module.css"
import styles from "./suggestion.module.css"

export type SuggestedTask = {
    taskId: number
    estimatedMinutes: number
    suggestedMinutes: number
    partial: boolean
    weight: number
}

export type UnfittedTask = {
    taskId: number
    estimatedMinutes: number
    weight: number
}

export type SuggestionData = {
    dayKey: string
    capacityMinutes: number
    planned: SuggestedTask[]
    unfitted: UnfittedTask[]
    plannedMinutes: number
    remainingMinutes: number
    usedDefaultEstimate: number[]
}

const priorityEmoji: Record<TaskPriority, string> = { HIGH: "🔴", MEDIUM: "🟠", LOW: "🟢" }
const emojiOf = (t?: TaskItem) => (t?.priority ? priorityEmoji[t.priority] : "⚪")

type Props = {
    open: boolean
    onClose: () => void
    suggestion: SuggestionData
    tasks: TaskItem[]
    onRollover?: (ids: number[]) => Promise<void>
}

export default function SuggestionModal({ open, onClose, suggestion, tasks, onRollover }: Props) {
    const [selected, setSelected] = useState<Set<number>>(new Set())
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const isFirstLoad = useRef(true)

    const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])
    const unfittedIds = useMemo(() => suggestion.unfitted.map((u) => u.taskId), [suggestion])

    // در اولین باز شدن، کارهای پیشنهادی برای انتقال تیک می‌خورند
    useEffect(() => {
        if (open && isFirstLoad.current) {
            setSelected(new Set(unfittedIds))
            isFirstLoad.current = false
        }
    }, [open, unfittedIds])

    // با بسته شدن مودال وضعیت لود ریست می‌شود
    useEffect(() => {
        if (!open) {
            isFirstLoad.current = true
        }
    }, [open])

    const utilization =
        suggestion.capacityMinutes > 0
            ? Math.min(100, Math.round((suggestion.plannedMinutes / suggestion.capacityMinutes) * 100))
            : 0

    const toggle = (id: number) => {
        if (busy) return
        setSelected((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    const handleMove = async () => {
        if (!onRollover || busy || selected.size === 0) return
        setBusy(true)
        setError(null)
        try {
            await onRollover([...selected])
        } catch (e) {
            setError(e instanceof Error ? e.message : "خطا در انتقال کارها")
        } finally {
            setBusy(false)
        }
    }

    const guardedClose = () => {
        if (!busy) onClose()
    }

    const showActions = onRollover !== undefined
    const noSelection = showActions && selected.size === 0

    return (
        <AnimatedModal open={open} onClose={guardedClose}>
            <div role="dialog" aria-modal="true" aria-label="پیشنهاد برنامه امروز">
                <div className={taskStyles.modalHead}>
                    <h4>🧭 پیشنهاد برنامه‌ی امروز</h4>
                    <button
                        className={taskStyles.closeBtn}
                        onClick={guardedClose}
                        disabled={busy}
                        aria-label="بستن پیشنهاد"
                    >
                        ✕
                    </button>
                </div>

                <p className={styles.intro}>
                    بر اساس ظرفیت امروز و اولویت کارهایت — هیچ کاری بدون تأیید تو جابه‌جا نمی‌شود.
                </p>

                <div className={styles.utilBox}>
                    <div className={styles.utilRow}>
                        <span>ظرفیت امروز</span>
                        <b>{fmtMinutes(suggestion.capacityMinutes)}</b>
                    </div>
                    <div className={styles.utilRow}>
                        <span>برنامه‌ریزی‌شده</span>
                        <b>{fmtMinutes(suggestion.plannedMinutes)}</b>
                    </div>
                    <div className={styles.utilRow}>
                        <span>باقی‌مانده</span>
                        <b>{fmtMinutes(suggestion.remainingMinutes)}</b>
                    </div>
                    <div
                        className={styles.bar}
                        role="progressbar"
                        aria-valuenow={utilization}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label="مصرف ظرفیت امروز"
                    >
                        <div className={styles.barFill} style={{ width: `${utilization}%` }} />
                    </div>
                </div>

                {suggestion.capacityMinutes <= 0 && (
                    <p className={styles.rationaleBox}>
                        برای امروز هنوز «وقت آزاد» تعیین نکرده‌ای. از کارت بالای صفحه وقت امروزت را وارد کن
                        تا برنامه‌ی دقیقی برایت بچینم.
                    </p>
                )}

                {/* ۱. کارهای برنامه‌ریزی‌شده برای امروز */}
                <h5 className={styles.sectionTitle}>برنامه‌ی امروز</h5>
                {suggestion.planned.length === 0 ? (
                    <p className={styles.rationaleBox}>
                        {suggestion.capacityMinutes <= 0
                            ? "چون ظرفیتی برای امروز تعیین نشده، فعلاً کاری پیشنهاد نمی‌کنم."
                            : "هیچ کاری در ظرفیت امروز جا نمی‌شود."}
                    </p>
                ) : (
                    <ul className={styles.taskList}>
                        {suggestion.planned.map((p) => {
                            const t = byId.get(p.taskId)
                            const row = (
                                <>
                                    <span className={styles.emoji} aria-hidden="true">
                                        {emojiOf(t)}
                                    </span>
                                    <span className={styles.name}>
                                        {t?.title ?? `کار ${faDigits(p.taskId)}`}
                                    </span>
                                    <span className={styles.dur}>
                                        {fmtMinutes(p.suggestedMinutes)}
                                        {p.partial && <em className={styles.partialChip}>کاهش‌یافته</em>}
                                    </span>
                                </>
                            )

                            return showActions ? (
                                <label key={p.taskId} className={styles.pickRow}>
                                    <input
                                        type="checkbox"
                                        checked={selected.has(p.taskId)}
                                        onChange={() => toggle(p.taskId)}
                                        disabled={busy}
                                        aria-label={`انتخاب ${t?.title ?? `کار ${faDigits(p.taskId)}`}`}
                                    />
                                    {row}
                                </label>
                            ) : (
                                <li key={p.taskId} className={styles.taskRow}>
                                    {row}
                                </li>
                            )
                        })}
                    </ul>
                )}

                {/* ۲. پیشنهاد انتقال به فردا */}
                <h5 className={styles.sectionTitle}>پیشنهاد انتقال به فردا</h5>
                {suggestion.unfitted.length === 0 ? (
                    <p className={styles.rationaleBox}>همه‌ی کارها در ظرفیت امروز جا شدند. 🎉</p>
                ) : (
                    <ul className={styles.taskList}>
                        {suggestion.unfitted.map((u) => {
                            const t = byId.get(u.taskId)
                            const biggerThanCapacity = u.estimatedMinutes > suggestion.capacityMinutes
                            const row = (
                                <>
                                    <span className={styles.emoji} aria-hidden="true">
                                        {emojiOf(t)}
                                    </span>
                                    <span className={styles.name}>
                                        {t?.title ?? `کار ${faDigits(u.taskId)}`}
                                        <small className={styles.rationale}>
                                            {biggerThanCapacity
                                                ? "از کل ظرفیت امروز بزرگ‌تر است"
                                                : "ظرفیت امروز برای این کار پر شده است"}
                                        </small>
                                    </span>
                                    <span className={styles.dur}>{fmtMinutes(u.estimatedMinutes)}</span>
                                </>
                            )
                            return showActions ? (
                                <label key={u.taskId} className={styles.pickRow}>
                                    <input
                                        type="checkbox"
                                        checked={selected.has(u.taskId)}
                                        onChange={() => toggle(u.taskId)}
                                        disabled={busy}
                                        aria-label={`انتقال ${t?.title ?? `کار ${faDigits(u.taskId)}`} به فردا`}
                                    />
                                    {row}
                                </label>
                            ) : (
                                <li key={u.taskId} className={styles.taskRow}>
                                    {row}
                                </li>
                            )
                        })}
                    </ul>
                )}

                {suggestion.usedDefaultEstimate.length > 0 && (
                    <p className={styles.footnote}>
                        برای {faDigits(suggestion.usedDefaultEstimate.length)} کار از این فهرست هنوز تخمین
                        هوش مصنوعی ثبت نشده؛ فعلاً ۳۰ دقیقه پیش‌فرض برایش در نظر گرفته شده — با «تحلیل هوشمند»
                        می‌توانی دقیقش کنی.
                    </p>
                )}

                {noSelection && !busy && (
                    <p className={styles.footnote} role="note">
                        هیچ کاری انتخاب نشده — یا کارها را انتخاب کن، یا با «فعلاً نه» برنامه‌ی امروز را
                        نگه دار.
                    </p>
                )}

                {error && (
                    <p className={taskStyles.inlineError} role="alert">
                        {error}
                    </p>
                )}

                <div className={taskStyles.modalActions}>
                    {showActions ? (
                        <>
                            <button
                                className={taskStyles.btnPrimary}
                                onClick={handleMove}
                                disabled={busy || selected.size === 0}
                                aria-disabled={busy || selected.size === 0}
                            >
                                {busy
                                    ? "در حال انتقال…"
                                    : selected.size === 0
                                        ? "برای انتقال، کار انتخاب کن"
                                        : `انتقال ${faDigits(selected.size)} کار به فردا`}
                            </button>
                            <button className={taskStyles.btnGhost} onClick={guardedClose} disabled={busy}>
                                فعلاً نه
                            </button>
                        </>
                    ) : (
                        <button className={taskStyles.btnPrimary} onClick={onClose}>
                            فهمیدم
                        </button>
                    )}
                </div>

                {!showActions && (
                    <p className={styles.readonlyNote}>
                        این فهرست صرفاً پیشنهاد است؛ هیچ تغییری در برنامه‌ات اعمال نشده.
                    </p>
                )}
            </div>
        </AnimatedModal>
    )
}
