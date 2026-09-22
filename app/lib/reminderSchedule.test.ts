import { describe, expect, it } from "vitest"

import {
    DEFAULT_TIMEZONE,
    REMINDER_DUE_WINDOW_MINUTES,
    isReminderDue,
    localDayKey,
    localTimeHHMM,
    minutesSinceReminder,
    parseHHMM,
} from "./reminderSchedule"

/* ------------------------------------------------------------------ */
/* یادآورها — تست زمان‌بندی سمت سرور (timezone-aware، بدون DB)          */
/*                                                                     */
/* قفل‌شده: روز/ساعت بر مبنای tz کاربر (نه UTC)، مرزهای پنجره‌ی سررسید، */
/* ضد-تکرار روزانه، و رفتار امن با tz/زمان نامعتبر.                     */
/* ------------------------------------------------------------------ */

// ۲۰۲۶-۰۹-۲۲ ۰۵:۳۰ UTC = ۰۹:۰۰ در Asia/Tehran (UTC+3:30، بدون DST)
const TEHRAN_9AM = new Date("2026-09-22T05:30:00.000Z")

describe("parseHHMM", () => {
    it("فقط قالب HH:MM بیست‌وچهارساعتی را می‌پذیرد", () => {
        expect(parseHHMM("09:00")).toBe(540)
        expect(parseHHMM("00:00")).toBe(0)
        expect(parseHHMM("23:59")).toBe(1439)
        expect(parseHHMM("9:00")).toBeNull()
        expect(parseHHMM("24:00")).toBeNull()
        expect(parseHHMM("09:60")).toBeNull()
        expect(parseHHMM("")).toBeNull()
        expect(parseHHMM(null)).toBeNull()
        expect(parseHHMM(undefined)).toBeNull()
    })
})

describe("localDayKey / localTimeHHMM", () => {
    it("ساعت و روز را بر مبنای timezone کاربر حساب می‌کند", () => {
        expect(localTimeHHMM(TEHRAN_9AM, "Asia/Tehran")).toBe("09:00")
        expect(localTimeHHMM(TEHRAN_9AM, "UTC")).toBe("05:30")
        expect(localDayKey(TEHRAN_9AM, "Asia/Tehran")).toBe("2026-09-22")
    })

    it("مرز روز محلی را درست می‌شمارد (نه UTC)", () => {
        // ۲۰:۴۰ UTC = ۰۰:۱۰ روز بعد در تهران
        const nearMidnight = new Date("2026-09-22T20:40:00.000Z")

        expect(localDayKey(nearMidnight, "UTC")).toBe("2026-09-22")
        expect(localDayKey(nearMidnight, "Asia/Tehran")).toBe("2026-09-23")
        expect(localTimeHHMM(nearMidnight, "Asia/Tehran")).toBe("00:10")
    })

    it("نیمه‌شب محلی 00:00 است (نه 24:00)", () => {
        const midnightTehran = new Date("2026-09-21T20:30:00.000Z")

        expect(localTimeHHMM(midnightTehran, "Asia/Tehran")).toBe("00:00")
    })

    it("timezone نامعتبر → fallback به UTC بدون پرتاب خطا", () => {
        expect(localTimeHHMM(TEHRAN_9AM, "Not/AZone")).toBe(localTimeHHMM(TEHRAN_9AM, DEFAULT_TIMEZONE))
        expect(localDayKey(TEHRAN_9AM, "")).toBe("2026-09-22")
        expect(() => isReminderDue({
            now: TEHRAN_9AM,
            timezone: "Invalid/Zone",
            reminderTime: "05:30",
            reminderSentOn: null,
        })).not.toThrow()
    })
})

describe("minutesSinceReminder", () => {
    it("فاصله‌ی دقیقه‌ای تا زمان یادآور در همان tz", () => {
        expect(minutesSinceReminder(TEHRAN_9AM, "Asia/Tehran", "09:00")).toBe(0)
        expect(minutesSinceReminder(TEHRAN_9AM, "Asia/Tehran", "08:45")).toBe(15)
        expect(minutesSinceReminder(TEHRAN_9AM, "Asia/Tehran", "09:30")).toBe(-30)
        expect(minutesSinceReminder(TEHRAN_9AM, "Asia/Tehran", "bad")).toBeNull()
    })
})

describe("isReminderDue", () => {
    const base = {
        now: TEHRAN_9AM,
        timezone: "Asia/Tehran",
        reminderTime: "09:00",
        reminderSentOn: null,
    }

    it("سر ساعت مقرر و داخل پنجره → سررسید", () => {
        expect(isReminderDue(base)).toBe(true)
        expect(
            isReminderDue({ ...base, now: new Date("2026-09-22T05:44:00.000Z") }), // ۰۹:۱۴
        ).toBe(true)
    })

    it("قبل از زمان مقرر یا بعد از پنجره → سررسید نیست", () => {
        expect(
            isReminderDue({ ...base, now: new Date("2026-09-22T05:29:00.000Z") }), // ۰۸:۵۹
        ).toBe(false)
        expect(
            isReminderDue({ ...base, now: new Date("2026-09-22T05:45:00.000Z") }), // ۰۹:۱۵
        ).toBe(false)
    })

    it("پنجره قابل تنظیم است (cron هر ۱۰ دقیقه با پنجره‌ی ۱۵ دقیقه)", () => {
        expect(REMINDER_DUE_WINDOW_MINUTES).toBe(15)
        expect(
            isReminderDue({ ...base, now: new Date("2026-09-22T05:40:00.000Z"), windowMinutes: 5 }),
        ).toBe(false)
    })

    it("اگر امروز برای کاربر ارسال شده باشد → دوباره نمی‌فرستد", () => {
        expect(isReminderDue({ ...base, reminderSentOn: "2026-09-22" })).toBe(false)
        expect(isReminderDue({ ...base, reminderSentOn: "2026-09-21" })).toBe(true)
    })

    it("tz کاربر تعیین‌کننده است، نه UTC", () => {
        // ۰۹:۰۰ تهران = ۰۵:۳۰ UTC → برای کاربر تهران با ۰۹:۰۰ سررسید است، اما
        // برای همان لحظه با یادآور ۰۵:۳۰ (که در UTC «الان» است) در تهران نه.
        expect(isReminderDue({ ...base })).toBe(true)
        expect(isReminderDue({ ...base, reminderTime: "05:30" })).toBe(false)
        expect(
            isReminderDue({
                now: TEHRAN_9AM,
                timezone: "UTC",
                reminderTime: "05:30",
                reminderSentOn: null,
            }),
        ).toBe(true)
    })

    it("زمان نامعتبر → هرگز سررسید نیست", () => {
        expect(isReminderDue({ ...base, reminderTime: "" })).toBe(false)
        expect(isReminderDue({ ...base, reminderTime: "25:00" })).toBe(false)
    })
})
