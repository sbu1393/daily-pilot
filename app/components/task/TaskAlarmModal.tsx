"use client"

import { useEffect, useState } from "react"
import { toast } from "react-toastify"
import { AlarmClock, CalendarClock, Trash2 } from "lucide-react"

import AnimatedModal from "../motion/AnimatedModal"
import { useCalendar } from "@/app/contexts/CalenderContext"
import { useTaskAlarms } from "@/app/hooks/useTaskAlarm"
import {
    formatReminderRelative,
    formatReminderTime,
    fromDateTimeLocalValue,
    toDateTimeLocalValue,
} from "@/app/lib/taskReminder"
import {
    TASK_ALARM_DEFAULT_LEAD_MS,
    TASK_ALARM_QUICK_CHOICES,
    TASK_ALARM_SNOOZE_MINUTES,
} from "@/app/lib/taskAlarm"
import { type TaskItem } from "./taskTypes"
import styles from "./task.module.css"
import reminderStyles from "./reminder.module.css"

/*
 * مودال «آلارم تسک» (Feature B).
 *
 * این مودال از مودال یادآوری **جدا** است: یادآوری یک اعلان می‌سازد، آلارم یک
 * زنگ واقعی با صفحه‌ی تمام‌عرض. همین‌جا هم صادقانه گفته می‌شود که آلارم فقط
 * داخل اپ اندروید ثبت می‌شود و اگر مجوزهای لازم داده نشده باشند، دقیقاً کدام
 * مجوز کم است و چطور داده می‌شود.
 */

type Props = {
    task: TaskItem | null
    open: boolean
    onClose: () => void
}

/** پیام شکست ثبت آلارم — هر دلیل پیام خودش را دارد تا UI دروغ نگوید. */
const ALARM_REASON_LABEL: Record<string, string> = {
    NOT_NATIVE: "آلارم واقعی فقط داخل اپ اندروید ثبت می‌شود",
    PLUGIN_UNAVAILABLE: "قابلیت آلارم در این نسخه از اپ نیست؛ اپ را به‌روزرسانی کن",
    IN_THE_PAST: "زمان آلارم باید جلوتر از الآن باشد",
    SCHEDULE_FAILED: "ثبت آلارم در سیستم‌عامل انجام نشد",
    CANCEL_FAILED: "لغو آلارم ناموفق بود",
    CALL_FAILED: "ارتباط با سرویس آلارم ناموفق بود",
}

export default function TaskAlarmModal({ task, open, onClose }: Props) {
    const { timezone } = useCalendar()
    const {
        ready,
        getAlarm,
        setAlarm,
        removeAlarm,
        nativePlatform,
        bridgeAvailable,
        nativeStatus,
        requestExactPermission,
        requestFullScreenPermission,
        requestNotificationPermission,
    } = useTaskAlarms()

    const [value, setValue] = useState("")

    const existing = task ? getAlarm(task.id) : undefined

    useEffect(() => {
        if (!open || !task) return
        setValue(toDateTimeLocalValue(existing?.at ?? Date.now() + TASK_ALARM_DEFAULT_LEAD_MS))
    }, [open, task, existing?.at])

    if (!task) return null

    const at = fromDateTimeLocalValue(value)
    const now = Date.now()
    const isNative = nativePlatform === true

    const applyQuickChoice = (minutes: number) => {
        setValue(toDateTimeLocalValue(Date.now() + minutes * 60_000))
    }

    const submit = async () => {
        if (at == null) {
            toast.error("زمان آلارم را انتخاب کن")
            return
        }

        const result = await setAlarm({ id: task.id, title: task.title }, at)
        if (!result.ok) {
            toast.error(ALARM_REASON_LABEL[result.reason] ?? "ثبت آلارم ناموفق بود")
            return
        }

        if (result.exact === false) {
            /* صادقانه: ثبت شد، ولی مسیر غیردقیق. هیچ ادعای دقتی نمی‌کنیم. */
            toast.warn(
                "آلارم ثبت شد ولی اجازه‌ی «آلارم دقیق» داده نشده؛ ممکن است چند دقیقه دیرتر زنگ بزند.",
            )
        } else {
            toast.success(`آلارم برای «${task.title}» ثبت شد ⏰`)
        }

        onClose()
    }

    const remove = async () => {
        const result = await removeAlarm(task.id)

        if (!result.ok) {
            toast.error(ALARM_REASON_LABEL[result.reason] ?? "حذف آلارم ناموفق بود")
            return
        }

        toast.info("آلارم حذف شد")
        onClose()
    }

    const grant = async (
        request: () => Promise<{ ok: boolean }>,
        successMessage: string,
    ) => {
        const result = await request()
        if (result.ok) toast.info(successMessage)
        else toast.error("باز کردن تنظیمات ممکن نشد")
    }

    return (
        <AnimatedModal open={open} onClose={onClose}>
            <div className={styles.modalHead}>
                <h4>آلارم تسک</h4>
                <button className={styles.closeBtn} onClick={onClose} aria-label="بستن">
                    ✕
                </button>
            </div>

            <p className={styles.taskTitle}>«{task.title}»</p>

            {/* آلارم فعال (اگر وجود دارد) */}
            {existing && (
                <div className={reminderStyles.activeBox}>
                    <span className={reminderStyles.activeIcon} aria-hidden="true">
                        <AlarmClock size={18} />
                    </span>
                    <div className={reminderStyles.activeText}>
                        <b>آلارم فعال</b>
                        <span>
                            {formatReminderTime(existing.at, timezone, now)}
                            {" · "}
                            {formatReminderRelative(existing.at, now)}
                        </span>
                    </div>
                </div>
            )}

            {/* ── صداقت درباره‌ی محیط و مجوزها ────────────────────────── */}
            {nativePlatform === false && (
                <div className={reminderStyles.activeBox}>
                    <div className={reminderStyles.activeText}>
                        <b>آلارم واقعی در مرورگر ممکن نیست</b>
                        <span>
                            آلارم با صدای بلند و صفحه‌ی تمام‌عرض فقط داخل اپ اندروید ثبت می‌شود. برای
                            یادآوری در مرورگر از «تنظیم زمان» استفاده کن.
                        </span>
                    </div>
                </div>
            )}

            {isNative && !bridgeAvailable && (
                <div className={reminderStyles.activeBox}>
                    <div className={reminderStyles.activeText}>
                        <b>قابلیت آلارم در این نسخه نیست</b>
                        <span>پلاگین آلارم در این نسخه از اپ ثبت نشده است؛ اپ را به‌روزرسانی کن.</span>
                    </div>
                </div>
            )}

            {isNative && nativeStatus != null && !nativeStatus.notifications && (
                <div className={reminderStyles.activeBox}>
                    <div className={reminderStyles.activeText}>
                        <b>اجازه‌ی اعلان داده نشده</b>
                        <span>بدون این اجازه، آلارم بی‌خبر می‌ماند.</span>
                    </div>
                    <button
                        type="button"
                        className={reminderStyles.quickChip}
                        onClick={() =>
                            void grant(requestNotificationPermission, "پنجره‌ی اجازه‌ی اعلان باز شد")
                        }
                    >
                        دادن اجازه
                    </button>
                </div>
            )}

            {isNative && nativeStatus != null && !nativeStatus.exactAlarm && (
                <div className={reminderStyles.activeBox}>
                    <div className={reminderStyles.activeText}>
                        <b>اجازه‌ی «آلارم دقیق» داده نشده</b>
                        <span>
                            بدون آن، اندروید می‌تواند آلارم را چند دقیقه دیرتر برساند (آلارم ثبت می‌شود
                            ولی دقیق نیست).
                        </span>
                    </div>
                    <button
                        type="button"
                        className={reminderStyles.quickChip}
                        onClick={() =>
                            void grant(requestExactPermission, "صفحه‌ی آلارم‌های دقیق باز شد")
                        }
                    >
                        دادن اجازه
                    </button>
                </div>
            )}

            {isNative && nativeStatus != null && !nativeStatus.fullScreenIntent && (
                <div className={reminderStyles.activeBox}>
                    <div className={reminderStyles.activeText}>
                        <b>نمایش تمام‌صفحه اجازه ندارد</b>
                        <span>
                            آلارم زنگ می‌زند و اعلان برجسته نشان داده می‌شود، ولی صفحه‌ی تمام‌عرض
                            خودکار باز نمی‌شود.
                        </span>
                    </div>
                    <button
                        type="button"
                        className={reminderStyles.quickChip}
                        onClick={() =>
                            void grant(requestFullScreenPermission, "صفحه‌ی مجوز تمام‌صفحه باز شد")
                        }
                    >
                        دادن اجازه
                    </button>
                </div>
            )}

            {/* ── انتخاب زمان ─────────────────────────────────────────── */}
            <label className={reminderStyles.fieldLabel} htmlFor="dp-alarm-at">
                <CalendarClock size={16} aria-hidden="true" /> زمان و تاریخ آلارم
            </label>
            <input
                id="dp-alarm-at"
                className={reminderStyles.dateInput}
                type="datetime-local"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                disabled={!ready}
            />

            <div className={reminderStyles.quickRow}>
                {TASK_ALARM_QUICK_CHOICES.map((choice) => (
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

            <p className={reminderStyles.preview}>
                {at == null ? (
                    <span className={reminderStyles.previewEmpty}>زمانی انتخاب نشده است</span>
                ) : at <= now ? (
                    <span className={reminderStyles.previewWarn}>⚠️ این زمان گذشته است</span>
                ) : (
                    <>
                        ⏰ {formatReminderTime(at, timezone, now)}
                        {" · "}
                        {formatReminderRelative(at, now)}
                    </>
                )}
            </p>

            <div className={styles.modalActions}>
                <button className={styles.btnPrimary} onClick={submit} disabled={!ready}>
                    ثبت آلارم
                </button>
                <button className={styles.btnGhost} onClick={onClose}>
                    انصراف
                </button>
                {existing && (
                    <button
                        className={`${styles.btnPrimary} ${styles.btnDanger}`}
                        onClick={() => void remove()}
                    >
                        <Trash2 size={15} aria-hidden="true" /> حذف آلارم
                    </button>
                )}
            </div>

            <p className={styles.hint}>
                با رسیدن این زمان، حتی اگر اپ بسته باشد، صدای آلارم پخش می‌شود و صفحه‌ای با نام کار و
                دکمه‌های «توقف» و «تعویق {TASK_ALARM_SNOOZE_MINUTES} دقیقه» باز می‌شود.
            </p>
        </AnimatedModal>
    )
}
