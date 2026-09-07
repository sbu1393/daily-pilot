// تبدیل ارقام به فارسی
export function faDigits(input: number | string): string {
    return String(input).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)])
}

// ۹۰ → «۱ ساعت و ۳۰ دقیقه»
export function fmtMinutes(minutes: number): string {
    const m = Math.max(0, Math.round(minutes))
    if (m < 60) return `${faDigits(m)} دقیقه`
    const h = Math.floor(m / 60)
    const r = m % 60
    return r === 0 ? `${faDigits(h)} ساعت` : `${faDigits(h)} ساعت و ${faDigits(r)} دقیقه`
}

/**
 * زمان نسبی فارسی: «چند لحظه پیش»، «۵ دقیقه پیش»، «۳ ساعت پیش»،
 * «۲ روز پیش»، «۱ هفته پیش»، «۴ ماه پیش» و «۲ سال پیش»
 */
export function faRelativeTime(input: Date | string | number): string {
    const date = input instanceof Date ? input : new Date(input)
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000)

    if (Number.isNaN(date.getTime())) return ""
    if (seconds < 0) return "الان" // تاریخ آینده
    if (seconds < 45) return "چند لحظه پیش"

    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${faDigits(minutes)} دقیقه پیش`

    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${faDigits(hours)} ساعت پیش`

    const days = Math.floor(hours / 24)
    if (days < 7) return `${faDigits(days)} روز پیش`

    const weeks = Math.floor(days / 7)
    if (days < 31) return `${faDigits(weeks)} هفته پیش`

    const months = Math.floor(days / 30)
    if (months < 12) return `${faDigits(months)} ماه پیش`

    const years = Math.floor(days / 365)
    return `${faDigits(years)} سال پیش`
}
