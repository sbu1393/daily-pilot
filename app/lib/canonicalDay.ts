// G-02 — canonical day foundation (server-side)
//
// قرارداد canonical: کلید روز ذخیرهشده = میلادی "YYYY-MM-DD"
// و مشتق از timezone خود کاربر (User.timezone از DB).
// هیچ offset ثابتی (مثل تهران) اینجا هاردکد نمیشود.
// لایهی نمایش جلالی جدا است و در jalili.ts باقی میماند.

type DayParts = { year: string; month: string; day: string }

const CANONICAL_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

/** اعتبارسنجی تقویمی (ماه ۱–۱۲، روز ۱–۳۱) تا Date.UTC مقدار خارج از محدوده را بیصدا نرمالایز نکند. */
function assertValidKeyParts(key: string): [number, number, number] {
    if (!CANONICAL_KEY_RE.test(key)) {
        throw new RangeError(`Invalid canonical dayKey: "${key}"`)
    }

    const [year, month, day] = key.split("-").map(Number)

    if (year < 100 || month < 1 || month > 12 || day < 1 || day > 31) {
        throw new RangeError(`Invalid canonical dayKey: "${key}"`)
    }

    const d = new Date(Date.UTC(year, month - 1, day))

    if (
        d.getUTCFullYear() !== year ||
        d.getUTCMonth() !== month - 1 ||
        d.getUTCDate() !== day
    ) {
        throw new RangeError(`Invalid canonical dayKey: "${key}"`)
    }

    return [year, month, day]
}

/**
 * M10 — اعتبارسنجی سخت‌گیرانه‌ی کلید canonical «YYYY-MM-DD» برای ورودی کاربر (query param):
 * هم قالب و هم تقویم. «2026-13-99» یا «2026-02-30» هر دو نامعتبرند — Date آن‌ها را
 * بی‌صدا نرمالایز می‌کند، پس مقایسه‌ی round-trip لازم است.
 * سال‌های ۰–۹۹ هم رد می‌شوند چون Date.UTC آن‌ها را ۱۹xx تفسیر می‌کند.
 */
export function isValidCanonicalDayKey(key: string): boolean {
    try {
        assertValidKeyParts(key)
        return true
    } catch {
        return false
    }
}

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

/**
 * کلید canonical "YYYY-MM-DD" → نیمهشب محلی همان روز در timezone دادهشده (instant UTC).
 * نقش معادل fromDayKey در jalili.ts — ولی برای کلیدهای canonical.
 * کلید نامعتبر → RangeError صریح.
 */
export function canonicalKeyToLocalMidnight(key: string, timezone: string): Date {
    const [year, month, day] = assertValidKeyParts(key)
    const midnightUtc = Date.UTC(year, month - 1, day)

    let ts = midnightUtc - timeZoneOffsetMs(new Date(midnightUtc), timezone)
    ts = midnightUtc - timeZoneOffsetMs(new Date(ts), timezone)

    return new Date(ts)
}

/**
 * جابهجایی کلید canonical به تعداد روز (مثبت = فردا، منفی = دیروز).
 * کلید یک برچسب تقویمی مستقل از timezone است؛ جابهجایی روی خود کلید انجام میشود.
 */
export function shiftCanonicalKey(key: string, days: number): string {
    const [year, month, day] = assertValidKeyParts(key)
    const shifted = new Date(Date.UTC(year, month - 1, day + days))

    return shifted.toISOString().slice(0, 10)
}

/** امروزِ canonical در timezone دادهشده — جایگزین todayKey() در فاز cutover. */
export function getCanonicalToday(timezone: string): string {
    return getCanonicalDayKey(new Date(), timezone)
}
