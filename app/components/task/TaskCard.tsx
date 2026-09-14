"use client"

import { memo } from "react"
import { motion } from "framer-motion"
import { fmtMinutes, faDigits } from "@/app/lib/time"
import TimeAgo from "../TimeAgo"
import { getCanonicalToday } from "@/app/lib/canonicalDay"
import { useCalendar } from "@/app/contexts/CalenderContext"
import { categoryInfo, priorityMeta, priorityMissingMeta, type TaskItem } from "./taskTypes"
import styles from "./task.module.css"

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
    onReanalyze?: (task: TaskItem) => void // ۲. اختیاری کردن پروپ تا خطای تایپ ندهد
}

// ۳. اضافه کردن onReanalyze به پارامترهای ورودی کامپوننت
function TaskCard({ task, onComplete, onDelete, onReanalyze }: Props) {
    const { timezone } = useCalendar()
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

    return (
        <motion.li
            className={`${styles.card} ${done ? styles.done : ""}`}
            variants={cardVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            layout
        >
            <div className={styles.topRow}>
                <span className={styles.text}>{task.title}</span>
                {done && <span className={styles.doneTag}>✓ انجام شد</span>}
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

            {task.reason && <p className={styles.reason}>💡 {task.reason}</p>}

            <div className={styles.times}>
                {task.estimatedTime != null ? (
                    <span>
                    تخمین AI:{" "}
                    <b dir="rtl">
                        {fmtMinutes(task.estimatedTime)}
                    </b>
                </span>
                ) : (
                    <span>تخمین AI: <b className="dp-ai-missing">—</b></span>
                )}
                {!done &&
                    (task.allocatedMinutes != null ? (
                        <span>
                            سهم امروز: <b className={styles.alloc}>{fmtMinutes(task.allocatedMinutes)}</b>
                        </span>
                    ) : (
                        <span className={styles.muted}>⏳ هنوز برنامه‌ریزی نشده (بودجه روز را تنظیم کن)</span>
                    ))}
                {done && task.spentMinutes != null && (
                    <>
                        <span>زمان واقعی: <b>{fmtMinutes(task.spentMinutes)}</b></span>
                        {saved > 0 && <span className={styles.saved}>🎉 {fmtMinutes(saved)} سیو شد</span>}
                        {overspent > 0 && (
                            <span className={styles.overspent}>⚠️ {fmtMinutes(overspent)} بیشتر از سهم</span>
                        )}
                    </>
                )}
            </div>

            {!done && (
                <div className={styles.actions}>
                    <button className={styles.btnPrimary} onClick={() => onComplete(task)}>
                        تمام شد ✓
                    </button>
                    <button className={styles.btnGhost} onClick={() => onDelete(task)} title="حذف کار">
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
        </motion.li>
    )
}

export default memo(TaskCard)