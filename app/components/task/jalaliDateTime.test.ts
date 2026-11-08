import { describe, expect, it } from "vitest"

import { fromDateTimeLocalValue, toDateTimeLocalValue } from "@/app/lib/taskTime"
import {
    daysInJalaliMonth,
    datetimeLocalValueToJalaliDateTimeParts,
    epochMsToJalaliDateTimeParts,
    jalaliDateTimePartsToDatetimeLocalValue,
} from "./jalaliDateTime"

/*
 * انتخاب‌گر تاریخ/ساعت شمسی آلارم — تست منطق خالص.
 *
 * قرارداد مهم: خروجی همین توابع همان `YYYY-MM-DDTHH:mm` میلادی و «وقت محلی
 * دستگاه» است که `fromDateTimeLocalValue` می‌خواند؛ پس epoch ذخیره‌شده نباید
 * نسبت به مسیر قبلی `<input type="datetime-local">` تغییر کند.
 */

describe("jalaliDateTime — رفت و برگشت شمسی ↔ datetime-local", () => {
    it("۲۰۲۶-۰۹-۲۱ ۱۴:۳۰ = ۱۴۰۵/۰۶/۳۰ ۱۴:۳۰", () => {
        expect(datetimeLocalValueToJalaliDateTimeParts("2026-09-21T14:30")).toEqual({
            year: 1405,
            month: 6,
            day: 30,
            hour: 14,
            minute: 30,
        })

        expect(
            jalaliDateTimePartsToDatetimeLocalValue({
                year: 1405,
                month: 6,
                day: 30,
                hour: 14,
                minute: 30,
            }),
        ).toBe("2026-09-21T14:30")
    })

    it("مقدار نیمه‌شب دقیقاً حفظ می‌شود (بدون لغزش به روز قبل/بعد)", () => {
        const value = jalaliDateTimePartsToDatetimeLocalValue({
            year: 1405,
            month: 7,
            day: 1,
            hour: 0,
            minute: 0,
        })

        expect(value).toBe("2026-09-23T00:00")
        expect(datetimeLocalValueToJalaliDateTimeParts(value!)).toEqual({
            year: 1405,
            month: 7,
            day: 1,
            hour: 0,
            minute: 0,
        })
        expect(fromDateTimeLocalValue(value!)).toBe(new Date(2026, 8, 23, 0, 0).getTime())
    })

    it("مقدار ذخیره‌شده (epoch) با مسیر قبلی یکسان است", () => {
        const value = jalaliDateTimePartsToDatetimeLocalValue({
            year: 1405,
            month: 6,
            day: 30,
            hour: 14,
            minute: 30,
        })

        expect(fromDateTimeLocalValue(value!)).toBe(new Date(2026, 8, 21, 14, 30).getTime())
        // همان قرارداد رفت‌وبرگشت epoch → مقدار ورودی
        expect(toDateTimeLocalValue(new Date(2026, 8, 21, 14, 30).getTime())).toBe(value)
    })
})

describe("jalaliDateTime — انتهای ماه و تغییر ماه", () => {
    it("۳۱ شهریور معتبر است و به ۲۰۲۶-۰۹-۲۲ نگاشت می‌شود", () => {
        expect(daysInJalaliMonth(1405, 6)).toBe(31)
        expect(
            jalaliDateTimePartsToDatetimeLocalValue({
                year: 1405,
                month: 6,
                day: 31,
                hour: 9,
                minute: 5,
            }),
        ).toBe("2026-09-22T09:05")
    })

    it("روز اول ماه بعد درست تبدیل می‌شود (مرز ماه)", () => {
        expect(daysInJalaliMonth(1405, 7)).toBe(30)
        expect(
            jalaliDateTimePartsToDatetimeLocalValue({
                year: 1405,
                month: 7,
                day: 1,
                hour: 9,
                minute: 5,
            }),
        ).toBe("2026-09-23T09:05")
    })

    it("مرز پایان سال شمسی", () => {
        expect(
            jalaliDateTimePartsToDatetimeLocalValue({
                year: 1405,
                month: 12,
                day: 29,
                hour: 23,
                minute: 59,
            }),
        ).toBe("2027-03-20T23:59")

        expect(
            jalaliDateTimePartsToDatetimeLocalValue({
                year: 1406,
                month: 1,
                day: 1,
                hour: 0,
                minute: 0,
            }),
        ).toBe("2027-03-21T00:00")
    })
})

describe("jalaliDateTime — سال کبیسه", () => {
    it("۱۴۰۳ کبیسه است: اسفند ۳۰ روز و ۱۴۰۳/۱۲/۳۰ معتبر", () => {
        expect(daysInJalaliMonth(1403, 12)).toBe(30)
        expect(
            jalaliDateTimePartsToDatetimeLocalValue({
                year: 1403,
                month: 12,
                day: 30,
                hour: 12,
                minute: 0,
            }),
        ).toBe("2025-03-20T12:00")
    })

    it("۱۴۰۴ کبیسه نیست: اسفند ۲۹ روز و ۱۴۰۴/۱۲/۳۰ نامعتبر", () => {
        expect(daysInJalaliMonth(1404, 12)).toBe(29)
        expect(
            jalaliDateTimePartsToDatetimeLocalValue({
                year: 1404,
                month: 12,
                day: 30,
                hour: 12,
                minute: 0,
            }),
        ).toBeNull()
    })
})

describe("jalaliDateTime — ورودی نامعتبر", () => {
    it("مقدار خالی/بدشکل/ساعت و دقیقه‌ی خارج از محدوده → null", () => {
        expect(datetimeLocalValueToJalaliDateTimeParts("")).toBeNull()
        expect(datetimeLocalValueToJalaliDateTimeParts("nonsense")).toBeNull()
        expect(datetimeLocalValueToJalaliDateTimeParts("2026-09-21")).toBeNull()
        expect(datetimeLocalValueToJalaliDateTimeParts("2026-09-21T24:00")).toBeNull()
        expect(datetimeLocalValueToJalaliDateTimeParts("2026-09-21T10:60")).toBeNull()
        expect(datetimeLocalValueToJalaliDateTimeParts("2026-02-30T10:00")).toBeNull()
    })

    it("اجزای شمسی نامعتبر → null", () => {
        expect(
            jalaliDateTimePartsToDatetimeLocalValue({
                year: 1405,
                month: 13,
                day: 1,
                hour: 10,
                minute: 0,
            }),
        ).toBeNull()

        expect(
            jalaliDateTimePartsToDatetimeLocalValue({
                year: 1405,
                month: 6,
                day: 0,
                hour: 10,
                minute: 0,
            }),
        ).toBeNull()

        expect(
            jalaliDateTimePartsToDatetimeLocalValue({
                year: 1405,
                month: 6,
                day: 31,
                hour: 24,
                minute: 0,
            }),
        ).toBeNull()

        expect(
            jalaliDateTimePartsToDatetimeLocalValue({
                year: 1405,
                month: 6,
                day: 31,
                hour: 10,
                minute: 60,
            }),
        ).toBeNull()

        expect(
            jalaliDateTimePartsToDatetimeLocalValue({
                year: 1405,
                month: 7,
                day: 31,
                hour: 10,
                minute: 0,
            }),
        ).toBeNull()
    })
})

describe("jalaliDateTime — epoch → اجزا", () => {
    it("لحظه‌ی epoch با نیمه‌شب محلی به همان روز شمسی می‌رسد", () => {
        const parts = epochMsToJalaliDateTimeParts(new Date(2026, 8, 21, 0, 0).getTime())

        expect(parts).toEqual({ year: 1405, month: 6, day: 30, hour: 0, minute: 0 })
    })
})
