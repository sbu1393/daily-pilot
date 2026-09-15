import { describe, expect, it } from "vitest"
import {
    buildMonthGrid,
    canonicalKeyToJalali,
    jalaliMonthRange,
    jalaliToCanonicalKey,
} from "./jalaliDate"

describe("jalaliDate", () => {
    it("converts a Gregorian canonical key to Jalali", () => {
        expect(canonicalKeyToJalali("2026-03-21")).toEqual({ year: 1405, month: 1, day: 1 })
    })

    it("converts a Jalali date to a Gregorian canonical key", () => {
        expect(jalaliToCanonicalKey(1405, 1, 1)).toBe("2026-03-21")
    })

    it.each(["2026-03-21", "2025-03-20", "2024-02-29"])(
        "round-trips %s through Jalali",
        (key) => {
            const jalali = canonicalKeyToJalali(key)
            expect(jalaliToCanonicalKey(jalali.year, jalali.month, jalali.day)).toBe(key)
        },
    )

    it("returns the Gregorian start and end of a Jalali month", () => {
        expect(jalaliMonthRange(1404, 1)).toEqual({
            year: 1404,
            month: 1,
            from: "2025-03-21",
            to: "2025-04-20",
        })
    })

    it("builds a Saturday-first grid with outside-month cells", () => {
        const cells = buildMonthGrid(1404, 1, "2025-03-21", "2025-03-21")

        expect(cells.length).toBe(42)
        expect(cells.slice(0, 6).map((cell) => cell.weekday)).toEqual([0, 1, 2, 3, 4, 5])
        expect(cells[0].isCurrentMonth).toBe(false)
        expect(cells[5].isCurrentMonth).toBe(false)
        expect(cells[6]).toMatchObject({
            canonicalKey: "2025-03-21",
            day: 1,
            month: 1,
            isCurrentMonth: true,
            isToday: true,
            isSelected: true,
            weekday: 6,
        })
        expect(cells.every((cell, index) => cell.weekday === index % 7)).toBe(true)
    })

    it("builds a leap Jalali month with its final day", () => {
        const cells = buildMonthGrid(1399, 12)
        const currentMonthCells = cells.filter((cell) => cell.isCurrentMonth)

        expect(currentMonthCells).toHaveLength(30)
        expect(currentMonthCells.at(-1)).toMatchObject({ day: 30, month: 12 })
        expect(currentMonthCells.at(-1)?.canonicalKey).toBe("2021-03-20")
    })

    it("handles a boundary month deterministically", () => {
        expect(jalaliMonthRange(1403, 1).from).toBe("2024-03-20")
        expect(jalaliToCanonicalKey(1403, 12, 30)).toBe("2025-03-20")
    })
})
