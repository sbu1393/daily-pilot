import { describe, expect, it } from "vitest"
import { isValidCanonicalDayKey } from "./canonicalDay"

/* ------------------------------------------------------------------ */
/* M10 (audit) — اعتبارسنجی سخت‌گیرانه‌ی dayKey ورودی: قالب + تقویم.     */
/* چرا round-trip لازم است: Date.UTC(2026, 1, 30) را بی‌صدا به ۲ مارس   */
/* نرمالایز می‌کند، پس «2026-02-30» با رجکس تنها قابل تشخیص نیست.       */
/* ------------------------------------------------------------------ */

describe("isValidCanonicalDayKey (M10)", () => {
    it("accepts real calendar days", () => {
        expect(isValidCanonicalDayKey("2026-01-01")).toBe(true)
        expect(isValidCanonicalDayKey("2026-12-31")).toBe(true)
        expect(isValidCanonicalDayKey("2028-02-29")).toBe(true) // سال کبیسه
        expect(isValidCanonicalDayKey("2026-11-30")).toBe(true)
    })

    it("rejects malformed formats", () => {
        expect(isValidCanonicalDayKey("")).toBe(false)
        expect(isValidCanonicalDayKey("2026-1-1")).toBe(false)
        expect(isValidCanonicalDayKey("01-01-2026")).toBe(false)
        expect(isValidCanonicalDayKey("2026/01/01")).toBe(false)
        expect(isValidCanonicalDayKey("2026-01-01T00:00:00Z")).toBe(false)
        expect(isValidCanonicalDayKey("2026-01-01 ")).toBe(false)
    })

    it("rejects calendar-impossible days that Date would silently normalize", () => {
        expect(isValidCanonicalDayKey("2026-02-30")).toBe(false)
        expect(isValidCanonicalDayKey("2026-02-29")).toBe(false) // ۲۰۲۶ کبیسه نیست
        expect(isValidCanonicalDayKey("2026-04-31")).toBe(false)
        expect(isValidCanonicalDayKey("2026-06-31")).toBe(false)
        expect(isValidCanonicalDayKey("2026-13-99")).toBe(false)
        expect(isValidCanonicalDayKey("2026-00-10")).toBe(false)
        expect(isValidCanonicalDayKey("2026-01-00")).toBe(false)
    })

    it("rejects years Date.UTC would reinterpret (0–99 → 19xx)", () => {
        expect(isValidCanonicalDayKey("0026-01-01")).toBe(false)
        expect(isValidCanonicalDayKey("0099-12-31")).toBe(false)
    })
})
