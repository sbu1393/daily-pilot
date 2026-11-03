/*
 * Pure UTC calendar helpers for the coach engine.
 *
 * Supported day keys: "YYYY-MM-DD" with year in [100, 9999].
 * - Week starts on Saturday.
 * - No I/O, no system clock, no locale formatting.
 * - Every out-of-domain result is rejected with RangeError.
 * - All range checks are centralised in shiftDayKey; the other calendar
 *   functions delegate to it so there is a single guarded translation point.
 */

const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const MIN_YEAR = 100
const MAX_YEAR = 9999
const SATURDAY = 6

type DayParts = { year: number; month: number; day: number }

/**
 * Internal: reject anything that is not a finite safe integer.
 * Negative values are allowed (used by deltaDays).
 */
function assertSafeInteger(value: unknown, field: string): asserts value is number {
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value)) {
        throw new RangeError(`INVALID:${field}`)
    }
}

/**
 * Internal shared guard for input numbers and derived sums.
 * Exported only for use inside app/lib/coach (see contract.test.ts).
 *
 * @internal
 */
export function assertSafeNonNegativeInteger(value: unknown, field: string): asserts value is number {
    assertSafeInteger(value, field)
    if (value < 0) {
        throw new RangeError(`INVALID:${field}`)
    }
}

/** Internal: parse and calendar-validate a canonical day key (round-trip through UTC). */
function parseDayKey(key: unknown): DayParts {
    if (typeof key !== "string") {
        throw new RangeError("INVALID:dayKey")
    }

    const match = DAY_KEY_PATTERN.exec(key)
    if (match === null) {
        throw new RangeError("INVALID:dayKey")
    }

    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])

    if (year < MIN_YEAR || year > MAX_YEAR) {
        throw new RangeError("INVALID:dayKey")
    }
    if (month < 1 || month > 12 || day < 1 || day > 31) {
        throw new RangeError("INVALID:dayKey")
    }

    // Date.UTC silently normalises 2026-02-30 or 2100-02-29; round-trip catches it.
    const timestamp = Date.UTC(year, month - 1, day)
    const date = new Date(timestamp)
    const roundTrip =
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day

    if (!roundTrip) {
        throw new RangeError("INVALID:dayKey")
    }

    return { year, month, day }
}

/** Internal: format validated UTC parts as a 4-digit-year day key. */
function formatDayKey(year: number, month: number, day: number): string {
    const y = String(year).padStart(4, "0")
    const m = String(month).padStart(2, "0")
    const d = String(day).padStart(2, "0")
    return `${y}-${m}-${d}`
}

/** Internal: day of week (0 = Sunday ... 6 = Saturday) for validated parts. */
function dayOfWeek(parts: DayParts): number {
    return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
}

/**
 * Shift a canonical day key by a signed number of days (UTC, pure calendar).
 *
 * deltaDays may be negative but must be a finite safe integer.
 * The result must stay inside the supported domain; otherwise RangeError.
 * This is the only function that performs day arithmetic and domain checks.
 */
export function shiftDayKey(dayKey: string, deltaDays: number): string {
    assertSafeInteger(deltaDays, "deltaDays")
    const { year, month, day } = parseDayKey(dayKey)

    const timestamp = Date.UTC(year, month - 1, day + deltaDays)
    if (!Number.isFinite(timestamp)) {
        throw new RangeError("INVALID:dayKey")
    }

    const shifted = new Date(timestamp)
    const shiftedYear = shifted.getUTCFullYear()
    const shiftedMonth = shifted.getUTCMonth() + 1
    const shiftedDay = shifted.getUTCDate()

    if (
        !Number.isFinite(shiftedYear) ||
        shiftedYear < MIN_YEAR ||
        shiftedYear > MAX_YEAR
    ) {
        throw new RangeError("INVALID:dayKey")
    }

    return formatDayKey(shiftedYear, shiftedMonth, shiftedDay)
}

/**
 * Compare two canonical day keys: -1 if a < b, 0 if equal, 1 if a > b.
 * Both keys are validated; invalid input throws RangeError.
 */
export function compareDayKeys(a: string, b: string): number {
    parseDayKey(a)
    parseDayKey(b)

    if (a === b) return 0
    return a < b ? -1 : 1
}

/**
 * True when the given valid day key is a Saturday.
 * Invalid keys throw RangeError (this is a validator, not a lenient predicate).
 */
export function isWeekStart(dayKey: string): boolean {
    const parts = parseDayKey(dayKey)
    return dayOfWeek(parts) === SATURDAY
}

/**
 * Saturday that starts the week containing dayKey.
 * Delegates the day arithmetic and domain check to shiftDayKey.
 *
 * Note: "0100-01-01" is a valid day key but its week starts at "0099-12-26",
 * outside the supported domain, so it throws RangeError.
 */
export function weekStartOf(dayKey: string): string {
    const parts = parseDayKey(dayKey)
    const offset = (dayOfWeek(parts) + 1) % 7
    return shiftDayKey(dayKey, -offset)
}

/**
 * Friday that ends the week starting at weekStart.
 * weekStart must be a Saturday; otherwise RangeError.
 */
export function weekEndOf(weekStart: string): string {
    if (!isWeekStart(weekStart)) {
        throw new RangeError("INVALID:weekStart")
    }
    return shiftDayKey(weekStart, 6)
}

/**
 * The seven day keys of the week starting at weekStart, ascending.
 * weekStart must be a Saturday; otherwise RangeError.
 */
export function weekDaysOf(weekStart: string): readonly string[] {
    if (!isWeekStart(weekStart)) {
        throw new RangeError("INVALID:weekStart")
    }

    const days: string[] = []
    for (let offset = 0; offset < 7; offset += 1) {
        days.push(shiftDayKey(weekStart, offset))
    }
    return days
}

/**
 * Integer percentage of part out of whole, rounded with Math.round.
 *
 * Divides first and scales afterwards, so the intermediate value never
 * leaves [0, 1] and cannot exceed the safe-integer range.
 *
 * Preconditions (re-checked defensively): part and whole are finite safe
 * non-negative integers, whole > 0 and part <= whole.
 *
 * @internal
 */
export function roundPercent(part: number, whole: number): number {
    assertSafeNonNegativeInteger(part, "percentPart")
    assertSafeNonNegativeInteger(whole, "percentWhole")

    if (whole === 0) {
        throw new RangeError("INVALID:percentWhole")
    }
    if (part > whole) {
        throw new RangeError("INVALID:percentPart")
    }

    const ratio = part / whole
    const percent = Math.round(ratio * 100)

    if (
        !Number.isFinite(percent) ||
        !Number.isSafeInteger(percent) ||
        percent < 0 ||
        percent > 100
    ) {
        throw new RangeError("INVALID:percent")
    }

    return percent
}
