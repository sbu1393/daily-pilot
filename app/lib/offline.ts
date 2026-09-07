"use client"

import type { TaskItem } from "@/app/components/task/taskTypes"
import type { DaySummary } from "@/app/hooks/UseDaySummary"

/**
 * لایه‌ی آفلاین Daily Pilot
 * ---------------------------------------------------------------
 * - کش روزها: آخرین تسک‌ها و خلاصه‌ی هر روز در localStorage نگه داشته می‌شود
 *   تا وقتی اینترنت قطع است کاربر داشبورد و تسک‌هایش را ببیند.
 * - صف ایجاد: تسک‌های ساخته‌شده در حالت آفلاین در صف می‌مانند و به‌محض
 *   اتصال مجدد خودکار به سرور ارسال می‌شوند (سینک صعودی).
 * - در حالت آفلاین فیلدهای هوش مصنوعی (اولویت/امتیاز/دلیل/زمان) «—» نشان داده می‌شوند.
 */

const DAY_CACHE = "dp:offline:day:" // + dayKey
const QUEUE_KEY = "dp:offline:queue"

export type QueuedTask = {
    id: string // شناسه محلی موقت
    text: string
    dayKey: string
    createdAt: string
}

export type CachedDay = {
    tasks: TaskItem[]
    summary: DaySummary | null
    savedAt: string
}

/* ---------------- تشخیص وضعیت شبکه ---------------- */

export function isOffline(): boolean {
    return typeof navigator !== "undefined" && navigator.onLine === false
}

export function onOnline(cb: () => void): () => void {
    window.addEventListener("online", cb)
    window.addEventListener("dp:synced", cb)
    return () => {
        window.removeEventListener("online", cb)
        window.removeEventListener("dp:synced", cb)
    }
}

/* ---------------- کش روزها ---------------- */

function safeGet(key: string): string | null {
    try {
        return window.localStorage.getItem(key)
    } catch {
        return null
    }
}

function safeSet(key: string, value: string) {
    try {
        window.localStorage.setItem(key, value)
    } catch {
        /* حافظه پر است یا localStorage غیرفعال است — بی‌صدا رد می‌شویم */
    }
}

export function cacheDay(dayKey: string, tasks: TaskItem[], summary: DaySummary | null) {
    const payload: CachedDay = { tasks, summary, savedAt: new Date().toISOString() }
    safeSet(DAY_CACHE + dayKey, JSON.stringify(payload))
}

export function readCachedDay(dayKey: string): CachedDay | null {
    const raw = safeGet(DAY_CACHE + dayKey)
    if (!raw) return null
    try {
        return JSON.parse(raw) as CachedDay
    } catch {
        return null
    }
}

/* ---------------- صف تسک‌های آفلاین ---------------- */

export function readQueue(): QueuedTask[] {
    const raw = safeGet(QUEUE_KEY)
    if (!raw) return []
    try {
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? (parsed as QueuedTask[]) : []
    } catch {
        return []
    }
}

function writeQueue(queue: QueuedTask[]) {
    safeSet(QUEUE_KEY, JSON.stringify(queue))
}

export function enqueueTask(item: Omit<QueuedTask, "id" | "createdAt">): QueuedTask {
    const queued: QueuedTask = {
        ...item,
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
    }
    writeQueue([...readQueue(), queued])
    return queued
}

export function removeFromQueue(localId: string) {
    writeQueue(readQueue().filter((q) => q.id !== localId))
}

/**
 * سینک صعودی: صف را به ترتیب به سرور می‌فرستد.
 * خروجی: تعداد تسک‌های سینک‌شده.
 */
export async function syncQueue(): Promise<number> {
    if (isOffline()) return 0
    const queue = readQueue()
    let synced = 0

    for (const item of [...queue]) {
        try {
            const res = await fetch("/api/tasks", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text: item.text, dayKey: item.dayKey }),
            })
            if (!res.ok) break // خطای سرور → بعداً دوباره تلاش می‌کنیم
            removeFromQueue(item.id)
            synced += 1
        } catch {
            break // هنوز آفلاین است
        }
    }

    if (synced > 0) {
        window.dispatchEvent(new Event("dp:synced"))
    }
    return synced
}
