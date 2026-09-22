"use client"

import { reminderFiredKey } from "@/app/lib/reminderFired"

/**
 * ADR-07 فاز ۴-A — Missed-Reminder Reconciler (منطق خالص، بدون storage/UI).
 * ---------------------------------------------------------------
 * این یک **fallback محلی** است، نه alarm:
 *   - مرورگر اجازه‌ی اجرای زمان‌بندی‌شده در حالت بسته را نمی‌دهد؛ پس در حالت
 *     «کاملاً آفلاین + اپ بسته» هیچ یادآوری‌ای اجرا نمی‌شود.
 *   - کاری که واقعاً قابل اتکاست، بازیابی یادآوری‌های **ازدست‌رفته** در لحظه‌ی
 *     باز شدن دوباره‌ی برنامه است (همان چیزی که در کد موجود، watcher نمی‌بیند
 *     چون تنها بازه‌ی محدود «due» را از سرور می‌گیرد).
 *
 * قرارداد:
 *   - منبع داده: همان `TaskItem.reminderAt` که از قبل در کش روز (`dp:offline:v3:day:*`) هست.
 *   - `reminderAt <= now` و داخل پنجره‌ی missed (پیش‌فرض ۲۴ ساعت — هم‌معنا با پنجره‌ی stale سرور).
 *   - future هرگز؛ DONE هرگز؛ بدون `reminderAt` هرگز؛ کلید تکراری هرگز.
 *   - هیچ حدس/داده‌ی ساختگی: تنها چیزی که در کش هست بررسی می‌شود.
 */

export const MISSED_REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000 // ۲۴ ساعت
export const MAX_MISSED_TOASTS = 3

/** حداقل فیلدهای لازم از Task (سازگار با `TaskItem`). */
export type ReminderSourceTask = {
    id: number
    title: string
    status: string
    reminderAt: string | null
}

export type MissedReminder = {
    taskId: number
    title: string
    reminderAt: string
    key: string
}

export type FindMissedRemindersOptions = {
    windowMs?: number
    fired?: ReadonlySet<string>
    limit?: number
}

/**
 * یادآوری‌های ازدست‌رفته را به ترتیب زمان (قدیمی‌تر اول) برمی‌گرداند.
 * مرز پنجره **شامل** است (`now - reminderAt === windowMs` ⇒ داخل)، هم‌معنا با سرور.
 */
export function findMissedReminders(
    tasks: readonly ReminderSourceTask[],
    now: Date,
    options?: FindMissedRemindersOptions,
): MissedReminder[] {
    const windowMs = options?.windowMs ?? MISSED_REMINDER_WINDOW_MS
    const fired = options?.fired
    const nowMs = now.getTime()
    const seen = new Set<string>()
    const found: MissedReminder[] = []

    for (const task of tasks) {
        if (!task || task.status === "DONE") continue
        if (!task.reminderAt) continue

        const at = new Date(task.reminderAt).getTime()
        if (Number.isNaN(at)) continue
        if (at > nowMs) continue // future → هرگز
        if (nowMs - at > windowMs) continue // خارج پنجره → هرگز

        const key = reminderFiredKey(task.id, task.reminderAt)
        if (fired?.has(key)) continue
        if (seen.has(key)) continue // همان تسک ممکن است در چند کش روز باشد

        seen.add(key)
        found.push({ taskId: task.id, title: task.title, reminderAt: task.reminderAt, key })
    }

    found.sort((a, b) =>
        a.reminderAt === b.reminderAt ? a.taskId - b.taskId : a.reminderAt < b.reminderAt ? -1 : 1,
    )

    return options?.limit != null ? found.slice(0, options.limit) : found
}
