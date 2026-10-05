"use client"

import type { ScheduleWarning } from "@capacitor/local-notifications"

import { reminderTarget, scopeToken } from "@/app/lib/reminder"
import {
    cancelLocalReminder,
    scheduleLocalReminder,
    type LocalNotificationFailureReason,
} from "@/app/lib/native/local-notifications"

/*
 * یادآور روزانه‌ی نیتیو (Android) — wrapper روی `local-notifications.ts`
 * -----------------------------------------------------------------
 * مسئولیت: تبدیل تنظیمات روزانه (`HH:MM`) به یک اعلان محلی زمان‌بندی‌شده.
 *
 * این wrapper عمداً هیچ‌چیز درباره‌ی Web Push، سرور یا Prisma نمی‌داند — مسیر
 * مرورگر (Service Worker + Web Push + cron) کاملاً دست‌نخورده باقی می‌ماند و
 * فقط همین مسیر است که روی Android native جایگزین می‌شود.
 *
 * قواعد:
 * - Pure: محاسبه‌ی زمان و شناسه هیچ دسترسی به `window`/Capacitor ندارد.
 * - همه‌ی توابع «شکست‌ناپذیر» هستند و خروجی ساختاریافته با `reason` می‌دهند.
 * - هیچ `SSR` دسترسی: فراخوانی‌ها فقط از چرخه‌ی عمر کلاینت می‌آیند.
 */

/** دلیل شکست — `INVALID_TIME` از این wrapper می‌آید، بقیه از لایه‌ی نیتیو. */
export type DailyReminderFailureReason = "INVALID_TIME" | LocalNotificationFailureReason

export type DailyReminderScheduleOutcome =
    | { ok: true; id: number; at: Date; warning?: ScheduleWarning }
    | { ok: false; reason: DailyReminderFailureReason; message: string }

export type DailyReminderCancelOutcome =
    | { ok: true }
    | { ok: false; reason: DailyReminderFailureReason; message: string }

/** سقف شناسه — زیر `2^31-1` (بیشینه‌ی int32 علامت‌دار اندروید) می‌مانیم. */
const MAX_NOTIFICATION_ID = 2_000_000_000

/**
 * هش صحیحِ قطعی (djb2 روی ۳۲ بیت) — pure و بدون وابستگی.
 * برای ما فقط یک نگاشت یک‌به‌یکِ «کلید متنی ← عدد» لازم است، نه یک هش
 * رمزنگاری؛ پس استفاده از الگوریتم استاندارد کتابخانه‌ای لازم نیست.
 */
function stableIntHash(value: string): number {
    let hash = 5381

    for (let index = 0; index < value.length; index += 1) {
        // hash * 33 + code، در محدوده‌ی int32
        hash = (((hash << 5) + hash + value.charCodeAt(index)) | 0)
    }

    return hash >>> 0
}

/**
 * شناسه‌ی پایدار اعلان یادآور روزانه برای این scope.
 *
 * چرا به `dayKey` وابسته نیست؟ چون reminder روزانه است و در هر لحظه حداکثر یک
 * اعلان فعال دارد. با یک شناسه‌ی ثابت برای هر کاربر:
 *  - زمان‌بندی دوباره، اعلان قبلی را **جایگزین** می‌کند (id در اندروید کلید یکتا
 *    است) ⇒ هیچ‌وقت اعلان تکراری ساخته نمی‌شود؛
 *  - لغو کردن نیازی به «به‌خاطر سپردنِ» زمان قبلی ندارد — همین تابع دوباره
 *    حساب می‌شود؛
 *  - بعد از ری‌استارت اپ یا تغییر ساعت، همان id قابل بازیابی است.
 *
 * نتیجه در بازه‌ی `1 … 2_000_000_000` است (نه صفر، چون صفر رزرو نشده).
 */
export function dailyReminderNotificationId(userId: number | null): number {
    const key = `daily-reminder:${scopeToken(userId)}`

    return 1 + (stableIntHash(key) % MAX_NOTIFICATION_ID)
}

/**
 * لحظه‌ی بعدی که یادآور باید اجرا شود.
 *
 * از `reminderTarget` موجود در `app/lib/reminder.ts` استفاده می‌کند تا رفتار
 * «ساعت محلی دستگاه» یکسان بماند و ریاضیات زمان دوباره اختراع نشود.
 * اگر ساعت امروز گذشته باشد → فردا، همان روز.
 */
export function nextDailyReminderAt(now: Date, reminderTime: string): Date | null {
    const today = reminderTarget(now, reminderTime)
    if (!today) return null

    if (today.getTime() > now.getTime()) return today

    // فردا را با ساخت صریح «نیمه‌شب فردا» می‌سازیم (نه +۲۴ ساعت) تا در روزهای
    // تغییر ساعت تابستانی، ساعت نهایی جابه‌جا نشود.
    const startOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)

    return reminderTarget(startOfTomorrow, reminderTime)
}

/*
 * ترتیب فراخوانی‌های نیتیو
 * ------------------------
 * `schedule` و `cancel` هر دو از پل نیتیو عبور می‌کنند و ترتیبِ رسیدنشان به
 * سیستم‌عامل تضمین‌شده نیست. در چرخه‌ی عمر React، cleanup یک effect **قبل** از
 * اجرای effect بعدی اجرا می‌شود؛ پس بدون صف، ممکن است `cancel` بعد از `schedule`
 * بنشیند و اعلان تازه‌ساخته را لغو کند.
 *
 * این صف فقط در کلاینت وجود دارد و هیچ state ای ندارد؛ کارش فقط سریال‌کردن
 * عملیات نیتیو است.
 */
let nativeQueue: Promise<unknown> = Promise.resolve()

function enqueueNative<T>(task: () => Promise<T>): Promise<T> {
    // اگر کار قبلی رد شده بود، این یکی هم باید اجرا شود (`onRejected` همان task است).
    const result = nativeQueue.then(task, task)

    nativeQueue = result.then(
        () => undefined,
        () => undefined,
    )

    return result
}

function toFailure(
    reason: DailyReminderFailureReason,
    message: string,
): { ok: false; reason: DailyReminderFailureReason; message: string } {
    return { ok: false, reason, message }
}

/**
 * زمان‌بندی یادآور روزانه روی دستگاه نیتیو.
 * اگر قبلاً با همین شناسه زمان‌بندی شده باشد، جایگزینش می‌شود (idempotent).
 */
export async function scheduleDailyReminder(input: {
    userId: number | null
    reminderTime: string
}): Promise<DailyReminderScheduleOutcome> {
    const at = nextDailyReminderAt(new Date(), input.reminderTime)
    if (!at) {
        return toFailure("INVALID_TIME", "ساعت یادآور معتبر نیست؛ اعلانی زمان‌بندی نشد.")
    }

    return enqueueNative(async () => {
        const result = await scheduleLocalReminder({
            title: "یادآور روزساز",
            body: "وقت برنامه‌ریزی روزت رسیده است ✨",
            id: dailyReminderNotificationId(input.userId),
            at,
        })

        if (!result.ok) return result

        return { ok: true, id: result.id, at, warning: result.warning }
    })
}

/**
 * لغو یادآور روزانه‌ی این scope.
 * چون شناسه از scope مشتق می‌شود، همین تابع هم در `disable` و هم در تغییر ساعت
 * و هم در تعویض کاربر (خروج/ورود) قابل استفاده است — بدون هیچ state ای.
 */
export async function cancelDailyReminder(userId: number | null): Promise<DailyReminderCancelOutcome> {
    const id = dailyReminderNotificationId(userId)

    return enqueueNative(async () => {
        const result = await cancelLocalReminder(id)

        if (!result.ok) return result

        return { ok: true as const }
    })
}