import { getCanonicalDayKey, shiftCanonicalKey } from "./canonicalDay"
import { faDigits, formatCanonicalToJalali } from "./time"

/**
 * یادآوری تسک‌ها — منطق خالص (بدون React).
 *
 * ⚠️ کاملاً additive: هیچ تغییر اسکیما، migration، API یا state سراسری.
 * داده فقط در localStorage همان مرورگر می‌ماند و «زمان یادآوری» یک مفهوم
 * صرفاً سمت کلاینت است؛ سرور از آن بی‌خبر است (به همین دلیل هیچ route/جدولی
 * لازم نیست و هیچ قرارداد موجودی تغییر نمی‌کند).
 */

export type TaskReminder = {
    taskId: number
    /** عنوان در لحظه‌ی ثبت؛ برای نمایش هشدار حتی اگر بعداً لیست تسک‌ها عوض شود */
    title: string
    /** لحظه‌ی هدف (epoch ms) */
    dueAt: number
    createdAt: number
    /** اگر صدا/هشدار یک‌بار اجرا شده باشد، زمان اجرا؛ در غیر این صورت null */
    firedAt: number | null
}

/** کلید localStorage — هم‌خانواده‌ی «dp:settings» و «dp:reminder-fired» */
export const REMINDER_STORAGE_KEY = "dp:task-reminders"

/** فاصله‌ی بررسی رسیدن زمان یادآوری */
export const REMINDER_TICK_MS = 5_000

/**
 * اگر برنامه هنگام رسیدن زمان بسته/در تب پس‌زمینه بوده، تا این مدت با صدا
 * هشدار می‌دهیم؛ قدیمی‌تر از این، «ازدست‌رفته» تلقی می‌شود و فقط بی‌صدا نمایش
 * داده می‌شود (تا باز کردن فردای برنامه باعث پخش ناگهانی صدا نشود).
 */
export const REMINDER_SOUND_GRACE_MS = 15 * 60 * 1000

/** سقف تعداد یادآوری‌های ذخیره‌شده (محافظ در برابر رشد بی‌نهایت localStorage) */
export const REMINDER_MAX_ITEMS = 100

/** یادآوری‌های اجراشده‌ی قدیمی‌تر از این، در هر بار خواندن پاک می‌شوند */
export const REMINDER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** انتخاب‌های سریع مودال */
export const REMINDER_QUICK_CHOICES: { label: string; minutes: number }[] = [
    { label: "۱۰ دقیقه دیگر", minutes: 10 },
    { label: "۳۰ دقیقه دیگر", minutes: 30 },
    { label: "۱ ساعت دیگر", minutes: 60 },
]

/** حداقلِ منطقی — یادآوری در گذشته پذیرفته نمی‌شود */
export const REMINDER_MIN_LEAD_MS = 30 * 1000

type StorageLike = {
    getItem: (key: string) => string | null
    setItem: (key: string, value: string) => void
}

/* ------------------------------------------------------------------ */
/* اعتبارسنجی و خواندن/نوشتن                                          */
/* ------------------------------------------------------------------ */

function isValidReminder(value: unknown): value is TaskReminder {
    if (typeof value !== "object" || value === null) return false

    const r = value as Record<string, unknown>

    return (
        typeof r.taskId === "number" &&
        Number.isFinite(r.taskId) &&
        typeof r.title === "string" &&
        typeof r.dueAt === "number" &&
        Number.isFinite(r.dueAt) &&
        typeof r.createdAt === "number" &&
        Number.isFinite(r.createdAt) &&
        (r.firedAt === null || (typeof r.firedAt === "number" && Number.isFinite(r.firedAt)))
    )
}

/**
 * پاک‌سازی: یادآوری‌های اجراشده‌ی قدیمی حذف می‌شوند و سقف تعداد اعمال می‌شود.
 * ترتیب خروجی بر اساس زمان هدف (صعودی) است.
 */
export function pruneReminders(
    list: TaskReminder[],
    now: number,
    retentionMs: number = REMINDER_RETENTION_MS,
): TaskReminder[] {
    return list
        .filter((r) => r.firedAt === null || now - (r.firedAt ?? 0) < retentionMs)
        .sort((a, b) => a.dueAt - b.dueAt)
        .slice(0, REMINDER_MAX_ITEMS)
}

/** خواندن امن از localStorage؛ داده‌ی خراب یا ناسازگار بی‌صدا نادیده گرفته می‌شود. */
export function readReminders(storage: StorageLike | null, now: number = Date.now()): TaskReminder[] {
    if (!storage) return []

    try {
        const raw = storage.getItem(REMINDER_STORAGE_KEY)
        if (!raw) return []

        const parsed: unknown = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []

        return pruneReminders(parsed.filter(isValidReminder), now)
    } catch {
        return []
    }
}

/** نوشتن امن؛ اگر localStorage در دسترس/پر باشد، بی‌صدا رد می‌شود. */
export function writeReminders(storage: StorageLike | null, list: TaskReminder[]): void {
    if (!storage) return

    try {
        storage.setItem(REMINDER_STORAGE_KEY, JSON.stringify(list))
    } catch {
        /* حالت خصوصی مرورگر یا سهمیه‌ی پر — یادآوری فقط برای همین نشست می‌ماند */
    }
}

/* ------------------------------------------------------------------ */
/* تغییرات لیست                                                        */
/* ------------------------------------------------------------------ */

/** ثبت/جایگزینی یادآوری یک تسک (هر تسک حداکثر یک یادآوری فعال دارد). */
export function upsertReminder(
    list: TaskReminder[],
    task: { id: number; title: string },
    dueAt: number,
    now: number = Date.now(),
): TaskReminder[] {
    const next: TaskReminder = {
        taskId: task.id,
        title: task.title,
        dueAt,
        createdAt: now,
        firedAt: null,
    }

    return pruneReminders([...list.filter((r) => r.taskId !== task.id), next], now)
}

export function removeReminder(
    list: TaskReminder[],
    taskId: number,
    now: number = Date.now(),
): TaskReminder[] {
    return pruneReminders(
        list.filter((r) => r.taskId !== taskId),
        now,
    )
}

export function findReminder(list: TaskReminder[], taskId: number): TaskReminder | undefined {
    return list.find((r) => r.taskId === taskId)
}

/* ------------------------------------------------------------------ */
/* رسیدن زمان                                                          */
/* ------------------------------------------------------------------ */

export type DueResult = {
    /** لیست به‌روزشده با firedAt برای موارد رسیده */
    list: TaskReminder[]
    /** یادآوری‌هایی که همین حالا برای اولین بار رسیدند */
    newlyFired: TaskReminder[]
    /** آیا هشدار باید با صدا همراه باشد؟ (نه برای موارد خیلی قدیمی) */
    ring: boolean
}

/**
 * یادآوری‌های رسیده که قبلاً اجرا نشده‌اند را «اجراشده» علامت می‌زند.
 * موارد خیلی قدیمی (بیش از REMINDER_SOUND_GRACE_MS) بی‌صدا اجرا می‌شوند.
 */
export function markDueReminders(
    list: TaskReminder[],
    now: number = Date.now(),
    soundGraceMs: number = REMINDER_SOUND_GRACE_MS,
): DueResult {
    const newlyFired: TaskReminder[] = []

    const next = list.map((r) => {
        if (r.firedAt !== null || r.dueAt > now) return r

        const fired = { ...r, firedAt: now }
        newlyFired.push(fired)
        return fired
    })

    const ring = newlyFired.some((r) => now - r.dueAt <= soundGraceMs)

    return { list: next, newlyFired, ring }
}

/* ------------------------------------------------------------------ */
/* نمایش                                                              */
/* ------------------------------------------------------------------ */

const pad = (n: number) => String(n).padStart(2, "0")

/** "YYYY-MM-DDTHH:mm" محلی — فرمت مورد انتظار <input type="datetime-local"> */
export function toDateTimeLocalValue(epochMs: number): string {
    const d = new Date(epochMs)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
        d.getMinutes(),
    )}`
}

/** مقدار datetime-local → epoch ms (زمان محلی مرورگر)؛ نامعتبر → null */
export function fromDateTimeLocalValue(value: string): number | null {
    if (!value) return null

    const ms = new Date(value).getTime()

    return Number.isFinite(ms) ? ms : null
}

/** ساعت HH:mm در timezone داده‌شده (هم‌رویکرد با canonicalDay: Intl + timezone صریح) */
function clockInTimezone(epochMs: number, timezone: string): string {
    const parts = new Intl.DateTimeFormat("en", {
        timeZone: timezone,
        hourCycle: "h23",
        hour: "2-digit",
        minute: "2-digit",
    }).formatToParts(new Date(epochMs))

    const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? "00"

    return `${pick("hour")}:${pick("minute")}`
}

/**
 * برچسب خوانای زمان یادآوری: «امروز ۱۴:۳۰» / «فردا ۰۹:۰۰» / «۱۴۰۵/۰۷/۰۲ ۰۹:۰۰»
 * (تاریخ جلالی فقط برای نمایش است — §6.3.1)
 */
export function formatReminderTime(
    dueAt: number,
    timezone: string,
    now: number = Date.now(),
): string {
    const dueKey = getCanonicalDayKey(new Date(dueAt), timezone)
    const todayKey = getCanonicalDayKey(new Date(now), timezone)
    const clock = faDigits(clockInTimezone(dueAt, timezone))

    if (dueKey === todayKey) return `امروز ${clock}`
    if (dueKey === shiftCanonicalKey(todayKey, 1)) return `فردا ${clock}`
    if (dueKey === shiftCanonicalKey(todayKey, -1)) return `دیروز ${clock}`

    return `${formatCanonicalToJalali(dueKey)} ${clock}`
}

/** فاصله‌ی نسبی فارسی: «۱۲ دقیقه دیگر» / «۲ ساعت دیگر» / «گذشت» */
export function formatReminderRelative(dueAt: number, now: number = Date.now()): string {
    const diff = dueAt - now

    if (diff <= 0) return "گذشت"
    if (diff < 60_000) return "کمتر از یک دقیقه دیگر"

    const minutes = Math.round(diff / 60_000)
    if (minutes < 60) return `${faDigits(minutes)} دقیقه دیگر`

    const hours = Math.round(minutes / 60)
    if (hours < 24) return `${faDigits(hours)} ساعت دیگر`

    return `${faDigits(Math.round(hours / 24))} روز دیگر`
}
