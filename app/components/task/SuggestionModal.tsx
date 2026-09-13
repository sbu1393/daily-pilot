"use client"

import { useEffect, useMemo, useState, useRef } from "react"
import { faDigits, fmtMinutes } from "@/app/lib/time"
import { type TaskItem, type TaskPriority } from "./taskTypes"
import AnimatedModal from "../motion/AnimatedModal"
import taskStyles from "./task.module.css"
import styles from "./suggestion.module.css"

// ADR-006 (Phase S4) + A1 Phase 3 — مودال «پیش‌نمایش برنامه» (Blueprint Preview).
// کاربر ۱۰۰٪ کنترل دارد: تیک‌های پیش‌فرض روی «جاافتاده‌ها» + دکمه‌ی تأیید صریح.
//
// A1 Phase 3:
// - کارهای IN_PROGRESS «قفل» علامت می‌خورند («در حال انجام — دست‌نخورده») و هرگز به‌صورت
//   پیش‌فرض برای انتقال انتخاب نمی‌شوند — آینه‌ی محافظت سمت سرور در rebalanceDay/suggestDay.
//   تیک آن‌ها همچنان در اختیار کاربر است (ADR-006 §3: هیچ تغییری بدون تأیید صریح کاربر).
// - هر ردیف برنامه، «تخصیص فعلی ➔ تخصیص پیشنهادی» را نشان می‌دهد (قبل/بعد).
// - لبه‌های ظرفیت صفر/نامشخص + a11y (progressbar/dialog/alert/note).
//
// انتقال فقط از طریق onRollover (POST /api/tasks/rollover موجود در DailyTaskList) انجام می‌شود؛
// این کامپوننت هیچ فراخوانی mutation مستقیمی ندارد. خطا داخل مودال نشان داده می‌شود.
//
// rebase: ساختار UI نسخه‌ی remote حفظ شده (مودال توسط والد رندر می‌شود، انتخاب پیش‌فرض با
// isFirstLoad و ردیف‌های «برنامه‌ی امروز» هم قابل انتخاب‌اند) و منطق A1 روی همان ساختار نشسته است.

/* قرارداد GET /api/planner/suggestion (ADR-006 / Phase S2 + A1 Phase 1) — نمای سمت کلاینت.
   فیلدهای A1 اختیاری خوانده می‌شوند تا نمای روز با پاسخ قدیمی/ناقص هم نشکند. */
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

export type SuggestionBasis = {
    planVersion: number
    rebalancedVersion: number | null
    availableMinutes: number
    taskCount: number
}

export type SuggestionData = {
    dayKey: string
    capacityMinutes: number
    planned: SuggestedTask[]
    unfitted: UnfittedTask[]
    plannedMinutes: number
    remainingMinutes: number
    usedDefaultEstimate: number[]
    /** A1 Phase 1 — تسک‌های IN_PROGRESS محافظت‌شده سمت سرور */
    protectedTaskIds?: number[]
    /** A1 Phase 1 — مبنای محاسبه (نسخه‌های پلن/ظرفیت/تعداد کار) */
    basis?: SuggestionBasis
    /** A1 Phase 1 — §6.3.2: fresh ⇔ rebalancedVersion == planVersion */
    state?: "fresh" | "stale"
}

const priorityEmoji: Record<TaskPriority, string> = { HIGH: "🔴", MEDIUM: "🟠", LOW: "🟢" }
const emojiOf = (t?: TaskItem) => (t?.priority ? priorityEmoji[t.priority] : "⚪")

const LOCK_BADGE = "در حال انجام — دست‌نخورده"

type Props = {
    open: boolean
    onClose: () => void
    suggestion: SuggestionData
    tasks: TaskItem[]
    /**
     * اگر داده شود، ردیف‌ها قابل انتخاب می‌شوند و دکمه‌ی انتقال فعال است.
     * A1 Phase 4: نسخه‌ی blueprint هم پاس داده می‌شود تا سرور بتواند پیشنهاد کهنه را رد کند.
     */
    onRollover?: (ids: number[], planVersion?: number) => Promise<void>
}

export default function SuggestionModal({ open, onClose, suggestion, tasks, onRollover }: Props) {
    const [selected, setSelected] = useState<Set<number>>(new Set())
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const isFirstLoad = useRef(true)

    // عنوان/اولویت کارها از همان لیست روز می‌آید (قرارداد S2 را تغییر نمی‌دهیم)
    const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks])

    // A1 Phase 3 — «قفل‌شده» = در حال انجام (از لیست روز) یا محافظت‌شده‌ی سمت سرور.
    // این مجموعه دقیقاً همان چیزی است که موتور کاهش نمی‌دهد.
    const lockedIds = useMemo(() => {
        const ids = new Set<number>(suggestion.protectedTaskIds ?? [])
        for (const t of tasks) if (t.status === "IN_PROGRESS") ids.add(t.id)
        return ids
    }, [suggestion, tasks])

    // پیش‌فرضِ تیک‌ها: کارهای جاافتاده، بدون کارهای «در حال انجام»
    const movableIds = useMemo(
        () => suggestion.unfitted.map((u) => u.taskId).filter((id) => !lockedIds.has(id)),
        [suggestion.unfitted, lockedIds],
    )

    // در اولین باز شدن، کارهای پیشنهادی برای انتقال تیک می‌خورند (بدون کارهای قفل‌شده)
    useEffect(() => {
        if (open && isFirstLoad.current) {
            setSelected(new Set(movableIds))
            isFirstLoad.current = false
        }
    }, [open, movableIds])

    // با بسته شدن مودال وضعیت لود ریست می‌شود
    useEffect(() => {
        if (!open) {
            isFirstLoad.current = true
        }
    }, [open])

    const allLocked = suggestion.unfitted.length > 0 && movableIds.length === 0

    // ظرفیت صفر → نوار خالی؛ مجموع محافظت‌شده‌ها می‌تواند از ظرفیت بگذرد → clamp
    const utilization =
        suggestion.capacityMinutes > 0
            ? Math.min(
                  100,
                  Math.max(
                      0,
                      Math.round((suggestion.plannedMinutes / suggestion.capacityMinutes) * 100),
                  ),
              )
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
            // A1 Phase 4: نسخه‌ی blueprint همراه درخواست می‌رود (اگر موجود باشد).
            // موفقیت → بلافاصله مودال بسته می‌شود و والد رفرش + پیام را انجام می‌دهد.
            await onRollover([...selected], suggestion.basis?.planVersion)
            onClose()
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
                        aria-valuetext={`${faDigits(utilization)} درصد از ظرفیت امروز`}
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
                            const locked = lockedIds.has(p.taskId)
                            const title = t?.title ?? `کار ${faDigits(p.taskId)}`
                            // A1 Phase 3 — قبل/بعد: تخصیص فعلیِ ذخیره‌شده در برابر سهم پیشنهادی
                            const current = t?.allocatedMinutes ?? null
                            const comparison =
                                current !== null && current !== p.suggestedMinutes
                                    ? {
                                          from: current,
                                          to: p.suggestedMinutes,
                                          delta: p.suggestedMinutes - current,
                                      }
                                    : null

                            const row = (
                                <>
                                    <span className={styles.emoji} aria-hidden="true">
                                        {emojiOf(t)}
                                    </span>
                                    <span className={styles.name}>
                                        {title}
                                        {locked && (
                                            <small className={styles.lockBadge} aria-label={LOCK_BADGE}>
                                                🛡 {LOCK_BADGE}
                                            </small>
                                        )}
                                        {!locked && p.partial && (
                                            <small className={styles.rationale}>
                                                تخمین {fmtMinutes(p.estimatedMinutes)} بود — سهم کم شد
                                            </small>
                                        )}
                                    </span>
                                    {comparison ? (
                                        /* قبل/بعد — ترتیب LTR تا «فعلی ➔ پیشنهادی» مثل نمونه خوانده شود */
                                        <span
                                            className={styles.compare}
                                            dir="ltr"
                                            aria-label={`تخصیص فعلی ${fmtMinutes(
                                                comparison.from,
                                            )}، پیشنهاد ${fmtMinutes(comparison.to)}`}
                                        >
                                            <span className={styles.compareOld}>
                                                {fmtMinutes(comparison.from)}
                                            </span>
                                            <span className={styles.compareArrow} aria-hidden="true">
                                                ➔
                                            </span>
                                            <b className={styles.compareNew}>
                                                {fmtMinutes(comparison.to)}
                                            </b>
                                            <em
                                                className={`${styles.delta} ${
                                                    comparison.delta < 0
                                                        ? styles.deltaDown
                                                        : styles.deltaUp
                                                }`}
                                                aria-hidden="true"
                                            >
                                                {comparison.delta < 0 ? "−" : "+"}
                                                {faDigits(Math.abs(comparison.delta))}
                                            </em>
                                        </span>
                                    ) : (
                                        <span className={styles.dur}>
                                            {fmtMinutes(p.suggestedMinutes)}
                                            {p.partial && (
                                                <em className={styles.partialChip}>کاهش‌یافته</em>
                                            )}
                                        </span>
                                    )}
                                </>
                            )

                            return showActions ? (
                                <label key={p.taskId} className={styles.pickRow}>
                                    <input
                                        type="checkbox"
                                        checked={selected.has(p.taskId)}
                                        onChange={() => toggle(p.taskId)}
                                        disabled={busy}
                                        aria-label={`انتخاب ${title}${
                                            locked ? " (در حال انجام)" : ""
                                        }`}
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
                            const locked = lockedIds.has(u.taskId)
                            const biggerThanCapacity = u.estimatedMinutes > suggestion.capacityMinutes
                            const title = t?.title ?? `کار ${faDigits(u.taskId)}`
                            const row = (
                                <>
                                    <span className={styles.emoji} aria-hidden="true">
                                        {emojiOf(t)}
                                    </span>
                                    <span className={styles.name}>
                                        {title}
                                        {locked && (
                                            <small className={styles.lockBadge} aria-label={LOCK_BADGE}>
                                                🛡 {LOCK_BADGE}
                                            </small>
                                        )}
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
                                        aria-label={
                                            locked
                                                ? `انتقال ${title} به فردا (در حال انجام)`
                                                : `انتقال ${title} به فردا`
                                        }
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

                {/* ظرفیت صفر: هیچ کاری در برنامه نیست و کاربر باید اول وقت تعیین کند */}
                {suggestion.capacityMinutes <= 0 && suggestion.planned.length === 0 && (
                    <p className={styles.footnote} role="note">
                        وقتی ظرفیت امروز صفر باشد، هیچ کاری در «برنامه‌ی امروز» قرار نمی‌گیرد و همه‌ی کارها
                        به‌عنوان پیشنهادِ انتقال نشان داده می‌شوند.
                    </p>
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
                        {allLocked
                            ? "همه‌ی کارهای جاافتاده «در حال انجام» هستند و دست‌نخورده می‌مانند — چیزی برای انتقال نیست."
                            : "هیچ کاری انتخاب نشده — یا کارها را انتخاب کن، یا با «فعلاً نه» برنامه‌ی امروز را نگه دار."}
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
                                      ? allLocked
                                          ? "چیزی برای انتقال نیست"
                                          : "برای انتقال، کار انتخاب کن"
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
