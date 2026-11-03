import { describe, expect, it } from "vitest"
import { shiftCanonicalKey } from "../canonicalDay"
import {
    assertSafeNonNegativeInteger,
    compareDayKeys,
    isWeekStart,
    roundPercent,
    shiftDayKey,
    weekDaysOf,
    weekEndOf,
    weekStartOf,
} from "./week"

const MAX = Number.MAX_SAFE_INTEGER
const MIN = Number.MIN_SAFE_INTEGER

describe("shiftDayKey - calendar arithmetic", () => {
    it("returns the same key for delta 0", () => {
        for (const key of ["2026-11-03", "0100-01-01", "9999-12-31", "2024-02-29"]) {
            expect(shiftDayKey(key, 0)).toBe(key)
        }
    })

    it("shifts forward and backward across month boundaries", () => {
        expect(shiftDayKey("2026-11-03", 1)).toBe("2026-11-04")
        expect(shiftDayKey("2026-11-03", -1)).toBe("2026-11-02")
        expect(shiftDayKey("2026-11-03", 28)).toBe("2026-12-01")
        expect(shiftDayKey("2026-11-03", -34)).toBe("2026-09-30")
        expect(shiftDayKey("2026-01-01", 365)).toBe("2027-01-01")
    })

    it("shifts across year boundaries", () => {
        expect(shiftDayKey("2025-12-31", 1)).toBe("2026-01-01")
        expect(shiftDayKey("2026-01-01", -1)).toBe("2025-12-31")
        expect(shiftDayKey("9999-12-31", 0)).toBe("9999-12-31")
    })

    it("handles leap years including the 2000/2100 century rules", () => {
        expect(shiftDayKey("2023-02-28", 1)).toBe("2023-03-01")
        expect(shiftDayKey("2024-02-28", 1)).toBe("2024-02-29")
        expect(shiftDayKey("2024-02-29", 1)).toBe("2024-03-01")
        expect(shiftDayKey("2024-03-01", -1)).toBe("2024-02-29")
        expect(shiftDayKey("2000-02-28", 1)).toBe("2000-02-29")
        expect(shiftDayKey("2100-02-28", 1)).toBe("2100-03-01")
    })

    it("matches canonicalDay.shiftCanonicalKey inside the supported range", () => {
        const samples = [
            "2024-02-28",
            "2024-02-29",
            "2025-12-31",
            "2026-01-01",
            "2026-03-01",
            "2000-02-29",
            "2100-02-28",
        ]
        for (const key of samples) {
            for (let delta = -40; delta <= 40; delta += 1) {
                expect(shiftDayKey(key, delta)).toBe(shiftCanonicalKey(key, delta))
            }
        }
    })

    it("accepts negative zero as zero", () => {
        expect(shiftDayKey("2026-11-03", -0)).toBe("2026-11-03")
    })

    it("rejects non-integer, non-finite and unsafe deltas", () => {
        for (const delta of [1.5, Number.NaN, Infinity, -Infinity, 2 ** 53, -(2 ** 53)]) {
            expect(() => shiftDayKey("2026-11-03", delta)).toThrow(RangeError)
        }
    })

    it("rejects positive and negative domain overflow", () => {
        expect(() => shiftDayKey("0100-01-01", -1)).toThrow(RangeError)
        expect(() => shiftDayKey("9999-12-31", 1)).toThrow(RangeError)
        expect(shiftDayKey("0100-01-02", -1)).toBe("0100-01-01")
        expect(shiftDayKey("9999-12-30", 1)).toBe("9999-12-31")
    })

    it("rejects huge safe-integer deltas through the Invalid Date guard", () => {
        expect(() => shiftDayKey("2026-01-01", MAX)).toThrow(RangeError)
        expect(() => shiftDayKey("2026-01-01", MIN)).toThrow(RangeError)
    })

    it("rejects invalid day keys", () => {
        const invalid = [
            "2026-1-01",
            "26-01-01",
            "10000-01-01",
            "0099-12-31",
            "2026-13-01",
            "2026-00-10",
            "2026-02-30",
            "2100-02-29",
            "2026-04-31",
            "",
            "not-a-day",
        ]
        for (const key of invalid) {
            expect(() => shiftDayKey(key, 0)).toThrow(RangeError)
        }
        expect(() => shiftDayKey(null as unknown as string, 0)).toThrow(RangeError)
        expect(() => shiftDayKey(20261103 as unknown as string, 0)).toThrow(RangeError)
    })
})

describe("compareDayKeys", () => {
    it("orders keys lexicographically for validated fixed-width keys", () => {
        expect(compareDayKeys("2026-11-03", "2026-11-03")).toBe(0)
        expect(compareDayKeys("2026-11-02", "2026-11-03")).toBe(-1)
        expect(compareDayKeys("2026-11-04", "2026-11-03")).toBe(1)
        expect(compareDayKeys("0100-01-01", "9999-12-31")).toBe(-1)
        expect(compareDayKeys("9999-12-31", "0100-01-01")).toBe(1)
    })

    it("rejects invalid operands", () => {
        expect(() => compareDayKeys("2026-02-30", "2026-11-03")).toThrow(RangeError)
        expect(() => compareDayKeys("2026-11-03", "2026-13-01")).toThrow(RangeError)
        expect(() => compareDayKeys("2026-11-03", "0099-12-31")).toThrow(RangeError)
    })
})

describe("isWeekStart", () => {
    it("is true only for Saturdays", () => {
        expect(isWeekStart("2026-10-31")).toBe(true)
        expect(isWeekStart("2026-11-01")).toBe(false)
        expect(isWeekStart("2026-11-03")).toBe(false)
        expect(isWeekStart("2026-11-06")).toBe(false)
        expect(isWeekStart("2026-11-07")).toBe(true)
        expect(isWeekStart("0100-01-02")).toBe(true)
        expect(isWeekStart("9999-12-25")).toBe(true)
        expect(isWeekStart("1947-12-27")).toBe(true)
    })

    it("throws on invalid keys instead of returning false", () => {
        expect(() => isWeekStart("2026-02-30")).toThrow(RangeError)
        expect(() => isWeekStart("0099-12-31")).toThrow(RangeError)
    })
})

describe("weekStartOf", () => {
    it("returns the containing Saturday", () => {
        expect(weekStartOf("2026-10-31")).toBe("2026-10-31")
        expect(weekStartOf("2026-11-01")).toBe("2026-10-31")
        expect(weekStartOf("2026-11-03")).toBe("2026-10-31")
        expect(weekStartOf("2026-11-06")).toBe("2026-10-31")
        expect(weekStartOf("2026-11-07")).toBe("2026-11-07")
        expect(weekStartOf("2024-02-29")).toBe("2024-02-24")
        expect(weekStartOf("2024-01-01")).toBe("2023-12-30")
        expect(weekStartOf("2000-02-29")).toBe("2000-02-26")
        expect(weekStartOf("2025-12-31")).toBe("2025-12-27")
        expect(weekStartOf("9999-12-31")).toBe("9999-12-25")
    })

    it("rejects a valid day whose week start falls outside the domain", () => {
        expect(() => weekStartOf("0100-01-01")).toThrow(RangeError)
    })

    it("accepts the first Saturday of the supported domain", () => {
        expect(weekStartOf("0100-01-02")).toBe("0100-01-02")
        expect(weekStartOf("0100-01-03")).toBe("0100-01-02")
    })
})

describe("weekEndOf and weekDaysOf", () => {
    it("returns Friday as the week end", () => {
        expect(weekEndOf("2026-10-31")).toBe("2026-11-06")
        expect(weekEndOf("2024-02-24")).toBe("2024-03-01")
        expect(weekEndOf("2000-02-26")).toBe("2000-03-03")
        expect(weekEndOf("0100-01-02")).toBe("0100-01-08")
        expect(weekEndOf("9999-12-25")).toBe("9999-12-31")
    })

    it("rejects non-Saturday week starts", () => {
        expect(() => weekEndOf("2026-11-01")).toThrow(RangeError)
        expect(() => weekEndOf("9999-12-31")).toThrow(RangeError)
    })

    it("returns seven ascending contiguous days", () => {
        const days = weekDaysOf("2026-10-31")
        expect(days).toEqual([
            "2026-10-31",
            "2026-11-01",
            "2026-11-02",
            "2026-11-03",
            "2026-11-04",
            "2026-11-05",
            "2026-11-06",
        ])
        for (let index = 1; index < days.length; index += 1) {
            expect(shiftDayKey(days[index - 1], 1)).toBe(days[index])
            expect(isWeekStart(days[index])).toBe(false)
        }
        expect(isWeekStart(days[0])).toBe(true)
    })

    it("works at both ends of the supported domain", () => {
        expect(weekDaysOf("0100-01-02")).toEqual([
            "0100-01-02",
            "0100-01-03",
            "0100-01-04",
            "0100-01-05",
            "0100-01-06",
            "0100-01-07",
            "0100-01-08",
        ])
        const lastWeek = weekDaysOf("9999-12-25")
        expect(lastWeek).toHaveLength(7)
        expect(lastWeek[0]).toBe("9999-12-25")
        expect(lastWeek[6]).toBe("9999-12-31")
    })

    it("rejects non-Saturday week starts", () => {
        expect(() => weekDaysOf("2026-11-03")).toThrow(RangeError)
        expect(() => weekDaysOf("9999-12-31")).toThrow(RangeError)
    })
})

describe("roundPercent", () => {
    it("rounds to a finite safe integer in 0..100", () => {
        const table: Array<[number, number, number]> = [
            [1, 2, 50],
            [1, 3, 33],
            [2, 3, 67],
            [1, 7, 14],
            [7, 8, 88],
            [1, 8, 13],
            [1, 199, 1],
            [1, 200, 1],
            [0, 3, 0],
            [3, 3, 100],
            [1, 6, 17],
            [2, 5, 40],
        ]
        for (const [part, whole, expected] of table) {
            const result = roundPercent(part, whole)
            expect(result).toBe(expected)
            expect(Number.isFinite(result)).toBe(true)
            expect(Number.isSafeInteger(result)).toBe(true)
            expect(result).toBeGreaterThanOrEqual(0)
            expect(result).toBeLessThanOrEqual(100)
        }
    })

    it("handles the maximum safe numerator and denominator", () => {
        expect(roundPercent(MAX, MAX)).toBe(100)
        expect(roundPercent(0, MAX)).toBe(0)
        expect(roundPercent(1, MAX)).toBe(0)
    })

    it("rejects zero denominator and part greater than whole", () => {
        expect(() => roundPercent(1, 0)).toThrow(RangeError)
        expect(() => roundPercent(0, 0)).toThrow(RangeError)
        expect(() => roundPercent(2, 1)).toThrow(RangeError)
    })

    it("rejects invalid operands", () => {
        const invalid = [Number.NaN, Infinity, -Infinity, 1.5, 2 ** 53, -1]
        for (const value of invalid) {
            expect(() => roundPercent(value, 10)).toThrow(RangeError)
            expect(() => roundPercent(1, value)).toThrow(RangeError)
        }
    })
})

describe("assertSafeNonNegativeInteger", () => {
    it("accepts finite safe non-negative integers", () => {
        for (const value of [0, -0, 1, 2 ** 52, MAX]) {
            expect(() => assertSafeNonNegativeInteger(value, "x")).not.toThrow()
        }
    })

    it("rejects NaN, infinities, fractions, unsafe integers and negatives", () => {
        const invalid = [Number.NaN, Infinity, -Infinity, 1.5, 2 ** 53, -(2 ** 53), -1, -0.0001]
        for (const value of invalid) {
            expect(() => assertSafeNonNegativeInteger(value, "x")).toThrow(RangeError)
        }
    })

    it("rejects non-number values", () => {
        for (const value of ["1", null, undefined, true, {}]) {
            expect(() => assertSafeNonNegativeInteger(value, "x")).toThrow(RangeError)
        }
    })
})
