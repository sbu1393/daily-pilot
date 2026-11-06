/*
 * سیاست مشترک «بی‌فعالیتی / بازگشت» — خالص و قابل تست
 * ---------------------------------------------------------------
 * این ماژول تنها منبع حقیقت برای آستانه‌ها و cutoffهای دو سرویس است:
 *   • taskDigestCron.service  → برای متوقف‌کردن `overdue` روی کاربران خواب‌آلود
 *   • inactivityReminder.service → برای تشخیص بی‌فعالیتی و cool-down بازگشت
 *
 * قاعدهٔ ضداسپم overdue ↔ inactivity:
 *   کاربر «خواب‌آلود» کسی است که `lastSeenAt` او null است یا از cutoff سه‌روزه
 *   قدیمی‌تر است. برای چنین کاربری پیام روزانهٔ `overdue` ارسال نمی‌شود تا
 *   کانال بازگشت (حداکثر یک پیام در هر ۷ روز) عملاً بی‌اثر نشود. کاربران فعال
 *   (lastSeenAt داخل سه روز اخیر) و مسیرهای morning/night بدون تغییر می‌مانند.
 *
 *   در روز مرز (کاربری که ساعت ۹ هنوز فعال است و ساعت ۱۰ خواب‌آلود می‌شود)،
 *   سرویس بازگشت اگر در ۲۴ ساعت گذشته `overdue` گرفته باشد یک روز صبر می‌کند
 *   تا در یک روز دو پیام نگیرد؛ اجرای فردا به‌طور عادی بازگشت را می‌فرستد.
 */

export const DAY_MS = 24 * 60 * 60 * 1000
export const HOUR_MS = 60 * 60 * 1000

/** آستانهٔ بی‌فعالیتی — rolling 72 ساعت. */
export const INACTIVITY_DAYS = 3

/** فاصلهٔ حداقلی بین دو پیام بازگشت برای یک کاربر. */
export const REENGAGEMENT_COOLDOWN_DAYS = 7

/** اگر در این بازه پیام overdue رفته باشد، بازگشت همان روز ارسال نمی‌شود. */
export const REENGAGEMENT_OVERDUE_QUIET_HOURS = 24

/** نوع ردیف در SentNotification.type — ستون String است، بدون migration. */
export const INACTIVITY_NOTIFICATION_TYPE = "inactivity" as const
export const OVERDUE_NOTIFICATION_TYPE = "overdue" as const

/** مقصد پیام بازگشت. */
export const REENGAGEMENT_URL = "/dashboard"

/** مرز «۳ روز پیش» برای تشخیص بی‌فعالیتی و حذف از overdue. */
export function inactivityCutoff(now: Date): Date {
    return new Date(now.getTime() - INACTIVITY_DAYS * DAY_MS)
}

/** مرز cool-down هفت‌روزهٔ پیام بازگشت. */
export function reengagementCooldownCutoff(now: Date): Date {
    return new Date(now.getTime() - REENGAGEMENT_COOLDOWN_DAYS * DAY_MS)
}

/** مرز پنجرهٔ سکوت پس از یک پیام overdue. */
export function overdueQuietCutoff(now: Date): Date {
    return new Date(now.getTime() - REENGAGEMENT_OVERDUE_QUIET_HOURS * HOUR_MS)
}

/**
 * آیا کاربر در وضعیت خواب‌آلود است؟
 * null یعنی هرگز فعالیتی ثبت نشده؛ همان‌طور که در سرویس بازگشت واجد شرایط است،
 * در overdue هم خواب‌آلود حساب می‌شود.
 */
export function isDormant(lastSeenAt: Date | null, now: Date): boolean {
    return lastSeenAt === null || lastSeenAt.getTime() <= inactivityCutoff(now).getTime()
}
