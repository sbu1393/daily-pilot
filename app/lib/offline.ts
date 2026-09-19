"use client"

import type { TaskItem } from "@/app/components/task/taskTypes"
import type { DaySummary } from "@/app/hooks/useDaySummary"

/**
 * لایه‌ی آفلاین روزساز
 * ---------------------------------------------------------------
 * - کش روزها: آخرین تسک‌ها و خلاصه‌ی هر روز در localStorage نگه داشته می‌شود
 *   تا وقتی اینترنت قطع است کاربر داشبورد و تسک‌هایش را ببیند.
 * - صف ایجاد: تسک‌های ساخته‌شده در حالت آفلاین در صف می‌مانند و به‌محض
 *   اتصال مجدد خودکار به سرور ارسال می‌شوند (سینک صعودی).
 * - در حالت آفلاین فیلدهای هوش مصنوعی (اولویت/امتیاز/دلیل/زمان) «—» نشان داده می‌شوند.
 *
 * H2/H3 (audit — Phase A1):
 * - **همه‌ی کلیدها user-scoped شده‌اند** (`…:user:<id>:…`) تا داده‌ی یک حساب هرگز
 *   برای حساب دیگری خوانده نشود و صف یک کاربر در حساب کاربر بعدی POST نشود.
 * - scope نشست از localStorage بازیابی می‌شود (نه از شبکه) تا وقتی آفلاین هستیم و
 *   پاسخ `/api/auth/profile` نمی‌رسد، کشِ همان کاربر درست خوانده شود.
 * - `ensureOfflineScope()` کاربر نشست را یک‌بار (وقتی آنلاین هستیم) از `/api/auth/profile`
 *   می‌خواند و در localStorage نگه می‌دارد؛ بنابراین در آفلاین بعدی هم scope شناخته است.
 * - `clearOfflineForLogout()` صف را (بهترین تلاش) سینک و داده‌ی محلی دستگاه را پاک می‌کند.
 * - `syncQueue()` قفل in-flight دارد: تریگرهای موازی (mount / online / dp:synced) هرگز
 *   دو بار یک آیتم را POST نمی‌کنند.
 *
 * قراردادهای V1 دست‌نخورده می‌مانند: فقط Create، فقط {title, scheduledDate}، شناسه‌ی
 * موقت `local-*`، حذف پس از سینک موفق، بدون conflict-resolution و بدون تضمین ترتیب/تحویل.
 */

const CACHE_PREFIX = "dp:offline:v3:day" // v3: کلیدها user-scoped شدند (قبلاً v2 بدون scope)
const QUEUE_PREFIX = "dp:offline:v3:queue" // + :<userId>
const SCOPE_KEY = "dp:offline:v3:user"
// کلیدهای نسخه‌های بدون scope — دیگر هرگز خوانده نمی‌شوند و هنگام برقراری نشست پاک می‌شوند
const LEGACY_PREFIXES = ["dp:offline:v2:day:", "dp:offline:queue"]

export type QueuedTask = {
    id: string // شناسه محلی موقت
    title: string
    dayKey: string // برای نمایش محلی تسک زیر روز درست
    scheduledDate: string // ISO instant نیمه‌شب محلی روز — قرارداد API (C1): سرور dayKey را از آن می‌سازد
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

/* ---------------- localStorage امن ---------------- */

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

function safeRemove(key: string) {
    try {
        window.localStorage.removeItem(key)
    } catch {
        /* ignore */
    }
}

function safeKeys(): string[] {
    try {
        return Object.keys(window.localStorage)
    } catch {
        return []
    }
}

/* ---------------- scope کاربر نشست (H2) ---------------- */

let scopeUserId: number | null | undefined // undefined = هنوز از localStorage خوانده نشده
let scopeInFlight: Promise<number | null> | null = null

/**
 * شناسه‌ی کاربری که کش/صف به او تعلق دارد.
 * اول از حافظه، بعد از localStorage — تا در حالت آفلاین (پیش از رسیدن /api/auth/profile)
 * هم scope درست شناخته شود. بدون scope، هیچ عملیات آفلاینی انجام نمی‌شود.
 */
export function getOfflineUserId(): number | null {
    if (scopeUserId !== undefined) return scopeUserId
    const raw = safeGet(SCOPE_KEY)
    const parsed = raw == null ? Number.NaN : Number(raw)
    scopeUserId = Number.isInteger(parsed) && parsed > 0 ? parsed : null
    return scopeUserId
}

/**
 * ثبت کاربر نشست جاری (H2). `null` = پایان نشست (logout)؛ هم scope و هم
 * کلیدهای نسخه‌ی قدیمیِ بدون scope پاک می‌شوند تا داده‌ی حساب قبلی قابل خواندن نباشد.
 */
export function setOfflineUserId(userId: number | null) {
    scopeUserId = userId
    if (userId == null) {
        safeRemove(SCOPE_KEY)
        return
    }
    safeSet(SCOPE_KEY, String(userId))
    clearLegacyKeys()
}

/**
 * H2 — تعیین scope از نشست سرور (فقط وقتی آنلاین هستیم) و کش کردن آن روی دستگاه.
 * نتیجه‌ی مثبت در localStorage می‌ماند، پس در آفلاین‌های بعدی کش/صف همان کاربر خوانده می‌شود.
 * نتیجه‌ی منفی (401 یا خطای شبکه) کش نمی‌شود تا ورود بعدی دوباره امتحان شود.
 * فراخوانی‌های موازی به همان Promise می‌پیوندند (یک درخواست profile).
 */
export async function ensureOfflineScope(): Promise<number | null> {
    const known = getOfflineUserId()
    if (known != null) return known
    if (isOffline()) return null
    if (scopeInFlight) return scopeInFlight

    scopeInFlight = (async () => {
        try {
            const res = await fetch("/api/auth/profile")
            if (!res.ok) return null
            const body = (await res.json()) as { ok?: boolean; data?: { id?: unknown } }
            const id = body?.data?.id
            if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return null
            setOfflineUserId(id)
            return id
        } catch {
            return null
        }
    })().finally(() => {
        scopeInFlight = null
    })

    return scopeInFlight
}

const dayCacheKey = (userId: number, dayKey: string) => `${CACHE_PREFIX}:${userId}:${dayKey}`
const queueKey = (userId: number) => `${QUEUE_PREFIX}:${userId}`

/* ---------------- کش روزها ---------------- */

export function cacheDay(dayKey: string, tasks: TaskItem[], summary: DaySummary | null) {
    const userId = getOfflineUserId()
    if (userId == null) return // کاربر ناشناس → چیزی ذخیره نمی‌شود (بدون داده‌ی بی‌صاحب)
    const payload: CachedDay = { tasks, summary, savedAt: new Date().toISOString() }
    safeSet(dayCacheKey(userId, dayKey), JSON.stringify(payload))
}

export function readCachedDay(dayKey: string): CachedDay | null {
    const userId = getOfflineUserId()
    if (userId == null) return null // بدون scope، هرگز کشِ کسی خوانده نمی‌شود
    const raw = safeGet(dayCacheKey(userId, dayKey))
    if (!raw) return null
    try {
        return JSON.parse(raw) as CachedDay
    } catch {
        return null
    }
}

/* ---------------- صف تسک‌های آفلاین ---------------- */

export function readQueue(): QueuedTask[] {
    const userId = getOfflineUserId()
    if (userId == null) return []
    const raw = safeGet(queueKey(userId))
    if (!raw) return []
    try {
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? (parsed as QueuedTask[]) : []
    } catch {
        return []
    }
}

function writeQueue(queue: QueuedTask[]) {
    const userId = getOfflineUserId()
    if (userId == null) return
    safeSet(queueKey(userId), JSON.stringify(queue))
}

export function enqueueTask(item: Omit<QueuedTask, "id" | "createdAt">): QueuedTask {
    // H3 — deduplication: ارسال دوباره‌ی همان کار (دابل‌کلیک/ری‌ترای فرم) صف را دو برابر نمی‌کند
    const duplicate = readQueue().find(
        (q) => q.title === item.title && q.scheduledDate === item.scheduledDate,
    )
    if (duplicate) return duplicate

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

/* ---------------- سینک صعودی ---------------- */

// H3 — قفل in-flight: فقط یک سینک همزمان؛ فراخوانی‌های موازی به همان اجرا می‌پیوندند
let syncInFlight: Promise<number> | null = null

export async function syncQueue(): Promise<number> {
    if (syncInFlight) return syncInFlight

    const run = runSync().finally(() => {
        syncInFlight = null
    })
    syncInFlight = run
    return run
}

/**
 * سینک صعودی: صف را به ترتیب به سرور می‌فرستد. خروجی: تعداد تسک‌های سینک‌شده.
 * هر آیتم قبل از POST دوباره در صف بررسی می‌شود تا snapshot کهنه باعث ارسال تکراری نشود.
 */
async function runSync(): Promise<number> {
    if (isOffline()) return 0
    if (getOfflineUserId() == null) return 0 // بدون scope، صف قابل تشخیص نیست

    const snapshot = readQueue()
    let synced = 0

    for (const item of snapshot) {
        // ممکن است در همین حین (توسط اجرای دیگری) سینک/پاک شده باشد
        if (!readQueue().some((q) => q.id === item.id)) continue
        try {
            const res = await fetch("/api/tasks", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ title: item.title, scheduledDate: item.scheduledDate }),
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

/* ---------------- پاک‌سازی محلی (H2) ---------------- */

/**
 * H2 — همه‌ی کش‌های روز (هر کاربری) از این دستگاه پاک می‌شوند؛ کش داده‌ی مشتق‌شده است
 * (منبع حقیقت سرور است) پس پاک کردنش بی‌خطر است و فقط داده‌ی تسکِ کاربر قبلی را از
 * دستگاه برمی‌دارد. صفِ سینک‌نشده‌ی هر کاربر دست‌نخورده می‌ماند (داده‌ی خودِ کاربر است).
 */
function clearAllDayCaches() {
    const prefix = `${CACHE_PREFIX}:`
    for (const key of safeKeys()) {
        if (key.startsWith(prefix)) safeRemove(key)
    }
}

function clearLegacyKeys() {
    for (const key of safeKeys()) {
        if (LEGACY_PREFIXES.some((p) => key.startsWith(p))) safeRemove(key)
    }
}

export type LogoutFlushResult = { synced: number; pending: number }

/**
 * H2 — پایان نشست: اول صف را (بهترین تلاش) سینک می‌کنیم تا کار آفلاینِ کاربر از بین نرود،
 * بعد کش روزها (داده‌ی مشتق‌شده) پاک می‌شود و در نهایت scope پاک می‌شود تا نشست بعدی
 * روی این دستگاه به داده‌ی حساب قبلی دست نزند. باید **قبل** از درخواست logout صدا زده شود
 * تا کوکی نشست هنوز معتبر باشد و سینک بتواند انجام شود.
 *
 * اگر آفلاین باشیم و کاری در صف بماند، آن کار پاک **نمی‌شود** (نابودی داده‌ی کاربر نیست)
 * بلکه فقط برای حساب خودش (user-scoped) نگه داشته می‌شود و در ورود بعدی همان کاربر سینک می‌شود.
 */
export async function clearOfflineForLogout(): Promise<LogoutFlushResult> {
    const userId = getOfflineUserId()
    if (userId == null) return { synced: 0, pending: 0 }

    let synced = 0
    try {
        synced = await syncQueue()
    } catch {
        /* سینک ناموفق → صف دست‌نخورده می‌ماند */
    }

    const pending = readQueue().length

    clearAllDayCaches()
    if (pending === 0) safeRemove(queueKey(userId))
    clearLegacyKeys()
    setOfflineUserId(null)

    return { synced, pending }
}
