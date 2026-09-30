import { describe, expect, it } from "vitest"
import { canonicalKeyToLocalMidnight, getCanonicalDayKey } from "@/app/lib/canonicalDay"
import { TASK_TITLE_MAX_LENGTH, TASK_TITLE_TOO_LONG_MESSAGE } from "@/app/lib/taskTitle"
import { makeCreateTaskSchema, makeUpdateTaskSchema } from "./taskSchema"

const title = "تسک آزمایشی"
// دسته در قرارداد create اجباری است؛ این تست‌ها فقط scheduledDate را می‌سنجند
const category = "work"

function parseScheduledDate(timezone: string, scheduledDate: unknown) {
    const parsed = makeCreateTaskSchema(timezone).safeParse({ title, scheduledDate, category })
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
        const parsed = makeCreateTaskSchema("America/New_York").safeParse({
            title,
            scheduledDate: value,
            category,
        })

        expect(parsed.success).toBe(false)
    })
})

describe("taskSchema title length limit", () => {
    const timezone = "Asia/Tehran"
    const scheduledDate = "2026-01-01"
    const at = (n: number) => "ا".repeat(n)

    it("create: accepts 29 characters", () => {
        expect(
            makeCreateTaskSchema(timezone).safeParse({ title: at(29), scheduledDate, category }).success,
        ).toBe(true)
    })

    it("create: accepts exactly the limit (30 characters)", () => {
        expect(
            makeCreateTaskSchema(timezone).safeParse({ title: at(TASK_TITLE_MAX_LENGTH), scheduledDate, category }).success,
        ).toBe(true)
    })

    it("create: rejects one character over the limit (31 characters) with the Persian message", () => {
        const parsed = makeCreateTaskSchema(timezone).safeParse({
            title: at(TASK_TITLE_MAX_LENGTH + 1),
            scheduledDate,
            category,
        })
        expect(parsed.success).toBe(false)
        if (!parsed.success) {
            expect(parsed.error.issues.map((i) => i.message)).toContain(TASK_TITLE_TOO_LONG_MESSAGE)
        }
    })

    it("update: accepts exactly the limit (30 characters)", () => {
        expect(makeUpdateTaskSchema(timezone).safeParse({ title: at(TASK_TITLE_MAX_LENGTH) }).success).toBe(true)
    })

    it("update: rejects one character over the limit (31 characters)", () => {
        expect(makeUpdateTaskSchema(timezone).safeParse({ title: at(TASK_TITLE_MAX_LENGTH + 1) }).success).toBe(false)
    })

    it("update: accepts a body without a title (legacy long title edited via category only)", () => {
        expect(makeUpdateTaskSchema(timezone).safeParse({ category: "work" }).success).toBe(true)
    })
})
