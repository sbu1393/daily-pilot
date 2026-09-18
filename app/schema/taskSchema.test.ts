import { describe, expect, it } from "vitest"
import { canonicalKeyToLocalMidnight, getCanonicalDayKey } from "@/app/lib/canonicalDay"
import { makeCreateTaskSchema } from "./taskSchema"

const title = "تسک آزمایشی"

function parseScheduledDate(timezone: string, scheduledDate: unknown) {
    const parsed = makeCreateTaskSchema(timezone).safeParse({ title, scheduledDate })
    if (!parsed.success) throw new Error(parsed.error.message)
    return parsed.data.scheduledDate
}

describe("taskSchema scheduledDate", () => {
    it("interprets date-only input at local midnight in America/New_York", () => {
        const timezone = "America/New_York"
        const actual = parseScheduledDate(timezone, "2026-01-01")
        const expected = canonicalKeyToLocalMidnight("2026-01-01", timezone)

        expect(actual).toEqual(expected)
        expect(getCanonicalDayKey(actual, timezone)).toBe("2026-01-01")
    })

    it("interprets date-only input at local midnight in Asia/Tehran", () => {
        const timezone = "Asia/Tehran"
        const actual = parseScheduledDate(timezone, "2026-01-01")
        const expected = canonicalKeyToLocalMidnight("2026-01-01", timezone)

        expect(actual).toEqual(expected)
        expect(getCanonicalDayKey(actual, timezone)).toBe("2026-01-01")
    })

    it("preserves ISO timestamps with offsets as new Date does", () => {
        const value = "2026-01-01T10:00:00+03:30"

        expect(parseScheduledDate("America/New_York", value)).toEqual(new Date(value))
    })

    it("preserves numeric timestamps as new Date does", () => {
        const timestamp = Date.parse("2026-01-01T10:00:00.000Z")

        expect(parseScheduledDate("America/New_York", timestamp)).toEqual(new Date(timestamp))
    })

    it.each(["2026-02-30", "2026-1-1"])("rejects invalid date-only input %s", (value) => {
        const parsed = makeCreateTaskSchema("America/New_York").safeParse({ title, scheduledDate: value })

        expect(parsed.success).toBe(false)
    })
})
