import { describe, expect, it } from "vitest"

import {
    formatReminderRelative,
    formatReminderTime,
    fromDateTimeLocalValue,
    toDateTimeLocalValue,
} from "./taskTime"
import { getCanonicalDayKey } from "./canonicalDay"

/*
 * تاریخ/ساعت مشترک تسک — تست منطق خالص (بدون DOM/React).
 *
 * این تست‌ها همان قراردادهایی را قفل می‌کنند که آلارم تسک برای نمایش زمان و
 * خواندن/نوشتن <input type="datetime-local"> به آن‌ها تکیه می‌کند.
 */

const TZ = "Asia/Tehran"

describe("datetime-local — رفت و برگشت", () => {
    it("epoch → مقدار ورودی → همان epoch (بدون از دست دادن دقت دقیقه)", () => {
        const base = new Date(2026, 8, 21, 14, 30, 0, 0).getTime()

        const value = toDateTimeLocalValue(base)

        expect(value).toBe("2026-09-21T14:30")
        expect(fromDateTimeLocalValue(value)).toBe(base)
    })

    it("مقدار خالی یا نامعتبر → null", () => {
        expect(fromDateTimeLocalValue("")).toBeNull()
        expect(fromDateTimeLocalValue("   ")).toBeNull()
        expect(fromDateTimeLocalValue("nonsense")).toBeNull()
    })
})

describe("formatReminderTime — برچسب فارسی", () => {
    /*
     * نکته‌ی مهم: این testها به timezone ماشین اجرا وابسته نیستند.
     * لحظه‌ها با UTC ثابت تعریف می‌شوند و انتظار با timezone تهران حساب شده —
     * یعنی دقیقاً همان چیزی که تضمین می‌کنیم: timezone صریح، نه ساعت محلی سرور.
     */

    // ۱۰:۰۰ تهران، ۳۰ شهریور ۱۴۰۵
    const now = Date.parse("2026-09-21T06:30:00Z")

    it("همان روز → «امروز HH:MM» با ارقام فارسی", () => {
        const due = Date.parse("2026-09-21T11:00:00Z") // ۱۴:۳۰ تهران

        expect(formatReminderTime(due, TZ, now)).toBe("امروز ۱۴:۳۰")
    })

    it("روز بعد → «فردا HH:MM»", () => {
        const due = Date.parse("2026-09-22T05:35:00Z") // ۰۹:۰۵ تهران

        expect(formatReminderTime(due, TZ, now)).toBe("فردا ۰۹:۰۵")
    })

    it("روز قبل → «دیروز HH:MM»", () => {
        const due = Date.parse("2026-09-20T16:45:00Z") // ۲۰:۱۵ تهران

        expect(formatReminderTime(due, TZ, now)).toBe("دیروز ۲۰:۱۵")
    })

    it("روز دورتر → تاریخ جلالی + ساعت", () => {
        const due = Date.parse("2026-10-02T05:30:00Z") // ۰۹:۰۰ تهران → ۱۴۰۵/۰۷/۱۰
        const label = formatReminderTime(due, TZ, now)

        expect(label).toContain("۰۹:۰۰")
        expect(label).toContain("۱۴۰۵/۰۷/۱۰")
    })

    it("مرجع روز از timezone می‌آید (نه از ساعت محلی سرور)", () => {
        // 2026-09-21T20:45Z = ۱۴۰۵/۰۶/۳۱ ۰۰:۱۵ تهران (روز بعد) ولی همچنان ۲۱ سپتامبر در UTC
        const due = Date.parse("2026-09-21T20:45:00Z")
        const utcKey = getCanonicalDayKey(new Date(due), "UTC")

        expect(utcKey).toBe("2026-09-21")
        // در تهران این لحظه «امروز» است چون now هم تهران است
        expect(formatReminderTime(due, TZ, due)).toBe("امروز ۰۰:۱۵")
    })
})

describe("formatReminderRelative", () => {
    const now = 1_000_000_000_000

    it("دقایق / ساعت / روز", () => {
        expect(formatReminderRelative(now + 12 * 60_000, now)).toBe("۱۲ دقیقه دیگر")
        expect(formatReminderRelative(now + 2 * 60 * 60_000, now)).toBe("۲ ساعت دیگر")
        expect(formatReminderRelative(now + 3 * 24 * 60 * 60_000, now)).toBe("۳ روز دیگر")
    })

    it("کمتر از یک دقیقه و زمان گذشته", () => {
        expect(formatReminderRelative(now + 30_000, now)).toBe("کمتر از یک دقیقه دیگر")
        expect(formatReminderRelative(now - 1, now)).toBe("گذشت")
    })
})
