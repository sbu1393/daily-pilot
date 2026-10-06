"use client"

import type {
    Channel,
    LocalNotificationSchema,
    LocalNotificationsPlugin,
    PermissionStatus,
    ScheduleWarning,
} from "@capacitor/local-notifications"

/*
 * یادآور محلی نیتیو — لایه‌ی کلاینت (Capacitor Local Notifications)
 * -----------------------------------------------------------------
 * مسئولیت: تشخیص محیط نیتیو، مجوز اعلان، زمان‌بندی و لغو اعلان‌های کاملاً محلی.
 *
 * قواعد:
 * - هیچ وابستگی به دیتابیس/API/Prisma/Auth/Push ندارد؛ این ماژول فقط پوسته‌ی
 *   نیتیو را می‌پیچد تا صفحه‌ها مستقیم با پلاگین Capacitor کار نکنند.
 * - همه‌ی توابع «شکست‌ناپذیر» هستند: هرگز throw نمی‌کنند و خروجی ساختاریافته با
 *   `reason` برمی‌گردانند (هم‌خانواده‌ی `app/lib/pushSubscription.ts`).
 * - ⚠️ خودِ آبجکت پلاگین هرگز مستقیماً از یک تابع `async` برگردانده نمی‌شود.
 *   پروکسی Capacitor برای هر پراپرتی ناشناخته — از جمله `then` — یک تابع
 *   برمی‌گرداند؛ پس اگر خروجی یک تابع async خودِ پلاگین باشد، موتور JS آن را
 *   thenable می‌بیند و `LocalNotifications.then(resolve, reject)` را صدا می‌زند.
 *   نتیجه: پیام `"LocalNotifications.then()" is not implemented on web` به‌صورت
 *   unhandledrejection، معلق‌ماندن همیشگی آن promise و نرسیدن هیچ خطایی به catch.
 *   برای همین هر جا پلاگین از مرز یک promise می‌گذرد، داخل یک آبجکت ساده
 *   بسته‌بندی می‌شود (آبجکت ساده thenable نیست).
 */

/** شناسه‌ی کانال اندروید؛ اعلان‌های یادآور با اهمیت بالا در همین کانال می‌آیند. */
export const LOCAL_REMINDER_CHANNEL_ID = "roozsaz_reminders"

/** کانال پیش‌فرض یادآور (Android 8+ برای نمایش اعلان به کانال نیاز دارد). */
const REMINDER_CHANNEL: Channel = {
    id: LOCAL_REMINDER_CHANNEL_ID,
    name: "یادآور روزساز",
    description: "یادآور کارهای روز — کاملاً محلی و بدون نیاز به اینترنت",
    importance: 5,
    visibility: 1,
    vibration: true,
    lights: true,
    lightColor: "#3b5bdb",
}

/** دلیل شکست — برای تصمیم‌گیری UI، بدون وابستگی به متن خطای نیتیو. */
export type LocalNotificationFailureReason =
    | "NOT_NATIVE" // اجرا داخل پوسته‌ی نیتیو (Capacitor) نیست
    | "PLUGIN_UNAVAILABLE" // پلاگین نیتیو پیدا نشد یا import شکست خورد
    | "PERMISSION_FAILED" // خواندن/درخواست مجوز با خطا برگشت
    | "PERMISSION_PROMPT" // مجوز هنوز گرفته نشده
    | "PERMISSION_DENIED" // کاربر مجوز را رد کرده
    | "SCHEDULE_FAILED"
    | "CANCEL_FAILED"

export type LocalNotificationFailure = {
    ok: false
    reason: LocalNotificationFailureReason
    /** پیام قابل نمایش: متن خطای اصلی یا توضیح کوتاه */
    message: string
}

export type LocalNotificationPermissionOutcome =
    | { ok: true; display: PermissionStatus["display"] }
    | LocalNotificationFailure

export type ScheduleLocalReminderOutcome =
    | { ok: true; id: number; warning?: ScheduleWarning }
    | LocalNotificationFailure

export type CancelLocalReminderOutcome = { ok: true } | LocalNotificationFailure

/** آیا همین حالا داخل پوسته‌ی نیتیو (APK) هستیم؟ */
export function isNativeLocalNotificationPlatform(): boolean {
    if (typeof window === "undefined") return false

    const capacitor = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
        .Capacitor

    return typeof capacitor?.isNativePlatform === "function" && capacitor.isNativePlatform()
}

/**
 * لود تنبل پلاگین. نتیجه داخل یک آبجکت ساده بسته‌بندی می‌شود تا thenable نشود
 * (توضیح کامل در ابتدای فایل).
 */
async function loadLocalNotifications(): Promise<{ LocalNotifications: LocalNotificationsPlugin }> {
    const mod = await import("@capacitor/local-notifications")
    return { LocalNotifications: mod.LocalNotifications }
}

type PluginResolution =
    | { ok: true; plugin: LocalNotificationsPlugin }
    | LocalNotificationFailure

/** پلاگین را برای استفاده برمی‌گرداند، یا دلیل «چرا ممکن نیست» را می‌دهد. */
async function resolvePlugin(): Promise<PluginResolution> {
    if (!isNativeLocalNotificationPlatform()) {
        return {
            ok: false,
            reason: "NOT_NATIVE",
            message: "این صفحه داخل اپ نیتیو اجرا نشده است؛ اعلان محلی فقط در APK کار می‌کند.",
        }
    }

    try {
        const { LocalNotifications } = await loadLocalNotifications()
        return { ok: true, plugin: LocalNotifications }
    } catch (err) {
        return { ok: false, reason: "PLUGIN_UNAVAILABLE", message: describeError(err) }
    }
}

/**
 * مجوز نمایش اعلان را تضمین می‌کند: اگر داده شده باشد همان را برمی‌گرداند،
 * وگرنه یک بار از کاربر می‌پرسد. هرگز throw نمی‌کند.
 */
export async function requestLocalNotificationPermission(): Promise<LocalNotificationPermissionOutcome> {
    const resolved = await resolvePlugin()
    if (!resolved.ok) return resolved

    return ensurePermission(resolved.plugin)
}

/** پیاده‌سازی مشترک مجوز — تا `schedule` یک رفت‌وبرگشت اضافه‌ی نیتیو نداشته باشد. */
async function ensurePermission(
    plugin: LocalNotificationsPlugin,
): Promise<LocalNotificationPermissionOutcome> {
    try {
        const current = await plugin.checkPermissions()
        if (current.display === "granted") return { ok: true, display: current.display }

        const requested = await plugin.requestPermissions()
        if (requested.display === "granted") return { ok: true, display: requested.display }

        return {
            ok: false,
            reason: requested.display === "denied" ? "PERMISSION_DENIED" : "PERMISSION_PROMPT",
            message: `مجوز نمایش اعلان داده نشد (وضعیت: ${requested.display}).`,
        }
    } catch (err) {
        return { ok: false, reason: "PERMISSION_FAILED", message: describeError(err) }
    }
}

export type ScheduleLocalReminderInput = {
    title: string
    body: string
    /** تأخیر نسبت به همین حالا (میلی‌ثانیه). اگر `at` بدهی نادیده گرفته می‌شود. */
    delayMs?: number
    /** لحظه‌ی دقیق اعلان. */
    at?: Date
    /** شناسه‌ی ثابت (اختیاری)؛ پیش‌فرض یک شناسه‌ی تصادفی ۳۲ بیتی است. */
    id?: number
    /**
     * پیش‌فرض `true`. اگر مجوز exact alarm داده نشده باشد، اندروید اعلان را
     * inexact زمان‌بندی می‌کند و نتیجه با `warning` برمی‌گردد (نه خطا).
     */
    exact?: boolean
}

/**
 * یک اعلان محلی زمان‌بندی می‌کند و شناسه‌ی آن را برمی‌گرداند تا بعداً قابل لغو باشد.
 * مجوز را خودش تضمین می‌کند؛ اگر کاربر مجوز ندهد، خروجی `ok: false` است.
 */
export async function scheduleLocalReminder(
    input: ScheduleLocalReminderInput,
): Promise<ScheduleLocalReminderOutcome> {
    const resolved = await resolvePlugin()
    if (!resolved.ok) return resolved

    const { plugin } = resolved

    const permission = await ensurePermission(plugin)
    if (!permission.ok) return permission

    const id = input.id ?? randomNotificationId()
    const at = input.at ?? new Date(Date.now() + (input.delayMs ?? 0))
    const notification: LocalNotificationSchema = {
        id,
        title: input.title,
        body: input.body,
        channelId: LOCAL_REMINDER_CHANNEL_ID,
        isExactNotification: input.exact ?? true,
        schedule: { at, allowWhileIdle: true },
    }

    try {
        // ساخت/به‌روزرسانی کانال idempotent است؛ قبل از زمان‌بندی تضمینش می‌کنیم.
        await plugin.createChannel(REMINDER_CHANNEL)
        const result = await plugin.schedule({ notifications: [notification] })

        return { ok: true, id: result.notifications[0]?.id ?? id, warning: result.warning }
    } catch (err) {
        return { ok: false, reason: "SCHEDULE_FAILED", message: describeError(err) }
    }
}

/** یک اعلان زمان‌بندی‌شده را با شناسه‌اش لغو می‌کند. */
export async function cancelLocalReminder(id: number): Promise<CancelLocalReminderOutcome> {
    const resolved = await resolvePlugin()
    if (!resolved.ok) return resolved

    try {
        await resolved.plugin.cancel({ notifications: [{ id }] })
        return { ok: true }
    } catch (err) {
        return { ok: false, reason: "CANCEL_FAILED", message: describeError(err) }
    }
}

/*
 * ── تشخیص: اعلان‌های pending ──────────────────────────────────────────
 * عمداً یک **خواندنِ صرف** است: نه `schedule` می‌کند، نه `cancel`، نه
 * `createChannel` و نه مجوز می‌خواهد. فقط می‌پرسد «الان چه چیزی در صف
 * سیستم‌عامل ثبت شده است» تا بتوان فهمید یک یادآور واقعاً زمان‌بندی شده یا
 * فقط در state خودِ اپ وجود دارد.
 */

/** یک اعلانِ در انتظار، به شکل قابل نمایش. */
export type PendingLocalReminder = {
    id: number
    title: string
    /** لحظه‌ی trigger؛ `null` یعنی بدون زمان‌بندی (اعلان فوری/تکراری). */
    at: Date | null
}

export type PendingLocalRemindersOutcome =
    | { ok: true; notifications: PendingLocalReminder[]; now: Date }
    | { ok: false; reason: "NOT_NATIVE" | "PLUGIN_UNAVAILABLE" | "PENDING_QUERY_FAILED"; message: string }

/**
 * خواندن فهرست اعلان‌های در انتظار از سیستم‌عامل.
 *
 * از API رسمی `LocalNotifications.getPending()` استفاده می‌کند که دقیقاً
 * همان چیزی را برمی‌گرداند که `schedule()` در سیستم‌عامل ثبت کرده — پس
 * پاسخِ «آیا واقعاً زمان‌بندی شد؟» را بدون هیچ حدسی می‌دهد.
 *
 * هیچ تغییری در وضعیت اعلان‌های موجود نمی‌دهد.
 */
export async function listPendingLocalReminders(): Promise<PendingLocalRemindersOutcome> {
    const resolved = await resolvePlugin()
    if (!resolved.ok) {
        return {
            ok: false,
            reason: resolved.reason === "PLUGIN_UNAVAILABLE" ? "PLUGIN_UNAVAILABLE" : "NOT_NATIVE",
            message: resolved.message,
        }
    }

    try {
        const result = await resolved.plugin.getPending()

        return {
            ok: true,
            now: new Date(),
            notifications: result.notifications.map((notification) => ({
                id: notification.id,
                title: notification.title,
                at: notification.schedule?.at ?? null,
            })),
        }
    } catch (err) {
        return { ok: false, reason: "PENDING_QUERY_FAILED", message: describeError(err) }
    }
}

/** شناسه‌ی امن برای اندروید (شناسه‌ها ۳۲ بیتی علامت‌دار هستند). */
function randomNotificationId(): number {
    return Math.floor(Math.random() * 2_000_000_000)
}

/** متن خطای نیتیو یا خطای غیرمنتظره را به یک پیام خوانا تبدیل می‌کند. */
function describeError(err: unknown): string {
    if (err instanceof Error) return `${err.name}: ${err.message}`
    if (err && typeof err === "object" && "message" in err) {
        return String((err as { message: unknown }).message)
    }
    return String(err)
}
