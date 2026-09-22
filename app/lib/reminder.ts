/*
 * یادآور روزانه — هسته‌ی خالص (pure core)
 * ---------------------------------------------------------------
 * این ماژول منطق «قابل تست» یادآور را از React جدا می‌کند تا در محیط
 * vitest این پروژه (node، بدون jsdom) قابل آزمون باشد — همان الگویی که
 * AdvisorCard/SettingsContext برای ویومدل‌های خالص به کار می‌برند.
 *
 * چرا اینجا (و نه داخل SettingsContext)؟
 *  - ریاضیات زمان (آستانه/پنجره‌ی جبران) بدون DOM تست می‌شود.
 *  - کلیدهای localStorage به‌صورت user-scoped ساخته می‌شوند (H2).
 *  - نمایش اعلان از طریق Service Worker انجام می‌شود، نه `new Notification()`
 *    (روی Chrome اندروید سازنده‌ی Notification پشتیبانی نمی‌شود).
 *
 * قیدها: بدون Prisma/schema/migration. یادآور کاملاً device-local است؛
 * منبع حقیقت زمان‌بندی، تایمر صفحه است (محدودیت ذاتی وب که در گزارش
 * تحلیل مستند شده است).
 */

/* ---------------- تنظیمات (Settings) ---------------- */

export type ThemePreference = "light" | "dark" | "system"

export type Settings = {
    theme: ThemePreference
    sound: boolean
    reminderEnabled: boolean
    reminderTime: string
}

export const DEFAULT_SETTINGS: Settings = {
    theme: "system",
    sound: true,
    reminderEnabled: false,
    reminderTime: "09:00",
}

/* ---------------- کلیدهای ذخیره‌سازی (user-scoped) ---------------- */

/**
 * کلیدهای نسخه‌ی قبل از H2 که بدون scope بودند. هیچ‌وقت خوانده نمی‌شوند
 * (ممکن است داده‌ی حساب قبلی روی دستگاه مشترک باشند) و هنگام برقراری
 * نشست/خروج پاک می‌شوند.
 */
export const LEGACY_SETTINGS_STORAGE_KEY = "dp:settings"
export const LEGACY_FIRED_STORAGE_KEY = "dp:reminder-fired"

const SETTINGS_PREFIX = "dp:settings"
const FIRED_PREFIX = "dp:reminder-fired"

/**
 * توکن scope: `u<id>` برای کاربر وارد‌شده و `anon` برای بازدیدکننده‌ی ناشناس.
 * (`app/lib/offline.ts` شناسه‌ی کاربر نشست را در `dp:offline:v3:user` نگه می‌دارد؛
 * اسکریپت تم در `app/layout.tsx` همان قاعده را به‌صورت inline تکرار می‌کند چون
 * باید پیش از hydration اجرا شود.)
 */
export function scopeToken(userId: number | null): string {
    return userId != null && Number.isInteger(userId) && userId > 0 ? `u${userId}` : "anon"
}

export function settingsStorageKey(userId: number | null): string {
    return `${SETTINGS_PREFIX}:${scopeToken(userId)}`
}

export function firedStorageKey(userId: number | null): string {
    return `${FIRED_PREFIX}:${scopeToken(userId)}`
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
        /* حافظه پر / localStorage غیرفعال — بی‌صدا رد می‌شویم */
    }
}

function safeRemove(key: string) {
    try {
        window.localStorage.removeItem(key)
    } catch {
        /* ignore */
    }
}

/* ---------------- خواندن/نوشتن تنظیمات ---------------- */

/**
 * خواندن تنظیمات با merge سخت‌گیرانه روی DEFAULT_SETTINGS: هر فیلد نامعتبر
 * (یا JSON خراب) به مقدار پیش‌فرض برمی‌گردد تا داده‌ی قدیمی/دست‌کاری‌شده
 * رفتار یادآور را خراب نکند.
 */
export function readStoredSettings(userId: number | null): Settings {
    const raw = safeGet(settingsStorageKey(userId))
    if (!raw) return DEFAULT_SETTINGS

    try {
        const parsed = JSON.parse(raw) as Partial<Settings>
        const theme = parsed.theme

        return {
            theme:
                theme === "light" || theme === "dark" || theme === "system"
                    ? theme
                    : DEFAULT_SETTINGS.theme,
            sound: typeof parsed.sound === "boolean" ? parsed.sound : DEFAULT_SETTINGS.sound,
            reminderEnabled:
                typeof parsed.reminderEnabled === "boolean"
                    ? parsed.reminderEnabled
                    : DEFAULT_SETTINGS.reminderEnabled,
            reminderTime:
                typeof parsed.reminderTime === "string" && parseReminderHHMM(parsed.reminderTime)
                    ? parsed.reminderTime
                    : DEFAULT_SETTINGS.reminderTime,
        }
    } catch {
        return DEFAULT_SETTINGS
    }
}

export function saveStoredSettings(userId: number | null, settings: Settings): void {
    safeSet(settingsStorageKey(userId), JSON.stringify(settings))
}

export function readFiredKey(userId: number | null): string | null {
    return safeGet(firedStorageKey(userId))
}

export function writeFiredKey(userId: number | null, key: string): void {
    safeSet(firedStorageKey(userId), key)
}

/** حذف کلیدهای بدون scope (H2) — نه خوانده می‌شوند، نه باقی می‌مانند. */
export function clearLegacySettingsKeys(): void {
    safeRemove(LEGACY_SETTINGS_STORAGE_KEY)
    safeRemove(LEGACY_FIRED_STORAGE_KEY)
}

/* ---------------- ریاضیات زمان یادآور ---------------- */

/** فاصله‌ی بررسی دوره‌ای (فقط دقت را تعیین می‌کند، نه امکان فایر شدن). */
export const REMINDER_CHECK_INTERVAL_MS = 20_000

/**
 * پنجره‌ی جبران (catch-up): اگر تایمر به تأخیر بیفتد یا دستگاه خواب برود،
 * یادآور تا این مدت پس از زمان مقرر هنوز قابل فایر شدن است و «نمی‌سوزد»؛
 * فراتر از آن، فایر کردن یک یادآور کهنه (ساعت‌ها بعد) نامطلوب است و
 * بی‌صدا رد می‌شود.
 */
export const REMINDER_GRACE_MS = 2 * 60 * 60 * 1000

/** مقصد کلیک روی اعلان — داشبورد (روز جاری). */
export const REMINDER_TARGET_URL = "/dashboard"

export function parseReminderHHMM(value: string): { hour: number; minute: number } | null {
    const match = /^(\d{1,2}):(\d{1,2})$/.exec((value ?? "").trim())
    if (!match) return null

    const hour = Number(match[1])
    const minute = Number(match[2])
    if (hour > 23 || minute > 59) return null

    return { hour, minute }
}

/** زمان مقرر «امروز» بر مبنای ساعت محلی دستگاه (یا `null` اگر زمان نامعتبر باشد). */
export function reminderTarget(now: Date, reminderTime: string): Date | null {
    const parsed = parseReminderHHMM(reminderTime)
    if (!parsed) return null

    return new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        parsed.hour,
        parsed.minute,
        0,
        0,
    )
}

const pad2 = (n: number) => String(n).padStart(2, "0")

/** کلید روز محلی `YYYY-MM-DD` (نه UTC — عمداً بدون toISOString). */
function localDateKey(date: Date): string {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/**
 * کلید یکتای «این یادآور در این روز»: `<روز محلی>|<HH:MM نرمال‌شده>`.
 * ثبت آن به‌معنی «نمایش داده شد» است، نه «تلاش شد».
 */
export function reminderFireKey(now: Date, reminderTime: string): string {
    const parsed = parseReminderHHMM(reminderTime)
    const stamp = parsed ? `${pad2(parsed.hour)}:${pad2(parsed.minute)}` : reminderTime
    return `${localDateKey(now)}|${stamp}`
}

/**
 * آیا یادآور همین حالا باید فایر شود؟
 * - آستانه‌ای است (`now >= target`) نه تطابق دقیق دقیقه، پس تأخیر تایمر یا
 *   بیدار شدن دیرهنگام دستگاه باعث از دست رفتن یادآور نمی‌شود.
 * - پنجره‌ی جبران (graceMs) از فایر شدن یادآور کهنه جلوگیری می‌کند.
 * - کلید fired این روز → دیگر تکرار نمی‌شود.
 */
export function isReminderDue(args: {
    now: Date
    reminderTime: string
    firedKey: string | null
    graceMs?: number
}): boolean {
    const target = reminderTarget(args.now, args.reminderTime)
    if (!target) return false

    const lateMs = args.now.getTime() - target.getTime()
    if (lateMs < 0) return false
    if (lateMs > (args.graceMs ?? REMINDER_GRACE_MS)) return false

    return args.firedKey !== reminderFireKey(args.now, args.reminderTime)
}

/* ---------------- نمایش اعلان سیستمی ---------------- */

export function canShowNotifications(): boolean {
    if (typeof window === "undefined") return false
    if (!("Notification" in window)) return false

    return Notification.permission === "granted"
}

export type SystemNotificationInput = {
    title: string
    body: string
    url?: string
    tag?: string
}

/** مهلت انتظار برای آماده‌شدن Service Worker (نصب اول/آپدیت). */
export const SW_READY_TIMEOUT_MS = 3_000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), ms)

        promise.then(
            (value) => {
                clearTimeout(timer)
                resolve(value)
            },
            () => {
                clearTimeout(timer)
                resolve(null)
            },
        )
    })
}

/**
 * نمایش اعلان از طریق Service Worker (`registration.showNotification`).
 *
 * چرا نه `new Notification()`؟ روی Chrome اندروید سازنده‌ی Notification
 * پشتیبانی نمی‌شود (`TypeError: Illegal constructor`) و اعلان هرگز دیده
 * نمی‌شود؛ مسیر SW هم روی دسکتاپ و هم روی موبایل کار می‌کند و کلیک آن به
 * `notificationclick` می‌رسد.
 *
 * خروجی `false` یعنی «نمایش داده نشد» — در این حالت یادآور نباید fired ثبت
 * شود تا در بیدارشدن بعدی تب دوباره تلاش شود.
 */
export async function showSystemNotification(input: SystemNotificationInput): Promise<boolean> {
    if (!canShowNotifications()) return false
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return false

    const serviceWorker = navigator.serviceWorker

    let registration: ServiceWorkerRegistration | null = null
    try {
        registration = (await serviceWorker.getRegistration()) ?? null
        if (!registration) registration = await withTimeout(serviceWorker.ready, SW_READY_TIMEOUT_MS)
    } catch {
        return false
    }
    if (!registration) return false // بدون Service Worker راهی برای اعلان در PWA موبایل نیست

    try {
        await registration.showNotification(input.title, {
            body: input.body,
            icon: "/icons/icon-192.png",
            badge: "/icons/icon-192.png",
            lang: "fa",
            dir: "rtl",
            tag: input.tag,
            data: { url: input.url ?? REMINDER_TARGET_URL },
        })
        return true
    } catch {
        return false
    }
}
