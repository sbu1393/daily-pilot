import moment from "moment-jalaali"

export type JalaliDateParts = {
    year: number
    month: number
    day: number
}

export type JalaliMonth = {
    year: number
    month: number
}

export type JalaliMonthRange = JalaliMonth & {
    from: string
    to: string
}

export type JalaliGridCell = JalaliDateParts & {
    canonicalKey: string
    isCurrentMonth: boolean
    isToday: boolean
    isSelected: boolean
    weekday: number
}

function parseGregorianKey(key: string) {
    const date = moment(key, "YYYY-MM-DD", true)
    if (!date.isValid()) throw new RangeError(`Invalid canonical dayKey: "${key}"`)
    return date
}

function parseJalaliDate(year: number, month: number, day: number) {
    const date = moment(
        `${year}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`,
        "jYYYY/jMM/jDD",
        true,
    )
    if (!date.isValid() || date.jYear() !== year || date.jMonth() + 1 !== month || date.jDate() !== day) {
        throw new RangeError(`Invalid Jalali date: "${year}-${month}-${day}"`)
    }
    return date
}

export function canonicalKeyToJalali(key: string): JalaliDateParts {
    const date = parseGregorianKey(key)
    return { year: date.jYear(), month: date.jMonth() + 1, day: date.jDate() }
}

export function jalaliToCanonicalKey(year: number, month: number, day: number): string {
    return parseJalaliDate(year, month, day).format("YYYY-MM-DD")
}

export function jalaliMonthRange(year: number, month: number): JalaliMonthRange {
    const first = parseJalaliDate(year, month, 1)
    const last = first.clone().endOf("jMonth")
    return {
        year,
        month,
        from: first.format("YYYY-MM-DD"),
        to: last.format("YYYY-MM-DD"),
    }
}

export function buildMonthGrid(
    year: number,
    month: number,
    todayKey = "",
    selectedKey = "",
): JalaliGridCell[] {
    const range = jalaliMonthRange(year, month)
    const first = parseGregorianKey(range.from)
    const leadingDays = (first.day() + 1) % 7
    const daysInMonth = first.clone().endOf("jMonth").jDate()
    const totalCells = Math.ceil((leadingDays + daysInMonth) / 7) * 7
    const gridStart = first.clone().subtract(leadingDays, "day")

    return Array.from({ length: totalCells }, (_, index) => {
        const date = gridStart.clone().add(index, "day")
        const cellYear = date.jYear()
        const cellMonth = date.jMonth() + 1
        const cellDay = date.jDate()
        const canonicalKey = date.format("YYYY-MM-DD")

        return {
            year: cellYear,
            month: cellMonth,
            day: cellDay,
            canonicalKey,
            isCurrentMonth: cellYear === year && cellMonth === month,
            isToday: canonicalKey === todayKey,
            isSelected: canonicalKey === selectedKey,
            weekday: (date.day() + 1) % 7,
        }
    })
}
