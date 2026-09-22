"use client"

import { useCallback, useEffect, useRef } from "react"
import { toast } from "react-toastify"
import { ensureOfflineScope, readAllCachedDays } from "@/app/lib/offline"
import { loadReminderFiredKeys, markReminderFired } from "@/app/lib/reminderFired"
import { findMissedReminders, MAX_MISSED_TOASTS } from "@/app/lib/reminderMissed"
import { useCalendar } from "@/app/contexts/CalenderContext"
import { formatPersianClock, getLocalReminderParts } from "@/app/lib/reminder"
import { faDigits } from "@/app/lib/time"

/**
 * ADR-07 فاز ۴-A — Missed-Reminder Reconciler (fallback محلی، **نه alarm**).
 * ---------------------------------------------------------------
 * این کامپوننت فقط کاری را انجام می‌دهد که در pure PWA واقعاً قابل اتکاست:
 * هنگام باز شدن دوباره‌ی برنامه، یادآوری‌های **ازدست‌رفته** را از کش محلی پیدا
 * می‌کند و **درون برنامه** (toast) گزارش می‌دهد.
 *
 * صریحاً این‌ها را انجام **نمی‌دهد**:
 *   - اعلان OS نمی‌سازد (تا با مسیر Push/Web Notification تداخل نکند)
 *   - alarm/زمان‌بندی نیست؛ با تب بسته یا دستگاه کاملاً آفلاین چیزی اجرا نمی‌شود
 *   - IndexedDB/Background Sync/Periodic Sync ندارد
 *   - API جدید صدا نمی‌زند و منتظر شبکه نمی‌ماند (منبع داده کاملاً محلی است)
 *
 * داده: همان `TaskItem.reminderAt` در کش‌های `dp:offline:v3:day:*` همین کاربر.
 * اگر روزی کش نشده باشد، هیچ چیزی حدس زده نمی‌شود.
 */

export default function MissedReminderReconciler() {
    const { timezone } = useCalendar()
    const busyRef = useRef(false)

    const reconcile = useCallback(async () => {
        if (busyRef.current) return
        busyRef.current = true
        try {
            // scope نشست (در آفلاین از localStorage خوانده می‌شود) — بدون داده‌ی حساب دیگر
            await ensureOfflineScope().catch(() => null)

            const tasks = readAllCachedDays().flatMap((day) => day.tasks ?? [])
            if (tasks.length === 0) return

            const missed = findMissedReminders(tasks, new Date(), {
                fired: loadReminderFiredKeys(),
            })
            if (missed.length === 0) return

            const toReport = missed.slice(0, MAX_MISSED_TOASTS)

            for (const item of toReport) {
                // خواندن تازه پیش از نمایش: دو تب به‌سادگی یک مورد را دوبار نشان ندهند
                if (loadReminderFiredKeys().has(item.key)) continue

                const parts = getLocalReminderParts(item.reminderAt, timezone)
                const timeLabel = parts ? formatPersianClock(parts.hour, parts.minute) : ""
                toast.info(
                    timeLabel
                        ? `⏰ یادآوری ازدست‌رفته: «${item.title}» — ساعت ${timeLabel}`
                        : `⏰ یادآوری ازدست‌رفته: «${item.title}»`,
                )
                markReminderFired(item.key)
            }

            const remaining = missed.length - toReport.length
            if (remaining > 0) {
                toast.info(`⏰ و ${faDigits(remaining)} یادآوری ازدست‌رفته‌ی دیگر`)
                // بقیه هم گزارش شده‌اند → ثبت می‌شوند تا در باز شدن بعدی تکرار نشوند
                for (const item of missed.slice(MAX_MISSED_TOASTS)) markReminderFired(item.key)
            }
        } catch {
            /* fail-open — reconciliation هرگز رابط کاربری را نمی‌شکند */
        } finally {
            busyRef.current = false
        }
    }, [timezone])

    useEffect(() => {
        void reconcile()

        const onVisible = () => {
            if (document.visibilityState === "visible") void reconcile()
        }
        document.addEventListener("visibilitychange", onVisible)

        return () => document.removeEventListener("visibilitychange", onVisible)
    }, [reconcile])

    return null
}
