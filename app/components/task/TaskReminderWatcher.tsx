"use client"

import { useCallback, useEffect, useRef } from "react"
import { toast } from "react-toastify"
import { useSettings } from "@/app/contexts/SettingsContext"
import { useCalendar } from "@/app/contexts/CalenderContext"
import { api } from "@/app/lib/api/client"
import { formatPersianClock, getLocalReminderParts } from "@/app/lib/reminder"
import { loadReminderFiredKeys, markReminderFired, reminderFiredKey } from "@/app/lib/reminderFired"
import { browserReminderDeliveryDeps, deliverTaskReminder } from "@/app/lib/reminderNotify"

/**
 * پایش یادآوری‌های per-task.
 * ---------------------------------------------------------------
 * محدودیت صریح (بدون Push در حالت تب بسته):
 *   - تب باز: بله (polling هر ۳۰ ثانیه)
 *   - تب بسته / مرورگر بسته / سیستم خواب: خیر (مسیر Web Push جداگانه‌ی سرور)
 *   - مرورگر کاملاً آفلاین: خیر (endpoint سرور لازم است؛ Missed Reconciler جداگانه)
 *
 * ADR-07 فاز ۴-A:
 *   - اعلان OS **فقط** با `ServiceWorkerRegistration.showNotification()` ساخته می‌شود؛
 *     `new Notification(...)` استفاده نمی‌شود (در مرورگرهای موبایل TypeError می‌دهد).
 *   - کلید `${taskId}@${reminderAt}` فقط **پس از نمایش موفق** ثبت می‌شود.
 *   - اگر `showNotification()` خطا بدهد، کلید ثبت نمی‌شود (یادآوری در چرخه‌ی بعدی
 *     دوباره تلاش می‌شود) و فقط یک‌بار در همین session بازخورد درون‌برنامه‌ای داده
 *     می‌شود تا هر ۳۰ ثانیه toast تکراری ساخته نشود.
 *   - namespace کلیدها با Missed Reconciler مشترک است (بدون تکرار غیرضروری).
 */

const CHECK_INTERVAL_MS = 30_000
const NOTIFICATION_TITLE = "یادآور روزساز"

type DueTask = { id: number; title: string; reminderAt: string | null }

export default function TaskReminderWatcher() {
    const { settings, playBeep } = useSettings()
    const { timezone } = useCalendar()
    const busyRef = useRef(false)
    // یادآوری‌هایی که نمایش OS برایشان شکست خورده — فقط برای جلوگیری از اسپم toast
    const degradedRef = useRef<Set<string>>(new Set())

    const check = useCallback(async () => {
        if (busyRef.current) return
        busyRef.current = true
        try {
            const due = await api<DueTask[]>("/api/tasks/reminders")
            for (const task of due) {
                const key = reminderFiredKey(task.id, task.reminderAt)
                if (loadReminderFiredKeys().has(key)) continue

                const parts = getLocalReminderParts(task.reminderAt, timezone)
                const timeLabel = parts ? formatPersianClock(parts.hour, parts.minute) : ""
                const body = timeLabel
                    ? `«${task.title}» — یادآوری ساعت ${timeLabel}`
                    : `«${task.title}» — وقتشه!`

                if (settings.sound) playBeep()

                const outcome = await deliverTaskReminder(
                    {
                        key,
                        taskId: task.id,
                        title: NOTIFICATION_TITLE,
                        body,
                        url: `/dashboard?taskId=${task.id}`,
                        toastText: `⏰ ${body}`,
                    },
                    browserReminderDeliveryDeps({ showToast: (text) => toast.info(text) }),
                )

                if (outcome.shown) {
                    markReminderFired(key)
                    continue
                }

                // نمایش OS شکست خورد → کلید fired ثبت **نمی‌شود**.
                if (!degradedRef.current.has(key)) {
                    degradedRef.current.add(key)
                    toast.info(`⏰ ${body}`)
                }
            }
        } catch {
            /* fail-open — خطای شبکه هرگز رابط کاربری را نمی‌شکند */
        } finally {
            busyRef.current = false
        }
    }, [settings.sound, playBeep, timezone])

    useEffect(() => {
        void check()
        const id = window.setInterval(() => void check(), CHECK_INTERVAL_MS)

        const onVisible = () => {
            if (document.visibilityState === "visible") void check()
        }
        document.addEventListener("visibilitychange", onVisible)
        // بعد از هر mutation برنامه، یادآوری‌های due دوباره بررسی می‌شوند
        window.addEventListener("planner:mutated", onVisible)

        return () => {
            window.clearInterval(id)
            document.removeEventListener("visibilitychange", onVisible)
            window.removeEventListener("planner:mutated", onVisible)
        }
    }, [check])

    return null
}
