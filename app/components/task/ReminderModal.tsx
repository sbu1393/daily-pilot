"use client"

import { useEffect, useState } from "react"
import { toast } from "react-toastify"
import { AlarmClock, CalendarClock, Trash2 } from "lucide-react"
import AnimatedModal from "../motion/AnimatedModal"
import { useCalendar } from "@/app/contexts/CalenderContext"
import { useTaskReminders } from "@/app/hooks/useTaskReminder"
import {
    formatReminderRelative,
    formatReminderTime,
    fromDateTimeLocalValue,
    toDateTimeLocalValue,
    REMINDER_MIN_LEAD_MS,
    REMINDER_QUICK_CHOICES,
} from "@/app/lib/taskReminder"
import { type TaskItem } from "./taskTypes"
import styles from "./task.module.css"
import reminderStyles from "./reminder.module.css"

type Props = {
    task: TaskItem | null
    open: boolean
    onClose: () => void
}

/** پیش‌فرض وقتی هنوز یادآوری‌ای نیست: ۱۰ دقیقه بعد */
const DEFAULT_LEAD_MS = 10 * 60 * 1000

/**
 * پیام شکست ثبت یادآور روی نیتیو.
 *
 * «مجوز نگرفته شد» با «زمان نامعتبر است» یکی نیست و UI نباید وانمود کند یادآور
 * ساخته شده است؛ پس هر دلیل پیام خودش را دارد.
 */
const NATIVE_REASON_LABEL: Record<string, string> = {
    PERMISSION_DENIED: "برای یادآوری، اجازه‌ی نمایش اعلان را ندادی",
    PERMISSION_PROMPT: "برای یادآوری، اجازه‌ی نمایش اعلان لازم است",
    PERMISSION_FAILED: "بررسی اجازه‌ی اعلان ناموفق بود",
    IN_THE_PAST: "زمان یادآوری گذشته است",
    INVALID_DUE_AT: "زمان یادآوری معتبر نیست",
    INVALID_TASK_ID: "این کار معتبر نیست",
    NOT_NATIVE: "یادآوری نیتیو فقط در اپ اندروید کار می‌کند",
    PLUGIN_UNAVAILABLE: "سرویس اعلان در دسترس نیست",
}

/**
 * مودال «تنظیم یادآوری تسک».
 *
 * فقط با مودالِ استاندارد پروژه (AnimatedModal) و کلاس‌های موجود task.module.css
 * ساخته شده و هیچ رفتاری از مودال‌های دیگر را تغییر نمی‌دهد.
 */
export default function ReminderModal({ task, open, onClose }: Props) {
    const { timezone } = useCalendar()
    const { ready, getReminder, setReminder, removeTaskReminder } = useTaskReminders()

    const [value, setValue] = useState("")

    const existing = task ? getReminder(task.id) : undefined

    // با هر بار باز شدن (یا تغییر یادآوریِ ذخیره‌شده) ورودی با مقدار فعلی هم‌گام می‌شود
    useEffect(() => {
        if (!open || !task) return
        setValue(toDateTimeLocalValue(existing?.dueAt ?? Date.now() + DEFAULT_LEAD_MS))
    }, [open, task, existing?.dueAt])

    if (!task) return null

    const dueAt = fromDateTimeLocalValue(value)
    const now = Date.now()
    const tooSoon = dueAt != null && dueAt - now < REMINDER_MIN_LEAD_MS

    const applyQuickChoice = (minutes: number) => {
        setValue(toDateTimeLocalValue(Date.now() + minutes * 60_000))
    }

    const submit = async () => {
        if (dueAt == null) {
            toast.error("زمان یادآوری را انتخاب کن")
            return
        }
        if (tooSoon) {
            toast.error("زمان یادآوری باید در آینده باشد")
            return
        }

        /*
         * روی Android، مجوز اعلان پیش از ثبت گرفته می‌شود؛ اگر داده نشده باشد اصلاً
         * ثبت نمی‌شود و اینجا صادقانه خطا نشان داده می‌شود.
         */
        const result = await setReminder({ id: task.id, title: task.title }, dueAt)
        if (!result.ok) {
            toast.error(NATIVE_REASON_LABEL[result.reason] ?? "ثبت یادآوری ناموفق بود")
            return
        }

        toast.success(`یادآوری برای «${task.title}» ثبت شد ⏰`)
        onClose()
    }

    const remove = () => {
        void removeTaskReminder(task.id)
        toast.info("یادآوری حذف شد")
        onClose()
    }

    return (
        <AnimatedModal open={open} onClose={onClose}>
            <div className={styles.modalHead}>
                <h4>تنظیم یادآوری تسک</h4>
                <button className={styles.closeBtn} onClick={onClose} aria-label="بستن">
                    ✕
                </button>
            </div>

            <p className={styles.taskTitle}>«{task.title}»</p>

            {/* یادآوری فعال (اگر وجود دارد) */}
            {existing && (
                <div className={reminderStyles.activeBox}>
                    <span className={reminderStyles.activeIcon} aria-hidden="true">
                        <AlarmClock size={18} />
                    </span>
                    <div className={reminderStyles.activeText}>
                        <b>یادآوری فعال</b>
                        <span>
                            {formatReminderTime(existing.dueAt, timezone, now)}
                            {" · "}
                            {existing.firedAt !== null
                                ? "اجرا شده"
                                : formatReminderRelative(existing.dueAt, now)}
                        </span>
                    </div>
                </div>
            )}

            <label className={reminderStyles.fieldLabel} htmlFor="dp-reminder-at">
                <CalendarClock size={16} aria-hidden="true" /> زمان یادآوری
            </label>
            <input
                id="dp-reminder-at"
                className={reminderStyles.dateInput}
                type="datetime-local"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                disabled={!ready}
            />

            {/* انتخاب سریع */}
            <div className={reminderStyles.quickRow}>
                {REMINDER_QUICK_CHOICES.map((choice) => (
                    <button
                        key={choice.minutes}
                        type="button"
                        className={reminderStyles.quickChip}
                        onClick={() => applyQuickChoice(choice.minutes)}
                        disabled={!ready}
                    >
                        {choice.label}
                    </button>
                ))}
            </div>

            {/* پیش‌نمایش انتخاب کاربر */}
            <p className={reminderStyles.preview}>
                {dueAt == null ? (
                    <span className={reminderStyles.previewEmpty}>زمانی انتخاب نشده است</span>
                ) : tooSoon ? (
                    <span className={reminderStyles.previewWarn}>⚠️ این زمان خیلی نزدیک است</span>
                ) : (
                    <>
                        ⏰ {formatReminderTime(dueAt, timezone, now)}
                        {" · "}
                        {formatReminderRelative(dueAt, now)}
                    </>
                )}
            </p>

            <div className={styles.modalActions}>
                <button className={styles.btnPrimary} onClick={submit} disabled={!ready}>
                    ثبت یادآوری
                </button>
                <button className={styles.btnGhost} onClick={onClose}>
                    انصراف
                </button>
                {existing && (
                    <button
                        className={`${styles.btnPrimary} ${styles.btnDanger}`}
                        onClick={remove}
                    >
                        <Trash2 size={15} aria-hidden="true" /> حذف یادآوری
                    </button>
                )}
            </div>

            <p className={styles.hint}>
                یادآوری فقط روی همین دستگاه ذخیره می‌شود و با رسیدن زمان، زنگ هشدار پخش می‌شود.
            </p>
        </AnimatedModal>
    )
}
