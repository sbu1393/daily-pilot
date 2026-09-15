import moment from "moment-jalaali"



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

// ---------- C6 — Time Tracking input parsing (§5.4.1 «Validate duration») ----------
// مرز اعتبارسنجی سمت سرور: completeTaskSchema → عدد صحیح ۰ تا ۶۰۰ دقیقه.
// این تابع همان قرارداد را سمت client اعمال می‌کند تا ورودی نامعتبر هرگز به API نرسد.
export const SPENT_MINUTES_MIN = 1
export const SPENT_MINUTES_MAX = 600

export type SpentMinutesParse =
    | { ok: true; value: number }
    | { ok: false; error: string }

/**
 * پارس و اعتبارسنجی «مدت واقعی» ورودی کاربر (§5.4.1: Validate duration).
 * ورودی متنی از فیلد عددی → عدد صحیح ۱ تا ۶۰۰؛ در غیر این صورت پیام خطای فارسی.
 */
export function parseSpentMinutes(raw: string): SpentMinutesParse {
    const trimmed = raw.trim()
    if (trimmed === "") {
        return { ok: false, error: "مدت را وارد کنید" }
    }
    const value = Number(trimmed)
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
        return { ok: false, error: "مدت باید عدد صحیح باشد" }
    }
    if (value < SPENT_MINUTES_MIN) {
        return { ok: false, error: `مدت باید حداقل ${faDigits(SPENT_MINUTES_MIN)} دقیقه باشد` }
    }
    if (value > SPENT_MINUTES_MAX) {
        return { ok: false, error: `مدت نمی‌تواند بیشتر از ${faDigits(SPENT_MINUTES_MAX)} دقیقه باشد` }
    }
    return { ok: true, value }
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


// تبدیل میلادی به شمسی در ui

export function formatCanonicalToJalali(canonicalKey: string): string {
    if (!canonicalKey) return ""
    return faDigits(moment(canonicalKey, "YYYY-MM-DD").format("jYYYY/jMM/jDD"))
}
