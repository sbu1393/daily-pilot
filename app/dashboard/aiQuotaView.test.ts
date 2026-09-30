// AI Quota — تست‌های لایهٔ نمایش (pure)
//
// پروژه DOM test environment ندارد، بنابراین «تصمیمِ متن» از رندر جدا شده و همین‌جا
// تست می‌شود. کامپوننت فقط همین خروجی را رندر می‌کند.
//
// علاوه بر حالت‌ها، این تست‌ها **لحن** را هم قفل می‌کنند: واژه‌هایی مثل «فرصت» یا
// «از دست می‌رود» یا هر نشانهٔ فشار/ gamification نباید هرگز تولید شوند.

import { describe, expect, it } from "vitest"

import {
    describeQuotaDimension,
    LOW_QUOTA_THRESHOLD,
    quotaFeatureLabel,
    quotaTone,
} from "./aiQuotaView"

const dim = (remaining: number, extra: Partial<{ granted: number; promoRemaining: number }> = {}) => ({
    remaining,
    granted: remaining + 6,
    consumed: 6,
    promoRemaining: 0,
    ...extra,
})

describe("quotaFeatureLabel", () => {
    it("برچسب‌ها «هوشمند» دارند و «فرصت» نه", () => {
        expect(quotaFeatureLabel("analyze")).toBe("تحلیل هوشمند")
        expect(quotaFeatureLabel("plan")).toBe("برنامه‌ریزی هوشمند")
    })
})

// ── سهمیهٔ هدیه در نمایش ───────────────────────────────────────────────────────
// regression لایهٔ نمایش برای باگ کاربر: وقتی BASE تمام بوده ولی PROMO باقی مانده،
// نباید «تمام شده» نشان داده شود. ورودی از سرور می‌آید و `remaining` از قبل
// BASE+PROMO است، پس این فقط باید همان عدد را درست ترجمه کند.
describe("describeQuotaDimension — سهمیهٔ هدیه", () => {
    it("BASE تمام ولی PROMO باقی مانده ⇒ exhausted نیست و راهنمای هدیه دیده می‌شود", () => {
        const view = describeQuotaDimension("analyze", {
            remaining: 5, // فقط از بونوس آمده
            granted: 20,
            consumed: 15,
            promoRemaining: 5,
        })

        expect(view.tone).not.toBe("exhausted")
        expect(view.text).not.toMatch(/تمام شده/)
        expect(view.promoHint).toBe("۵ مورد هدیه")
    })

    it("بونوسِ خیلی کم هم «تمام شده» نیست (لحن «کم»، نه exhausted)", () => {
        const view = describeQuotaDimension("analyze", {
            remaining: 1,
            granted: 16,
            consumed: 15,
            promoRemaining: 1,
        })

        expect(view.tone).toBe("low")
        expect(view.text).toBe("۱ تحلیل هوشمند باقی‌مانده")
    })

    it("بونوس تمام‌شده ⇒ exhausted، بدون راهنمای هدیه", () => {
        const view = describeQuotaDimension("analyze", {
            remaining: 0,
            granted: 20,
            consumed: 20,
            promoRemaining: 0,
        })

        expect(view.tone).toBe("exhausted")
        expect(view.text).toBe("سهمیهٔ تحلیل هوشمند این دوره تمام شده است.")
        expect(view.promoHint).toBeUndefined()
    })

    it("بدون PROMO اصلاً راهنمای هدیه نشان داده نمی‌شود", () => {
        const view = describeQuotaDimension("analyze", dim(10, { promoRemaining: 0 }))

        expect(view.promoHint).toBeUndefined()
    })
})

describe("quotaTone", () => {
    it("آستانهٔ لحن درست است", () => {
        expect(quotaTone(0)).toBe("exhausted")
        expect(quotaTone(1)).toBe("low")
        expect(quotaTone(LOW_QUOTA_THRESHOLD)).toBe("low")
        expect(quotaTone(LOW_QUOTA_THRESHOLD + 1)).toBe("normal")
        expect(quotaTone(270)).toBe("normal")
    })

    it("عدد منفی (که نباید رخ دهد) هم exhausted است", () => {
        expect(quotaTone(-1)).toBe("exhausted")
    })
})

describe("describeQuotaDimension — حالت عادی (remaining > 3)", () => {
    it("یک خط کم‌حجم با جداکنندهٔ نقطه", () => {
        const v = describeQuotaDimension("analyze", dim(9))
        expect(v.tone).toBe("normal")
        expect(v.text).toBe("تحلیل هوشمند · ۹ باقی‌مانده")
    })

    it("برنامه‌ریزی هم درست رندر می‌شود", () => {
        expect(describeQuotaDimension("plan", dim(2 + 4)).text).toBe(
            "برنامه‌ریزی هوشمند · ۶ باقی‌مانده",
        )
    })

    it("ارقام فارسی‌اند (۲۷۰ نه 270)", () => {
        expect(describeQuotaDimension("analyze", dim(270, { granted: 270 })).text).toContain("۲۷۰")
    })
})

describe("describeQuotaDimension — حالت کم (remaining ≤ 3)", () => {
    it("۳ باقی‌مانده کمی صریح‌تر نمایش داده می‌شود", () => {
        const v = describeQuotaDimension("analyze", dim(3))
        expect(v.tone).toBe("low")
        expect(v.text).toBe("۳ تحلیل هوشمند باقی‌مانده")
    })

    it("۱ باقی‌مانده هم درست است", () => {
        expect(describeQuotaDimension("plan", dim(1)).text).toBe("۱ برنامه‌ریزی هوشمند باقی‌مانده")
    })

    it("در این حالت هم هیچ لحن فشاری ندارد", () => {
        const v = describeQuotaDimension("analyze", dim(2))
        expect(v.text).not.toMatch(/فرصت|از دست|مصرف کن| hurry|بیشتر استفاده/)
    })
})

describe("describeQuotaDimension — حالت صفر", () => {
    it("پیام واضحِ تمام‌شدن، بدون دعوت به خرید تازه", () => {
        const v = describeQuotaDimension("analyze", dim(0))
        expect(v.tone).toBe("exhausted")
        expect(v.text).toBe("سهمیهٔ تحلیل هوشمند این دوره تمام شده است.")
    })

    it("برای plan هم متن مخصوص خودش را دارد", () => {
        expect(describeQuotaDimension("plan", dim(0)).text).toBe(
            "سهمیهٔ برنامه‌ریزی هوشمند این دوره تمام شده است.",
        )
    })

    it("در حالت صفر هیچ توضیح هدیه‌ای نشان داده نمی‌شود", () => {
        // کاربر همه‌ی هدیه را مصرف کرده ⇒ promoRemaining صفر
        const v = describeQuotaDimension("analyze", dim(0, { promoRemaining: 0 }))
        expect(v.promoHint).toBeUndefined()
    })
})

describe("describeQuotaDimension — هدیهٔ PROMO", () => {
    it("وقتی PROMO باقی مانده، توضیح ظریف اضافه می‌شود", () => {
        const v = describeQuotaDimension("analyze", dim(11, { promoRemaining: 2 }))
        expect(v.promoHint).toBe("۲ مورد هدیه")
    })

    it("هدیه در حالت کم هم دیده می‌شود", () => {
        expect(describeQuotaDimension("analyze", dim(2, { promoRemaining: 1 })).promoHint).toBe(
            "۱ مورد هدیه",
        )
    })

    it("بدون هدیه، هیچ متن اضافه‌ای تولید نمی‌شود", () => {
        expect(describeQuotaDimension("analyze", dim(9, { promoRemaining: 0 })).promoHint).toBeUndefined()
    })

    it("هدیه به سهمیهٔ اصلی چسبانده نمی‌شود (جدا می‌ماند)", () => {
        const v = describeQuotaDimension("analyze", dim(11, { promoRemaining: 2 }))
        // متن اصلی فقط عدد remaining را می‌گوید؛ هدیه جداگانه است.
        expect(v.text).toBe("تحلیل هوشمند · ۱۱ باقی‌مانده")
        expect(v.promoHint).not.toContain("۱۳")
    })
})

describe("describeQuotaDimension — دسترسی‌پذیری", () => {
    it("هر سه حالت ariaLabel کامل و متفاوت دارند (معنی وابسته به رنگ نیست)", () => {
        const normal = describeQuotaDimension("analyze", dim(9))
        const low = describeQuotaDimension("analyze", dim(2))
        const exhausted = describeQuotaDimension("analyze", dim(0))

        expect(normal.ariaLabel).toBe("۹ مورد تحلیل هوشمند برای این دوره باقی مانده است.")
        expect(low.ariaLabel).toBe("۲ مورد تحلیل هوشمند برای این دوره باقی مانده است.")
        expect(exhausted.ariaLabel).toBe("سهمیهٔ تحلیل هوشمند برای این دوره تمام شده است.")

        expect(new Set([normal.ariaLabel, low.ariaLabel, exhausted.ariaLabel]).size).toBe(3)
    })

    it("ariaLabel عدد را با ارقام فارسی می‌گوید", () => {
        expect(describeQuotaDimension("analyze", dim(270, { granted: 270 })).ariaLabel).toContain("۲۷۰")
    })
})

describe("describeQuotaDimension — قفل لحنِ غیرتحریکی", () => {
    const all = [
        describeQuotaDimension("analyze", dim(270)),
        describeQuotaDimension("analyze", dim(3)),
        describeQuotaDimension("analyze", dim(0)),
        describeQuotaDimension("plan", dim(50)),
        describeQuotaDimension("plan", dim(1)),
        describeQuotaDimension("plan", dim(0)),
    ].flatMap((v) => [v.text, v.ariaLabel, v.promoHint ?? ""])

    const forbidden = [
        /فرصت/,
        /از دست (می‌رود|برود)/,
        /قبل از تمام/,
        /استفاده (کن|نکن)/,
        /مصرف کن/,
        /بمان!|بمانید/,
        /!/,
        /🔥|⚡|🎁/,
    ]

    it("هیچ عبارت فشارآور/gamified در هیچ حالتی نیست", () => {
        for (const text of all) {
            for (const pattern of forbidden) {
                expect(text, `متن ممنوع «${pattern}» در: ${text}`).not.toMatch(pattern)
            }
        }
    })

    it("هیچ نشانه‌ای از شمارش معکوس/نوار پیشرفت نیست", () => {
        for (const text of all) {
            expect(text).not.toMatch(/%|روز باقی|ساعت باقی|دقیقه باقی/)
        }
    })
})
