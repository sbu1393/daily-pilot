import moment from "moment-jalaali"

const TEHRAN_OFFSET_MIN = 210 // ایران UTC+3:30 و DST نداره

const pad = (n: number) => String(n).padStart(2, "0")

/** هر لحظه → کلید روز جلالی صفر-پد: "1403-05-17" (منطقه‌ی زمانی تهران) */
export function toDayKey(input?: Date | string | number): string {
    const m = moment(input ?? new Date()).utcOffset(TEHRAN_OFFSET_MIN)
    return `${m.jYear()}-${pad(m.jMonth() + 1)}-${pad(m.jDate())}`
}

export function todayKey(): string {
    return toDayKey(new Date())
}

/** کلید جلالی → Date میلادی (لحظه‌ی نیمه‌شب تهران) برای ذخیره در DB */
export function fromDayKey(dayKey: string): Date {
    const parsed = moment(dayKey, "jYYYY-jM-jD")
    return parsed.utcOffset(TEHRAN_OFFSET_MIN, true).toDate()
}

/** کلید + چند روز (rollover به فردا: +1) */
export function shiftDayKey(dayKey: string, days: number): string {
    const m = moment(fromDayKey(dayKey)).add(days, "days")
    const t = m.utcOffset(TEHRAN_OFFSET_MIN)
    return `${t.jYear()}-${pad(t.jMonth() + 1)}-${pad(t.jDate())}`
}
