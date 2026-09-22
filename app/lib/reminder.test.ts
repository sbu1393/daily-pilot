import { describe, expect, it } from "vitest"
import {
    formatJalaliDateLong,
    formatPersianClock,
    formatReminderLabel,
    getLocalReminderParts,
    reminderInstantFromLocal,
} from "./reminder"
import { canonicalKeyToLocalMidnight } from "./canonicalDay"

const TZ = "Asia/Tehran" // UTC+3:30، بدون DST

describe("reminderInstantFromLocal (Jalali UI → instant)", () => {
    it("maps 14:30 local on a canonical day to the correct UTC instant", () => {
        const instant = reminderInstantFromLocal("2026-03-05", 14, 30, TZ)
        // نیمه‌شب محلی = 2026-03-04T20:30Z؛ +14:30 → 2026-03-05T11:00Z
        expect(instant.toISOString()).toBe("2026-03-05T11:00:00.000Z")
    })

    it("equals local midnight for 00:00", () => {
        const instant = reminderInstantFromLocal("2026-03-05", 0, 0, TZ)
        expect(instant).toEqual(canonicalKeyToLocalMidnight("2026-03-05", TZ))
    })

    it.each([
        [0, 0],
        [12, 0],
        [23, 59],
    ])("round-trips boundary time %i:%i through the user timezone", (hour, minute) => {
        const instant = reminderInstantFromLocal("2026-03-05", hour, minute, TZ)
        const parts = getLocalReminderParts(instant.toISOString(), TZ)

        expect(parts).toEqual({ canonicalKey: "2026-03-05", hour, minute })
    })

    it("does not shift the clock due to browser timezone (fixed by explicit timezone)", () => {
        // همان ورودی، صرف‌نظر از timezone سیستم، باید همان instant را بدهد
        const a = reminderInstantFromLocal("2026-03-05", 12, 0, TZ).toISOString()
        const b = reminderInstantFromLocal("2026-03-05", 12, 0, TZ).toISOString()
        expect(a).toBe(b)
        expect(getLocalReminderParts(a, TZ)).toEqual({ canonicalKey: "2026-03-05", hour: 12, minute: 0 })
    })
})

describe("Persian formatting", () => {
    it("formats a 24-hour clock with Persian digits (no AM/PM)", () => {
        expect(formatPersianClock(14, 30)).toBe("۱۴:۳۰")
        expect(formatPersianClock(0, 0)).toBe("۰۰:۰۰")
        expect(formatPersianClock(23, 59)).toBe("۲۳:۵۹")
        expect(formatPersianClock(9, 5)).toBe("۰۹:۰۵")
    })

    it("formats a canonical day as a long Jalali date with Persian digits", () => {
        // 2026-03-05 میلادی = ۱۴ اسفند ۱۴۰۴
        expect(formatJalaliDateLong("2026-03-05")).toBe("۱۴ اسفند ۱۴۰۴")
    })

    it("composes the full reminder label", () => {
        expect(formatReminderLabel("2026-03-05T11:00:00.000Z", TZ)).toBe("۱۴ اسفند ۱۴۰۴ ساعت ۱۴:۳۰")
    })

    it("returns null for empty/invalid instants", () => {
        expect(formatReminderLabel(null, TZ)).toBeNull()
        expect(formatReminderLabel("", TZ)).toBeNull()
        expect(formatJalaliDateLong("")).toBe("")
    })
})
