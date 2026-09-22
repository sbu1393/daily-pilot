import moment from "moment-jalaali"
import { canonicalKeyToLocalMidnight, getCanonicalDayKey } from "@/app/lib/canonicalDay"
import { faDigits } from "@/app/lib/time"

/**
 * یادآوری per-task — لایه‌ی تبدیل و نمایش
 * -----------------------------------------------------------------
 * قرارداد (مطابق معماری):
 *   UI شمسی/فارسی → instant استاندارد (UTC) → DB (Task.reminderAt)
 *   DB → instant → UI شمسی/فارسی
 *
 * - هیچ تاریخ شمسی‌ای به‌صورت String ذخیره نمی‌شود.
 * - تبدیل به timezone خود کاربر (user.timezone از پروژه) انجام می‌شود؛
 *   نه timezone تصادفی مرورگر.
 * - ساعت همیشه ۲۴ ساعته و با ارقام فارسی.
 */

const JALALI_MONTHS = [
    "فروردین",
    "اردیبهشت",
    "خرداد",
    "تیر",
    "مرداد",
    "شهریور",
    "مهر",
    "آبان",
    "آذر",
    "دی",
    "بهمن",
    "اسفند",
]

const pad2 = (n: number) => String(n).padStart(2, "0")

/** ساعت ۲۴ ساعته با ارقام فارسی: «۱۴:۳۰» */
export function formatPersianClock(hour: number, minute: number): string {
    return `${faDigits(pad2(hour))}:${faDigits(pad2(minute))}`
}

/** تاریخ جلالی خوانا با ارقام فارسی: «۳۱ شهریور ۱۴۰۵» */
export function formatJalaliDateLong(canonicalKey: string): string {
    if (!canonicalKey) return ""
    const m = moment(canonicalKey, "YYYY-MM-DD")
    if (!m.isValid()) return ""
    return `${faDigits(m.jDate())} ${JALALI_MONTHS[m.jMonth()]} ${faDigits(m.jYear())}`
}

/**
 * تبدیل تاریخ canonical (روز محلی) + ساعت/دقیقه‌ی محلی در timezone کاربر به instant مطلق.
 * مبنا دقیقاً همان `canonicalKeyToLocalMidnight` است که در Task.scheduledDate استفاده می‌شود،
 * به‌علاوه‌ی دقیقه‌ی روز — بنابراین زمان‌بندی هر reminder با timezone کاربر هم‌خوان است.
 */
export function reminderInstantFromLocal(
    canonicalKey: string,
    hour: number,
    minute: number,
    timezone: string,
): Date {
    const midnight = canonicalKeyToLocalMidnight(canonicalKey, timezone)
    const minutesOfDay = hour * 60 + minute
    return new Date(midnight.getTime() + minutesOfDay * 60_000)
}

export type LocalReminderParts = { canonicalKey: string; hour: number; minute: number }

/**
 * instant مطلق → اجزای محلی در timezone کاربر (برای پرکردن picker هنگام ویرایش).
 * خروجی نامعتبر → null.
 */
export function getLocalReminderParts(
    instantIso: string | null,
    timezone: string,
): LocalReminderParts | null {
    if (!instantIso) return null
    const date = new Date(instantIso)
    if (Number.isNaN(date.getTime())) return null

    const canonicalKey = getCanonicalDayKey(date, timezone)
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hourCycle: "h23",
        hour: "2-digit",
        minute: "2-digit",
    }).formatToParts(date)

    const pick = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0")

    return { canonicalKey, hour: pick("hour"), minute: pick("minute") }
}

/** برچسب کامل یادآوری برای نمایش در کارت: «۳۱ شهریور ۱۴۰۵ ساعت ۱۴:۳۰» */
export function formatReminderLabel(instantIso: string | null, timezone: string): string | null {
    const parts = getLocalReminderParts(instantIso, timezone)
    if (!parts) return null
    return `${formatJalaliDateLong(parts.canonicalKey)} ساعت ${formatPersianClock(parts.hour, parts.minute)}`
}
