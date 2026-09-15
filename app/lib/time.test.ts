import { describe, expect, it } from "vitest"

/* ------------------------------------------------------------------ */
/* C6 — Time Tracking input parsing (§5.4.1 «Validate duration»).      */
/* قرارداد: عدد صحیح ۱ تا ۶۰۰ دقیقه — همان مرزهای completeTaskSchema   */
/* سمت سرور؛ ورودی نامعتبر هرگز به API نمی‌رسد.                        */
/* ------------------------------------------------------------------ */

import {
    SPENT_MINUTES_MAX,
    SPENT_MINUTES_MIN,
    faDigits,
    faRelativeTime,
    fmtMinutes,
    parseSpentMinutes,
} from "./time"

describe("parseSpentMinutes (C6 — §5.4.1 Validate duration)", () => {
    it("accepts a plain integer within 1..600", () => {
        expect(parseSpentMinutes("45")).toEqual({ ok: true, value: 45 })
        expect(parseSpentMinutes("1")).toEqual({ ok: true, value: 1 })
        expect(parseSpentMinutes("600")).toEqual({ ok: true, value: 600 })
    })

    it("accepts surrounding whitespace and plus/minus-free numerics only", () => {
        expect(parseSpentMinutes("  30  ")).toEqual({ ok: true, value: 30 })
    })

    it("rejects an empty input", () => {
        expect(parseSpentMinutes("")).toEqual({ ok: false, error: "مدت را وارد کنید" })
        expect(parseSpentMinutes("   ")).toEqual({ ok: false, error: "مدت را وارد کنید" })
    })

    it("rejects non-numeric and decimal input (integer-only contract)", () => {
        expect(parseSpentMinutes("abc")).toEqual({ ok: false, error: "مدت باید عدد صحیح باشد" })
        expect(parseSpentMinutes("45.5")).toEqual({ ok: false, error: "مدت باید عدد صحیح باشد" })
    })

    it("rejects values below the 1-minute floor", () => {
        const out = parseSpentMinutes("0")
        expect(out.ok).toBe(false)
        if (!out.ok) expect(out.error).toContain("حداقل")
    })

    it("rejects values above the 600-minute server contract", () => {
        const out = parseSpentMinutes("601")
        expect(out.ok).toBe(false)
        if (!out.ok) expect(out.error).toContain(faDigits(SPENT_MINUTES_MAX))
    })

    it("renders visible limit numbers in the error messages as Persian digits (UI-only presentation)", () => {
        const below = parseSpentMinutes("0")
        expect(below.ok).toBe(false)
        if (!below.ok) {
            expect(below.error).toContain(faDigits(SPENT_MINUTES_MIN)) // «۱»
            expect(below.error).not.toMatch(/[0-9]/) // هیچ رقم لاتین قابل مشاهده نباشد
        }

        const above = parseSpentMinutes("601")
        expect(above.ok).toBe(false)
        if (!above.ok) {
            expect(above.error).toContain(faDigits(SPENT_MINUTES_MAX)) // «۶۰۰»
            expect(above.error).not.toMatch(/[0-9]/)
        }
    })

    it("exposes the same boundaries as the server schema (1..600)", () => {
        expect(SPENT_MINUTES_MIN).toBe(1)
        expect(SPENT_MINUTES_MAX).toBe(600)
    })
})

describe("C6 — existing time formatting helpers keep their contract", () => {
    it("faDigits converts Latin digits to Persian", () => {
        expect(faDigits("45")).toBe("۴۵")
        expect(faDigits(90)).toBe("۹۰")
    })

    it("fmtMinutes renders minutes and hours", () => {
        expect(fmtMinutes(45)).toBe("۴۵ دقیقه")
        expect(fmtMinutes(90)).toBe("۱ ساعت و ۳۰ دقیقه")
        expect(fmtMinutes(120)).toBe("۲ ساعت")
    })

    it("faRelativeTime renders recent-relative buckets", () => {
        const now = Date.now()
        expect(faRelativeTime(now - 5 * 60_000)).toBe("۵ دقیقه پیش")
        expect(faRelativeTime(now - 3 * 3_600_000)).toBe("۳ ساعت پیش")
    })
})
