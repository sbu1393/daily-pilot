/**
 * فهرست کوتاهِ منطقه‌های زمانی برای سلکتور تنظیمات.
 *
 * چرا فهرست کوتاه و نه همهٔ ~۶۰۰ منطقه؟ سلکتور تنظیمات باید در یک نگاه قابل
 * استفاده باشد. اعتبارسنجی/ذخیره به این فهرست وابسته نیست: مرز API هر مقدار
 * معتبر IANA را با `Intl.DateTimeFormat` می‌پذیرد. پس اگر کاربری از دستگاه
 * دیگری منطقه‌ای خارج از این فهرست داشته باشد، `timezoneOptionsWith` آن را
 * به‌عنوان گزینهٔ «(فعلی)» اضافه می‌کند تا مقدارش از دست نرود.
 */

export const DEFAULT_TIMEZONE = "Asia/Tehran"

export type TimezoneOption = { value: string; label: string }

export const TIMEZONE_OPTIONS: readonly TimezoneOption[] = [
    { value: "Asia/Tehran", label: "تهران (ایران)" },
    { value: "Asia/Dubai", label: "دبی (امارات)" },
    { value: "Asia/Istanbul", label: "استانبول (ترکیه)" },
    { value: "Asia/Baghdad", label: "بغداد (عراق)" },
    { value: "Asia/Riyadh", label: "ریاض (عربستان)" },
    { value: "Asia/Kabul", label: "کابل (افغانستان)" },
    { value: "Asia/Karachi", label: "کراچی (پاکستان)" },
    { value: "Asia/Kolkata", label: "دهلی/کلکته (هند)" },
    { value: "Europe/London", label: "لندن (انگلستان)" },
    { value: "Europe/Berlin", label: "برلین (آلمان)" },
    { value: "Europe/Paris", label: "پاریس (فرانسه)" },
    { value: "Europe/Amsterdam", label: "آمستردام (هلند)" },
    { value: "Europe/Stockholm", label: "استکهلم (سوئد)" },
    { value: "America/New_York", label: "نیویورک (آمریکا)" },
    { value: "America/Chicago", label: "شیکاگو (آمریکا)" },
    { value: "America/Denver", label: "دنور (آمریکا)" },
    { value: "America/Los_Angeles", label: "لس‌آنجلس (آمریکا)" },
    { value: "America/Toronto", label: "تورنتو (کانادا)" },
    { value: "Australia/Sydney", label: "سیدنی (استرالیا)" },
    { value: "UTC", label: "UTC (زمان جهانی)" },
]

/**
 * گزینه‌های سلکتور؛ اگر منطقهٔ فعلی کاربر در فهرست نباشد، در ابتدا اضافه می‌شود
 * تا `<select>` هرگز مقدار ذخیره‌شده را به‌صورت خالی نشان ندهد.
 */
export function timezoneOptionsWith(current?: string | null): TimezoneOption[] {
    const value = current?.trim()
    if (!value || TIMEZONE_OPTIONS.some((option) => option.value === value)) {
        return [...TIMEZONE_OPTIONS]
    }
    return [{ value, label: `${value} (فعلی)` }, ...TIMEZONE_OPTIONS]
}
