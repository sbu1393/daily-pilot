import { describe, expect, it } from "vitest"

/*
 * سیاست مشترک بی‌فعالیتی / بازگشت — تست‌های خالص
 * ---------------------------------------------------------------
 * این تست‌ها قرارداد عددی و مرزهای زمانی را قفل می‌کنند؛ تغییر ناخواسته در
 * آستانه‌ها یا پنجرهٔ سکوت باید تست را بشکند.
 */

import {
    INACTIVITY_DAYS,
    REENGAGEMENT_COOLDOWN_DAYS,
    REENGAGEMENT_OVERDUE_QUIET_HOURS,
    inactivityCutoff,
    isDormant,
    overdueQuietCutoff,
    reengagementCooldownCutoff,
} from "./inactivityPolicy"

// ۲۰۲۶-۱۱-۰۶ ۰۶:۳۰ UTC = ۱۰:۰۰ تهران
const NOW = new Date("2026-11-06T06:30:00.000Z")

describe("inactivityPolicy", () => {
    it("آستانه‌ها دقیقاً ۳ روز، ۷ روز و ۲۴ ساعت هستند", () => {
        expect(INACTIVITY_DAYS).toBe(3)
        expect(REENGAGEMENT_COOLDOWN_DAYS).toBe(7)
        expect(REENGAGEMENT_OVERDUE_QUIET_HOURS).toBe(24)
    })

    it("cutoff بی‌فعالیتی = ۷۲ ساعت قبل", () => {
        expect(inactivityCutoff(NOW).toISOString()).toBe("2026-11-03T06:30:00.000Z")
    })

    it("cutoff cool-down بازگشت = ۷ روز قبل", () => {
        expect(reengagementCooldownCutoff(NOW).toISOString()).toBe(
            "2026-10-30T06:30:00.000Z",
        )
    })

    it("cutoff سکوت overdue = ۲۴ ساعت قبل", () => {
        expect(overdueQuietCutoff(NOW).toISOString()).toBe("2026-11-05T06:30:00.000Z")
    })

    it("کاربر null خواب‌آلود است", () => {
        expect(isDormant(null, NOW)).toBe(true)
    })

    it("مرز سه روز شامل خود cutoff است (<=)", () => {
        expect(isDormant(new Date("2026-11-03T06:30:00.000Z"), NOW)).toBe(true)
        expect(isDormant(new Date("2026-11-03T06:30:00.001Z"), NOW)).toBe(false)
    })

    it("کاربر با فعالیت اخیر خواب‌آلود نیست", () => {
        expect(isDormant(new Date("2026-11-05T00:00:00.000Z"), NOW)).toBe(false)
    })
})
