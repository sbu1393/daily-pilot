import { describe, expect, it } from "vitest"

import { DEFAULT_TIMEZONE, TIMEZONE_OPTIONS, timezoneOptionsWith } from "./timezones"
import { isValidTimezone } from "@/app/schema/formSchema"

describe("timezones — فهرست سلکتور", () => {
    it("Asia/Tehran پیش‌فرض است و در فهرست وجود دارد", () => {
        expect(DEFAULT_TIMEZONE).toBe("Asia/Tehran")
        expect(TIMEZONE_OPTIONS.some((option) => option.value === DEFAULT_TIMEZONE)).toBe(true)
    })

    it("همهٔ گزینه‌ها منطقه زمانی معتبر IANA هستند", () => {
        for (const option of TIMEZONE_OPTIONS) {
            expect(isValidTimezone(option.value), option.value).toBe(true)
        }
    })

    it("مقدار فعلیِ خارج از فهرست به‌صورت «(فعلی)» در ابتدا اضافه می‌شود", () => {
        const options = timezoneOptionsWith("Pacific/Auckland")

        expect(options[0]).toEqual({ value: "Pacific/Auckland", label: "Pacific/Auckland (فعلی)" })
        expect(options.filter((option) => option.value === "Pacific/Auckland")).toHaveLength(1)
    })

    it("مقدار فعلیِ داخل فهرست تکرار نمی‌شود", () => {
        const options = timezoneOptionsWith("Asia/Tehran")

        expect(options.filter((option) => option.value === "Asia/Tehran")).toHaveLength(1)
        expect(options).toEqual([...TIMEZONE_OPTIONS])
    })

    it("بدون مقدار فعلی، همان فهرست پایه برمی‌گردد", () => {
        expect(timezoneOptionsWith(null)).toEqual([...TIMEZONE_OPTIONS])
        expect(timezoneOptionsWith("   ")).toEqual([...TIMEZONE_OPTIONS])
    })
})
