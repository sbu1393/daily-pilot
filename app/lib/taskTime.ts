import { getCanonicalDayKey, shiftCanonicalKey } from "./canonicalDay"
import { faDigits, formatCanonicalToJalali } from "./time"

/*
 * تاریخ/ساعت مشترک تسک — منطق خالص (بدون React).
 *
 * آلارم تسک برای تبدیل مقدار و نمایش زمان به این توابع نیاز دارد. هیچ state،
 * storage یا زمان‌بندی اعلانی اینجا نیست.
 */

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
 * برچسب خوانای زمان: «امروز ۱۴:۳۰» / «فردا ۰۹:۰۰» / «۱۴۰۵/۰۷/۰۲ ۰۹:۰۰»
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
