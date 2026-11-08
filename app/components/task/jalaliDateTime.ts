import {
    canonicalKeyToJalali,
    jalaliMonthRange,
    jalaliToCanonicalKey,
} from "@/app/components/calender/jalaliDate"

/*
 * تبدیل تاریخ/ساعت شمسی ↔ مقدار `<input type="datetime-local">`
 * ---------------------------------------------------------------
 * قرارداد داده تغییر نمی‌کند: مقدار ورودی همچنان `YYYY-MM-DDTHH:mm` میلادی و
 * به وقت محلی دستگاه است. همان چیزی که پیش‌تر کنترل بومی تولید/مصرف می‌کرد؛
 * پس نیمه‌شب و منطقه‌ی زمانی دقیقاً مثل قبل رفتار می‌کند و فقط نمایش شمسی
 * می‌شود.
 *
 * چرا اینجا و نه `lib/`؟ این توابع فقط لایه‌ی نمایشِ انتخابگر آلارم‌اند و
 * هیچ storage/زمان‌بندی‌ای در آن‌ها نیست. تبدیل تقویم از هلپرهای موجود
 * `calender/jalaliDate.ts` بازاستفاده می‌شود.
 */

export type JalaliDateTimeParts = {
    year: number
    month: number
    day: number
    hour: number
    minute: number
}

export const JALALI_MONTH_NAMES = [
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
] as const

const pad2 = (n: number) => String(n).padStart(2, "0")

const DATETIME_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

/** شمار روزهای ماه شمسی (اسفند در سال کبیسه ۳۰ است). */
export function daysInJalaliMonth(year: number, month: number): number {
    const range = jalaliMonthRange(year, month)
    return canonicalKeyToJalali(range.to).day
}

/** هر لحظه → اجزای شمسی به وقت محلی دستگاه (هم‌معنا با مسیر قبلی). */
export function epochMsToJalaliDateTimeParts(epochMs: number): JalaliDateTimeParts {
    const date = new Date(epochMs)
    const canonicalKey = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    const jalali = canonicalKeyToJalali(canonicalKey)

    return {
        ...jalali,
        hour: date.getHours(),
        minute: date.getMinutes(),
    }
}

/**
 * مقدار `YYYY-MM-DDTHH:mm` → اجزای شمسی.
 * ورودی نامعتبر (فرمت، ساعت/دقیقه‌ی خارج از محدوده یا روز میلادیِ ناموجود) → null.
 */
export function datetimeLocalValueToJalaliDateTimeParts(
    value: string,
): JalaliDateTimeParts | null {
    const match = DATETIME_LOCAL_RE.exec(value)
    if (!match) return null

    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    const hour = Number(match[4])
    const minute = Number(match[5])

    if (year < 1000 || hour > 23 || minute > 59) return null

    /* اعتبارسنجی روز میلادی: 2026-02-30 نباید بی‌صدا به ۲ مارس بغلتد. */
    const local = new Date(year, month - 1, day, hour, minute, 0, 0)
    if (
        local.getFullYear() !== year ||
        local.getMonth() !== month - 1 ||
        local.getDate() !== day
    ) {
        return null
    }

    return epochMsToJalaliDateTimeParts(local.getTime())
}

/**
 * اجزای شمسی → مقدار `YYYY-MM-DDTHH:mm` (میلادی، وقت محلی دستگاه).
 * تاریخ/ساعت نامعتبر (مثل ۱۴۰۴/۱۲/۳۰ یا ساعت ۲۴) → null.
 */
export function jalaliDateTimePartsToDatetimeLocalValue(
    parts: JalaliDateTimeParts,
): string | null {
    const { year, month, day, hour, minute } = parts

    if (
        !Number.isInteger(year) ||
        !Number.isInteger(month) ||
        month < 1 ||
        month > 12 ||
        !Number.isInteger(day) ||
        day < 1 ||
        !Number.isInteger(hour) ||
        hour < 0 ||
        hour > 23 ||
        !Number.isInteger(minute) ||
        minute < 0 ||
        minute > 59
    ) {
        return null
    }

    let canonicalKey: string
    try {
        canonicalKey = jalaliToCanonicalKey(year, month, day)
    } catch {
        return null
    }

    return `${canonicalKey}T${pad2(hour)}:${pad2(minute)}`
}
