/*
 * یادآورها — زمان‌بندی سمت سرور (خالص و قابل تست)
 * ---------------------------------------------------------------
 * تریگر زمان‌بندی‌شده باید برای هر کاربر (با timezone خودش) تصمیم بگیرد که آیا
 * «الان» زمان یادآور اوست. این ماژول هیچ وابستگی‌ای به Prisma/Next ندارد تا
 * مرزهای زمانی دقیقاً تست شوند (همان الگوی reminder.ts سمت کلاینت).
 *
 * قراردادها:
 * - `reminderTime` همیشه "HH:MM" به **وقت محلی کاربر** (User.timezone) است.
 * - `reminderSentOn` کلید روز محلی (`YYYY-MM-DD`) آخرین ارسال موفق است؛
 *   مقایسه‌ی آن با روز جاری، «حداکثر یک یادآور در روز» را تضمین می‌کند.
 * - پنجره‌ی سررسید از دقیقه‌ی جاری حساب می‌شود و باید ≥ فاصله‌ی اجرای cron باشد
 *   (cron هر ۱۰ دقیقه، پنجره ۱۵ دقیقه) تا یک اجرای دیرشده/ناموفق باعث از دست
 *   رفتن یادآور نشود؛ ضد-تکرار روزانه جلوی ارسال دوباره را می‌گیرد.
 */

export const REMINDER_DUE_WINDOW_MINUTES = 15
export const DEFAULT_TIMEZONE = "UTC"

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

export function parseHHMM(value: string | null | undefined): number | null {
    if (typeof value !== "string") return null
    const match = HHMM_RE.exec(value.trim())
    if (!match) return null

    return Number(match[1]) * 60 + Number(match[2])
}

type ZonedParts = { year: string; month: string; day: string; hour: string; minute: string }

/** اجزای تاریخ/ساعت در یک timezone مشخص — با fallback به UTC اگر tz نامعتبر باشد. */
function zonedParts(now: Date, timezone: string): ZonedParts {
    const build = (tz: string): ZonedParts => {
        const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
        })

        const parts: Record<string, string> = {}
        for (const part of formatter.formatToParts(now)) {
            if (part.type !== "literal") parts[part.type] = part.value
        }

        return {
            year: parts.year ?? "1970",
            month: parts.month ?? "01",
            day: parts.day ?? "01",
            hour: parts.hour ?? "00",
            minute: parts.minute ?? "00",
        }
    }

    try {
        return build(timezone)
    } catch {
        // tz نامعتبر → UTC (بدون پرتاب خطا؛ cron نباید به‌خاطر یک رکورد بخوابد)
        try {
            return build(DEFAULT_TIMEZONE)
        } catch {
            return { year: "1970", month: "01", day: "01", hour: "00", minute: "00" }
        }
    }
}

/** کلید روز محلی کاربر: `YYYY-MM-DD` (نه UTC). */
export function localDayKey(now: Date, timezone: string): string {
    const parts = zonedParts(now, timezone)
    return `${parts.year}-${parts.month}-${parts.day}`
}

/** ساعت محلی کاربر: `HH:MM`. */
export function localTimeHHMM(now: Date, timezone: string): string {
    const parts = zonedParts(now, timezone)
    return `${parts.hour}:${parts.minute}`
}

/** فاصله‌ی دقیقه‌ای «الان» تا زمان یادآور در همان روز محلی (منفی = نرسیده). */
export function minutesSinceReminder(
    now: Date,
    timezone: string,
    reminderTime: string,
): number | null {
    const target = parseHHMM(reminderTime)
    const current = parseHHMM(localTimeHHMM(now, timezone))

    if (target == null || current == null) return null
    return current - target
}

/**
 * آیا برای این کاربر همین حالا باید یادآور Push بفرستیم؟
 * شرایط: یادآور فعال (در کوئری)، زمان معتبر، داخل پنجره‌ی سررسید، و امروز
 * برای این کاربر ارسال نشده باشد.
 */
export function isReminderDue(args: {
    now: Date
    timezone: string
    reminderTime: string
    reminderSentOn?: string | null
    windowMinutes?: number
}): boolean {
    const windowMinutes = args.windowMinutes ?? REMINDER_DUE_WINDOW_MINUTES
    const elapsed = minutesSinceReminder(args.now, args.timezone, args.reminderTime)

    if (elapsed == null) return false
    if (elapsed < 0) return false
    if (elapsed >= windowMinutes) return false

    return args.reminderSentOn !== localDayKey(args.now, args.timezone)
}
