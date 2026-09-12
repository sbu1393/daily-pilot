"use client"

import { useEffect, useMemo, useState } from "react"
import { faDigits, fmtMinutes } from "@/app/lib/time"
import { type TaskItem, type TaskPriority } from "./taskTypes"
import AnimatedModal from "../motion/AnimatedModal"
import taskStyles from "./task.module.css"
import styles from "./suggestion.module.css"

// ADR-006 (Phase S4) — مودال پیشنهاد برنامه‌ی روز.
// کاربر ۱۰۰٪ کنترل دارد: تیک‌های پیش‌فرض روی «جاافتاده‌ها» + دکمه‌ی تأیید صریح.
// انتقال فقط از طریق onRollover (POST /api/tasks/rollover موجود در DailyTaskList) انجام می‌شود؛
// این کامپوننت هیچ فراخوانی mutation مستقیمی ندارد. خطا داخل مودال نشان داده می‌شود.

/* قرارداد GET /api/planner/suggestion (ADR-006 / Phase S2) — نمای سمت کلاینت */
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
// اولویت تحلیلنشده (null — G-16) → نشان خنثا
const emojiOf = (t?: TaskItem) => (t?.priority ? priorityEmoji[t.priority] : "⚪")

type Props = {
    open: boolean
    onClose: () => void
    suggestion: SuggestionData
    tasks: TaskItem[]
    /** اگر داده شود، ردیف‌های «جاافتاده» قابل انتخاب می‌شوند و دکمه‌ی انتقال فعال است */
    onRollover?: (ids: number[]) => Promise<void>
}

export default function SuggestionModal({ open, onClose, suggestion, tasks, onRollover }: Props) {
    const [selected, setSelected] = useState<Set<number>>(() => new Set())
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    // عنوان/اولویت کارها از همان لیست روز می‌آید (قرارداد S2 را تغییر نمی‌دهیم)
    const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])
    const unfittedIds = useMemo(() => suggestion.unfitted.map((u) => u.taskId), [suggestion])

    // پیش‌فرض: همه‌ی کارهای جاافتاده انتخاب شده‌اند — همیشه همگام با آخرین پیشنهاد
    useEffect(() => {
        setSelected(new Set(unfittedIds))
    }, [unfittedIds])

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
            // موفقیت → والد مودال را می‌بندد و رفرش + پیام را انجام می‌دهد
            await onRollover([...selected])
        } catch (e) {
            // خطا داخل مودال — بدون شکستن وضعیت برنامه
            setError(e instanceof Error ? e.message : "خطا در انتقال کارها")
        } finally {
            setBusy(false)
        }
    }

    // هنگام اجرای انتقال، بستن (✕ / Escape / کلیک بیرون) قفل می‌شود
    const guardedClose = () => {
        if (!busy) onClose()
    }

    const showActions = onRollover !== undefined
    const noSelection = showActions && selected.size === 0

    return (
        <AnimatedModal open={open} onClose={guardedClose}>
            {/* نقش dialog + برچسب فارسی برای صفحه‌خوان‌ها */}
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

                {/* سنجه‌های ظرفیت */}
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

                {/* ظرفیت صفر/نامشخص — توضیح صادقانه به‌جای متن عمومی */}
                {suggestion.capacityMinutes <= 0 && (
                    <p className={styles.rationaleBox}>
                        برای امروز هنوز «وقت آزاد» تعیین نکرده‌ای. از کارت بالای صفحه وقت امروزت را وارد کن
                        تا برنامه‌ی دقیقی برایت بچینم.
                    </p>
                )}

                {/* برنامه‌ی امروز */}
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
                            return (
                                <li key={p.taskId} className={styles.taskRow}>
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
                                </li>
                            )
                        })}
                    </ul>
                )}

                {/* پیشنهاد انتقال */}
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

                {/* صداقت درباره‌ی تخمین پیش‌فرض (§5.4 «Ask actual duration») */}
                {suggestion.usedDefaultEstimate.length > 0 && (
                    <p className={styles.footnote}>
                        برای {faDigits(suggestion.usedDefaultEstimate.length)} کار از این فهرست هنوز تخمین
                        هوش مصنوعی ثبت نشده؛ فعلاً ۳۰ دقیقه پیش‌فرض برایش در نظر گرفته شده — با «تحلیل هوشمند»
                        می‌توانی دقیقش کنی.
                    </p>
                )}

                {/* راهنمای وقتی هیچ کاری انتخاب نشده */}
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
