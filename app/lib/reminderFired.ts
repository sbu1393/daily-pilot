"use client"

/**
 * ADR-07 فاز ۴-A — namespace مشترک کلیدهای «اجرا شد» برای یادآوری per-task.
 * ---------------------------------------------------------------
 * یک منبع واحد برای همه‌ی مصرف‌کننده‌های سمت کلاینت (watcher و Missed Reconciler)
 * تا Push/watch/reconcile باعث تکرار غیرضروری نشوند.
 *
 * - قالب کلید دست‌نخورده است: `${taskId}@${reminderAt}` (همان چیزی که قبلاً در watcher بود)
 * - کلید storage هم دست‌نخورده است: `dp:task-reminder-fired:v1`
 * - تغییر `reminderAt` یک کلید تازه می‌سازد ⇒ یادآوری جدید یک‌بار اجرا می‌شود
 * - fail-open: در دسترس نبودن/پر بودن localStorage هیچ‌وقت throw نمی‌کند
 */

export const REMINDER_FIRED_STORAGE_KEY = "dp:task-reminder-fired:v1"
export const REMINDER_FIRED_NAMESPACE = "task-reminder"
export const MAX_REMINDER_FIRED_KEYS = 200

export type FiredKeyStorage = {
    getItem: (key: string) => string | null
    setItem: (key: string, value: string) => void
}

/** کلید یکتای «این یادآوریِ این تسک»: `${taskId}@${reminderAt}` */
export function reminderFiredKey(
    taskId: number | string,
    reminderAt: string | null | undefined,
): string {
    return `${taskId}@${reminderAt ?? ""}`
}

function defaultStorage(): FiredKeyStorage | null {
    try {
        if (typeof window === "undefined" || !window.localStorage) return null
        return window.localStorage
    } catch {
        return null
    }
}

/** خواندن کلیدهای ثبت‌شده؛ داده‌ی خراب/غیرآرایه → مجموعه‌ی خالی (بدون throw). */
export function loadReminderFiredKeys(storage?: FiredKeyStorage | null): Set<string> {
    const target = storage === undefined ? defaultStorage() : storage
    if (!target) return new Set()
    try {
        const raw = target.getItem(REMINDER_FIRED_STORAGE_KEY)
        if (!raw) return new Set()
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed)
            ? new Set(parsed.filter((item): item is string => typeof item === "string"))
            : new Set()
    } catch {
        return new Set()
    }
}

function saveReminderFiredKeys(keys: string[], storage: FiredKeyStorage | null) {
    if (!storage) return
    try {
        storage.setItem(
            REMINDER_FIRED_STORAGE_KEY,
            JSON.stringify(keys.slice(-MAX_REMINDER_FIRED_KEYS)),
        )
    } catch {
        /* localStorage در دسترس نیست — بی‌صدا رد می‌شویم */
    }
}

/**
 * ثبت «اجرا شد». خروجی `false` = این کلید از قبل ثبت شده بود (بدون نوشتن دوباره).
 *
 * توجه: وضعیت جاری از storage دوباره خوانده می‌شود (نه از حافظه‌ی caller) تا دو تب
 * به‌سادگی یک یادآوری را دوبار ثبت/نمایش ندهند. این یک کاهش‌دهنده‌ی race در حد
 * امکانات localStorage است، نه یک قفل اتمی.
 */
export function markReminderFired(key: string, storage?: FiredKeyStorage | null): boolean {
    const target = storage === undefined ? defaultStorage() : storage
    const current = loadReminderFiredKeys(target)
    if (current.has(key)) return false
    current.add(key)
    saveReminderFiredKeys(Array.from(current), target)
    return true
}

/** آیا این کلید قبلاً ثبت شده است؟ (خواندن تازه از storage) */
export function isReminderFired(key: string, storage?: FiredKeyStorage | null): boolean {
    return loadReminderFiredKeys(storage).has(key)
}
