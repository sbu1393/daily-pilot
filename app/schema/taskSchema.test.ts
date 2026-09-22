import { describe, expect, it } from "vitest"
import { canonicalKeyToLocalMidnight, getCanonicalDayKey } from "@/app/lib/canonicalDay"
import { makeCreateTaskSchema, makeUpdateTaskSchema } from "./taskSchema"

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

describe("taskSchema reminderAt", () => {
    const timezone = "Asia/Tehran"
    const scheduledDate = "2026-01-01"

    it("accepts a task without a reminder", () => {
        const parsed = makeCreateTaskSchema(timezone).safeParse({ title, scheduledDate })

        expect(parsed.success).toBe(true)
        if (parsed.success) expect(parsed.data.reminderAt).toBeUndefined()
    })

    it("accepts an explicit null reminder (no reminder / cleared)", () => {
        const parsed = makeCreateTaskSchema(timezone).safeParse({ title, scheduledDate, reminderAt: null })

        expect(parsed.success).toBe(true)
        if (parsed.success) expect(parsed.data.reminderAt).toBeNull()
    })

    it("converts an ISO instant with offset into a Date", () => {
        const value = "2026-01-01T14:30:00+03:30"
        const parsed = makeCreateTaskSchema(timezone).safeParse({ title, scheduledDate, reminderAt: value })

        expect(parsed.success).toBe(true)
        if (parsed.success) expect(parsed.data.reminderAt).toEqual(new Date(value))
    })

    it("converts a numeric timestamp into a Date", () => {
        const timestamp = Date.parse("2026-01-01T10:00:00.000Z")
        const parsed = makeCreateTaskSchema(timezone).safeParse({ title, scheduledDate, reminderAt: timestamp })

        expect(parsed.success).toBe(true)
        if (parsed.success) expect(parsed.data.reminderAt).toEqual(new Date(timestamp))
    })

    it.each(["not-a-date", "2026-01-01", "۱۴۰۵/۰۶/۳۱"])("rejects invalid reminder input %s", (value) => {
        const parsed = makeCreateTaskSchema(timezone).safeParse({ title, scheduledDate, reminderAt: value })

        expect(parsed.success).toBe(false)
    })

    it("allows a reminder-only update (no other field required)", () => {
        const parsed = makeUpdateTaskSchema(timezone).safeParse({ reminderAt: "2026-01-01T14:30:00+03:30" })

        expect(parsed.success).toBe(true)
    })

    it("allows clearing the reminder via null on update", () => {
        const parsed = makeUpdateTaskSchema(timezone).safeParse({ reminderAt: null })

        expect(parsed.success).toBe(true)
        if (parsed.success) expect(parsed.data.reminderAt).toBeNull()
    })

    it("still rejects an empty update object", () => {
        const parsed = makeUpdateTaskSchema(timezone).safeParse({})

        expect(parsed.success).toBe(false)
    })
})
