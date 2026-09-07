// G-02 — canonical day foundation (server-side)
//
// قرارداد canonical: کلید روز ذخیرهشده = میلادی "YYYY-MM-DD"
// و مشتق از timezone خود کاربر (User.timezone از DB).
// هیچ offset ثابتی (مثل تهران) اینجا هاردکد نمیشود.
// لایهی نمایش جلالی جدا است و در jalili.ts باقی میماند.

type DayParts = { year: string; month: string; day: string }

function dayParts(date: Date, timezone: string): DayParts {
    const parts = new Intl.DateTimeFormat("en", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date)

    const pick = (type: string): string => {
        const part = parts.find((p) => p.type === type)
        if (!part) throw new Error(`Intl did not return "${type}" part`)
        return part.value
    }

    return { year: pick("year"), month: pick("month"), day: pick("day") }
}

/** اختلاف timezone با UTC در لحظهی دادهشده، بر حسب میلیثانیه */
function timeZoneOffsetMs(date: Date, timezone: string): number {
    const parts = new Intl.DateTimeFormat("en", {
        timeZone: timezone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).formatToParts(date)

    const pick = (type: string): string => {
        const part = parts.find((p) => p.type === type)
        if (!part) throw new Error(`Intl did not return "${type}" part`)
        return part.value
    }

    const asUtc = Date.UTC(
        Number(pick("year")),
        Number(pick("month")) - 1,
        Number(pick("day")),
        Number(pick("hour")),
        Number(pick("minute")),
        Number(pick("second")),
    )

    return asUtc - date.getTime()
}

/**
 * هر لحظه → کلید روز canonical میلادی در timezone کاربر: "2026-01-02"
 * timezone نامعتبر → RangeError صریح (بدون fallback پنهان)
 */
export function getCanonicalDayKey(date: Date, timezone: string): string {
    const { year, month, day } = dayParts(date, timezone)
    return `${year}-${month}-${day}`
}

/**
 * نیمهشب محلیِ روزِ canonical که این لحظه در آن افتاده — به شکل instant UTC.
 * دو پاس برای درستی در مرزهای DST (مثل Europe/Berlin).
 */
export function getLocalMidnight(date: Date, timezone: string): Date {
    const { year, month, day } = dayParts(date, timezone)

    const midnightUtc = Date.UTC(Number(year), Number(month) - 1, Number(day))

    let ts = midnightUtc - timeZoneOffsetMs(new Date(midnightUtc), timezone)
    ts = midnightUtc - timeZoneOffsetMs(new Date(ts), timezone)

    return new Date(ts)
}
