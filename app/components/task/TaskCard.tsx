"use client"

import { memo, useEffect, useId, useState } from "react"
import { motion } from "framer-motion"
import { fmtMinutes, faDigits } from "@/app/lib/time"
import TimeAgo from "../TimeAgo"
import { getCanonicalToday } from "@/app/lib/canonicalDay"
import { useCalendar } from "@/app/contexts/CalenderContext"
import { categoryInfo, priorityMeta, priorityMissingMeta, type TaskItem } from "./taskTypes"
import styles from "./task.module.css"
import { AlarmClock, ChevronDown } from "lucide-react"
// «تنظیم زمان» — فقط خواندن یادآوری از context و یک دکمه/نشان اضافه؛ هیچ منطق موجودی تغییر نکرده
import { useTaskReminders } from "@/app/hooks/useTaskReminder"
import { formatReminderTime } from "@/app/lib/taskReminder"
import reminderStyles from "./reminder.module.css"

/* انیمیشن ورود کارت (لیست با stagger هماهنگ می‌شود) */
const cardVariants = {
    hidden: { opacity: 0, y: 14 },
    visible: {
        opacity: 1,
        y: 0,
        transition: { duration: 0.3, ease: "easeOut" as const },
    },
    exit: {
        opacity: 0,
        scale: 0.96,
        transition: { duration: 0.18 },
    },
}

type Props = {
    task: TaskItem
    onComplete: (t: TaskItem) => void
    onDelete: (t: TaskItem) => void
    onReanalyze?: (task: TaskItem) => void
    /** اختیاری — باز کردن مودال «تنظیم زمان» (additive؛ بدون آن کارت مثل قبل کار می‌کند) */
    onRemind?: (task: TaskItem) => void
}

/**
 * کارت تسک آکاردئونی.
 *
 * - نمای بسته (پیش‌فرض): عنوان، چیپ‌های دسته/اولویت/امتیاز، زمان ایجاد،
 *   خلاصه‌ی کارِ انجام‌شده و دکمه‌ی سریع «تمام شد».
 * - نمای باز: دلیل هوش مصنوعی، تخمین و سهم امروز، و دکمه‌های حذف و تحلیل مجدد.
 *
 * وضعیت باز/بسته محلی هر کارت است تا چند کارت هم‌زمان باز بمانند و `memo` حفظ شود.
 * باز/بسته‌شدن پنل با CSS انجام می‌شود (`grid-template-rows: 0fr → 1fr` در
 * `.panel`/`.panelOpen`) تا خطر جابه‌جایی‌های `layout` در framer-motion نباشد؛
 * به همین دلیل پنل همیشه در DOM می‌ماند و با `visibility` از ناظر پنهان می‌شود.
 * کارتِ DONE خودش جمع می‌شود؛ کارتِ DONE بدون دلیل، چیزی برای باز‌کردن ندارد.
 */
function TaskCard({ task, onComplete, onDelete, onReanalyze, onRemind }: Props) {
    const { timezone } = useCalendar()
    const [open, setOpen] = useState(false)
    // یادآوری فقط بعد از خواندن localStorage معنا دارد (ready) → رندر سرور و کلاینت یکسان می‌ماند
    const { ready: remindersReady, getReminder } = useTaskReminders()
    const reminder = remindersReady ? getReminder(task.id) : undefined
    const uid = useId()
    const headerId = `${uid}-header`
    const panelId = `${uid}-panel`

    const done = task.status === "DONE"
    const cat = categoryInfo(task.category)
    const pr = task.priority != null ? priorityMeta[task.priority] : priorityMissingMeta

    const saved =
        task.allocatedMinutes != null && task.spentMinutes != null
            ? Math.max(0, task.allocatedMinutes - task.spentMinutes)
            : 0
    const overspent =
        task.allocatedMinutes != null && task.spentMinutes != null
            ? Math.max(0, task.spentMinutes - task.allocatedMinutes)
            : 0

    // با رسیدن به DONE، کارت خودش جمع می‌شود تا لیست تمیز بماند
    useEffect(() => {
        if (done) setOpen(false)
    }, [done])

    // کارِ انجام‌شده‌ی بدون دلیل، محتوای بازشدنی ندارد → سربرگ فقط نمایشی است
    const canExpand = !done || Boolean(task.reason)

    // نشان یادآوری کنار عنوان — با زمانِ زمان‌بندی‌شده (فقط پس از خواندن localStorage)
    const reminderBadge = reminder ? (
        <span
            className={`${reminderStyles.badge} ${
                reminder.firedAt !== null ? reminderStyles.badgePast : ""
            }`}
            title="یادآوری برای این تسک تنظیم شده است"
        >
            🔔 {formatReminderTime(reminder.dueAt, timezone)}
        </span>
    ) : null

    return (
        <motion.li
            className={`${styles.card} ${done ? styles.done : ""}`}
            variants={cardVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            layout
        >
            <div className={styles.cardHeader}>
                {!done && (
                    <button
                        type="button"
                        className={styles.quickDone}
                        onClick={() => onComplete(task)}
                        aria-label={`تمام کردن «${task.title}»`}
                        title="تمام شد"
                    >
                        ✓
                    </button>
                )}

                {canExpand ? (
                    <button
                        type="button"
                        id={headerId}
                        className={styles.cardToggle}
                        onClick={() => setOpen((prev) => !prev)}
                        aria-expanded={open}
                        aria-controls={panelId}
                    >
                        <span className={styles.text}>{task.title}</span>
                        {reminderBadge}
                        {done && <span className={styles.doneTag}>✓ انجام شد</span>}
                        <span
                            className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`}
                            aria-hidden="true"
                        >
                            <ChevronDown />
                        </span>
                    </button>
                ) : (
                    <div className={styles.cardStatic}>
                        <span className={styles.text}>{task.title}</span>
                        {reminderBadge}
                        {done && <span className={styles.doneTag}>✓ انجام شد</span>}
                    </div>
                )}
            </div>

            <div className={styles.chips}>
                <span className={styles.chip} style={{ color: cat.color, background: cat.bg }}>
                    {cat.label}
                </span>
                {/* در حالت آفلاین (مقادیر null) به‌جای اطلاعات AI خط تیره نشان داده می‌شود */}
                {task.score == null && task.reason == null && task.estimatedTime == null ? (
                    <span className="dp-ai-missing">🤖 تحلیل هوش مصنوعی: —</span>
                ) : (
                    <>
                        <span className={styles.chip} style={{ color: pr.color, background: pr.bg }}>
                            اولویت: {pr.label}
                        </span>
                        {task.score != null && (
                            <span className={styles.chip} style={{ color: "#4f46e5", background: "#eef2ff" }}>
                                امتیاز {faDigits(task.score)}
                            </span>
                        )}
                    </>
                )}
                <span className={styles.chipTime} title="زمان ایجاد">
                    🕐 <TimeAgo date={task.createdAt} />
                </span>
            </div>

            {/* خلاصه‌ی کارِ انجام‌شده در نمای بسته می‌ماند — نگاه‌کردنی است */}
            {done && task.spentMinutes != null && (
                <div className={styles.times}>
                    <span>
                        زمان واقعی: <b>{fmtMinutes(task.spentMinutes)}</b>
                    </span>
                    {saved > 0 && <span className={styles.saved}>🎉 {fmtMinutes(saved)} سیو شد</span>}
                    {overspent > 0 && (
                        <span className={styles.overspent}>⚠️ {fmtMinutes(overspent)} بیشتر از سهم</span>
                    )}
                </div>
            )}

            {/* پنل همیشه در DOM می‌ماند؛ کلاس .panelOpen آن را باز می‌کند */}
            {canExpand && (
                <div
                    id={panelId}
                    role="region"
                    aria-labelledby={headerId}
                    className={`${styles.panel} ${open ? styles.panelOpen : ""}`}
                >
                    <div className={styles.panelInner}>
                        {task.reason && <p className={styles.reason}>💡 {task.reason}</p>}

                        {!done && (
                            <div className={styles.times}>
                                {task.estimatedTime != null ? (
                                    <span>
                                        تخمین AI: <b dir="rtl">{fmtMinutes(task.estimatedTime)}</b>
                                    </span>
                                ) : (
                                    <span>
                                        تخمین AI: <b className="dp-ai-missing">—</b>
                                    </span>
                                )}
                                {task.allocatedMinutes != null ? (
                                    <span>
                                        سهم امروز:{" "}
                                        <b className={styles.alloc}>{fmtMinutes(task.allocatedMinutes)}</b>
                                    </span>
                                ) : (
                                    <span className={styles.muted}>
                                        ⏳ هنوز برنامه‌ریزی نشده (بودجه روز را تنظیم کن)
                                    </span>
                                )}
                            </div>
                        )}

                        {!done && (
                            <div className={styles.actions}>
                                <button className={styles.btnPrimary} onClick={() => onComplete(task)}>
                                    تمام شد ✓
                                </button>
                                <button
                                    className={`${styles.btnGhost} ${reminderStyles.iconBtn}`}
                                    onClick={() => onRemind?.(task)}
                                    title="تنظیم زمان یادآوری با زنگ هشدار"
                                >
                                    <AlarmClock size={15} aria-hidden="true" /> تنظیم زمان
                                </button>
                                <button
                                    className={styles.btnGhost}
                                    onClick={() => onDelete(task)}
                                    title="حذف کار"
                                >
                                    حذف
                                </button>
                                {task.status === "TODO" && task.dayKey >= getCanonicalToday(timezone) && (
                                    <button
                                        type="button"
                                        className={styles.btnGhost}
                                        onClick={() => onReanalyze?.(task)}
                                        title=" تحلیل باهوش مصنوعی (اولویت، امتیاز، تخمین و دسته‌بندی)"
                                    >
                                        <span className={styles.lblLong}>🔄 تحلیل باهوش مصنوعی</span>
                                        <span className={styles.lblShort}>🔄 تحلیل</span>
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}
        </motion.li>
    )
}

export default memo(TaskCard)
