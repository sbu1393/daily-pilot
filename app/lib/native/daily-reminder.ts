"use client"

import type { ScheduleWarning } from "@capacitor/local-notifications"

import { reminderTarget, scopeToken } from "@/app/lib/reminder"
import { enqueueNative, stableNotificationId } from "@/app/lib/native/primitives"
import {
    cancelLocalReminder,
    scheduleLocalReminder,
    type LocalNotificationFailure,
    type LocalNotificationFailureReason,
    type LocalNotificationPermissionOutcome,
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
    return stableNotificationId(`daily-reminder:${scopeToken(userId)}`)
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

/* ------------------------------------------------------------------ */
/* روشن‌کردن یادآور روی نیتیو — ترتیب، بخشی از قرارداد است           */
/* ------------------------------------------------------------------ */

/**
 * آیا دو لحظه در یک روزِ تقویمیِ محلی هستند؟
 *
 * عمداً به‌جای اختلاف میلی‌ثانیه از مقایسه‌ی اجزای تاریخ استفاده می‌شود:
 * «فرداِ همان ساعت» دقیقاً ۲۴ ساعت بعد است، پس آستانه‌ی زمانی مرز را مبهم
 * می‌کند (و در روزهای DST اصلاً جابه‌جا می‌شود). مقایسه‌ی روز، قطعی است.
 */
export function isSameLocalDay(at: Date, reference: Date): boolean {
    return (
        at.getFullYear() === reference.getFullYear() &&
        at.getMonth() === reference.getMonth() &&
        at.getDate() === reference.getDate()
    )
}

/**
 * آیا ساعت انتخابی هنوز در همین روز جلو است؟
 *
 * `nextDailyReminderAt` عمداً همیشه لحظه‌ای *در آینده* برمی‌گرداند، پس اگر
 * کاربر ساعتِ همین دقیقه را انتخاب کند (مثلاً ۱۴:۳۴ در ساعت ۱۴:۳۴:۱۰) هدف به
 * فردا می‌افتد. این رفتار غلط نیست — اما اگر بی‌صدا بماند، کاربر فکر می‌کند
 * اعلان نیامده. بنابراین ریاضیات زمان دست‌نخورده می‌ماند و فقط *تشخیص*
 * این حالت جدا می‌شود تا رابط کاربری بتواند صادقانه توضیح دهد.
 */
export function isDailyReminderLaterToday(now: Date, reminderTime: string): boolean {
    const at = nextDailyReminderAt(now, reminderTime)
    if (!at) return false

    return isSameLocalDay(at, now)
}

export type NativeDailyReminderEnableOutcome = { ok: true } | LocalNotificationFailure

/**
 * روشن‌کردن یادآور روزانه روی Android native — با ترتیب تضمین‌شده.
 *
 * چرا این تابع وجود دارد؟ اگر `reminderEnabled` قبل از آماده‌شدن مجوز `true`
 * شود، effect نیتیو بلافاصله اجرا می‌شود، `ensurePermission()` هنوز
 * `prompt` می‌بیند و **پیش از رسیدن به `plugin.schedule()`** برمی‌گردد؛ آن
 * خطا هم بی‌صدا دور ریخته می‌شد و در نتیجه هیچ آلارمی ساخته نمی‌شد — بدون
 * اینکه هیچ‌وقت دوباره تلاش شود. این تابع ترتیب را بخشی از قرارداد می‌کند:
 * مجوز اول، فعال‌سازی بعد.
 *
 * زمان‌بندی خودش انجام نمی‌شود؛ آن کارِ `scheduleDailyReminder` در
 * `SettingsContext` است تا شناسه‌ی اعلان از یک جا (scope نشست) بیاید و
 * schedule/cancel هرگز روی دو شناسه‌ی متفاوت اتفاق نیفتد.
 */
export async function enableNativeDailyReminder(deps: {
    requestPermission: () => Promise<LocalNotificationPermissionOutcome>
    setEnabled: (enabled: boolean) => void
}): Promise<NativeDailyReminderEnableOutcome> {
    const permission = await deps.requestPermission()
    if (!permission.ok) {
        return {
            ok: false,
            reason: permission.reason,
            message: permission.message,
        }
    }

    deps.setEnabled(true)

    return { ok: true }
}