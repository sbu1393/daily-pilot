"use client"

import { AnimatePresence, motion } from "framer-motion"
import { BellOff, BellRing, Timer } from "lucide-react"
import { faDigits } from "@/app/lib/time"
import { formatReminderTime, type TaskReminder } from "@/app/lib/taskReminder"
import reminderStyles from "./reminder.module.css"

type Props = {
    alarms: TaskReminder[]
    timezone: string
    onDismiss: (taskId?: number) => void
    onSnooze: (alarm: TaskReminder, minutes: number) => void
}

const SNOOZE_MINUTES = 10

/**
 * بنر آلارم — «🔔 زمان انجام تسک: [عنوان] فرا رسید!»
 *
 * لایه‌ی ثابت روی کل صفحه است تا روی هر صفحه‌ای که کاربر باشد دیده شود.
 * خودِ لایه `pointer-events: none` است و فقط کارت‌های آلارم کلیک می‌گیرند؛
 * پس وقتی آلارمی نیست، هیچ‌چیزی را در UI بلاک نمی‌کند.
 */
export default function ReminderAlarmBanner({ alarms, timezone, onDismiss, onSnooze }: Props) {
    return (
        <div className={reminderStyles.alarmLayer}>
            <AnimatePresence initial={false}>
                {alarms.map((alarm) => (
                    <motion.div
                        key={alarm.taskId}
                        className={reminderStyles.alarm}
                        role="alert"
                        initial={{ opacity: 0, y: -18, scale: 0.97 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -18, scale: 0.97 }}
                        transition={{ type: "spring", stiffness: 360, damping: 28 }}
                    >
                        <span className={reminderStyles.alarmBell} aria-hidden="true">
                            <BellRing />
                        </span>

                        <div className={reminderStyles.alarmBody}>
                            <p className={reminderStyles.alarmText}>
                                🔔 زمان انجام تسک: «{alarm.title}» فرا رسید!
                            </p>
                            <p className={reminderStyles.alarmMeta}>
                                زمان یادآوری:{" "}
                                {/* مرجع «الان» = لحظه‌ی اجرا؛ نه Date.now() در رندر (پایدار و بدون لرزش) */}
                                {formatReminderTime(alarm.dueAt, timezone, alarm.firedAt ?? alarm.dueAt)}
                            </p>
                        </div>

                        <div className={reminderStyles.alarmActions}>
                            <button
                                type="button"
                                className={reminderStyles.alarmStop}
                                onClick={() => onDismiss(alarm.taskId)}
                            >
                                <BellOff size={16} aria-hidden="true" />
                                قطع صدا
                            </button>
                            <button
                                type="button"
                                className={reminderStyles.alarmSnooze}
                                onClick={() => onSnooze(alarm, SNOOZE_MINUTES)}
                            >
                                <Timer size={16} aria-hidden="true" />
                                {faDigits(SNOOZE_MINUTES)} دقیقه دیگر
                            </button>
                        </div>
                    </motion.div>
                ))}
            </AnimatePresence>
        </div>
    )
}
