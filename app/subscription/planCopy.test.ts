// تست محتوای نمایشی صفحهٔ اشتراک.
//
// قفل اصلی: سهمیه‌های هوشمندِ نمایش‌داده‌شده باید **همیشه مضربی از سهمیهٔ ماهانه** باشند
// و از `entitlementDays` بیایند — نه اینکه دستی تایپ شوند. اگر کاتالوگ مدت را عوض کند،
// عددِ متن هم خودبه‌خود درست می‌شود.

import { describe, expect, it } from "vitest"

import { BILLING_PRODUCTS } from "@/app/lib/billing/products"
import {
    DAYS_PER_MONTH,
    FREE_PLAN,
    PLAN_COPY,
    PRO_MONTHLY_ANALYZE_UNITS,
    PRO_MONTHLY_PLAN_UNITS,
    faGrouped,
    perDayToman,
    renderFeatureLabel,
    smartQuotaFor,
} from "./planCopy"

describe("subscription plan copy", () => {
    it("free plan is not a purchasable product and stays calm in the UI", () => {
        expect(FREE_PLAN.title).toBe("رایگان")
        expect(FREE_PLAN.subtitle).toBe("همیشه رایگان")
        expect(FREE_PLAN.cta).toBe("شروع کنید")
        expect(BILLING_PRODUCTS.map((product) => product.code)).not.toContain("FREE")
    })

    it("only the three-month plan is featured", () => {
        const featured = BILLING_PRODUCTS.filter(
            (product) => PLAN_COPY[product.code].featured === true,
        ).map((product) => product.code)
        expect(featured).toEqual(["PRO_3M"])
    })

    it("every plan has a CTA label and at least three benefits", () => {
        for (const product of BILLING_PRODUCTS) {
            const copy = PLAN_COPY[product.code]
            expect(copy.title.length).toBeGreaterThan(0)
            expect(copy.cta.length).toBeGreaterThan(0)
            expect(copy.features.length).toBeGreaterThanOrEqual(3)
            for (const feature of copy.features) {
                expect(feature.label.length).toBeGreaterThan(0)
            }
        }
    })

    it("feature labels are unique inside a card (React keys stay stable)", () => {
        for (const product of BILLING_PRODUCTS) {
            const labels = PLAN_COPY[product.code].features.map((feature) => feature.label)
            expect(new Set(labels).size).toBe(labels.length)
        }
    })

    it("never promises a daily task cap the product does not enforce", () => {
        // هیچ لایه‌ای از محصول سقف روزانه‌ی تسک ندارد، پس متن نباید عددی مثل
        // «تا ۱۰ کار در روز» بفروشد؛ نه به‌عنوان محدودیت و نه به‌عنوان مزیت.
        const allLabels = [
            ...FREE_PLAN.features.map((feature) => feature.label),
            ...BILLING_PRODUCTS.flatMap((product) =>
                PLAN_COPY[product.code].features.map((feature) => feature.label),
            ),
        ].join(" ")

        expect(allLabels).not.toMatch(/کار در روز/)
        expect(allLabels).not.toMatch(/نامحدود/)
        expect(allLabels).not.toMatch(/تا \d+ کار/)
    })

    it("duration placeholders come from the catalog, never from hard-coded copy", () => {
        for (const product of BILLING_PRODUCTS) {
            const months = smartQuotaFor(product.entitlementDays).months
            for (const feature of PLAN_COPY[product.code].features) {
                expect(renderFeatureLabel(feature.label, months)).not.toContain("{months}")
            }
        }
    })

    it("renders the real month count into duration wording", () => {
        expect(renderFeatureLabel("در تمام {months} ماه", 2)).toBe("در تمام ۲ ماه")
        expect(renderFeatureLabel("در تمام {months} ماه", 3)).toBe("در تمام ۳ ماه")
        expect(renderFeatureLabel("بدون جایگزین", 2)).toBe("بدون جایگزین")
    })
})

describe("smart quota display", () => {
    it("derives the monthly totals from the entitlement days", () => {
        expect(smartQuotaFor(30)).toEqual({
            months: 1,
            analyze: PRO_MONTHLY_ANALYZE_UNITS,
            plan: PRO_MONTHLY_PLAN_UNITS,
            scopeLabel: "مجموعِ دوره",
        })
        expect(smartQuotaFor(60).months).toBe(2)
        expect(smartQuotaFor(90).months).toBe(3)
    })

    it("always shows whole multiples of the monthly quota", () => {
        for (const product of BILLING_PRODUCTS) {
            const quota = smartQuotaFor(product.entitlementDays)
            expect(quota.analyze % PRO_MONTHLY_ANALYZE_UNITS).toBe(0)
            expect(quota.plan % PRO_MONTHLY_PLAN_UNITS).toBe(0)
            expect(quota.analyze).toBe(PRO_MONTHLY_ANALYZE_UNITS * quota.months)
            expect(quota.plan).toBe(PRO_MONTHLY_PLAN_UNITS * quota.months)
        }
    })

    it("never shows a longer plan for the same money as the monthly one", () => {
        const monthly = BILLING_PRODUCTS.find((product) => product.code === "PRO_1M")
        expect(monthly).toBeDefined()
        for (const product of BILLING_PRODUCTS) {
            if (product.code === "PRO_1M") continue
            expect(product.entitlementDays).toBeGreaterThan(monthly!.entitlementDays)
            expect(product.amount).toBeLessThan(monthly!.amount * smartQuotaFor(product.entitlementDays).months)
        }
    })

    it("guards against a zero or negative duration", () => {
        expect(smartQuotaFor(0).months).toBe(0)
        expect(smartQuotaFor(-10).months).toBe(0)
        expect(perDayToman(350_000, 0)).toBe(0)
        expect(smartQuotaFor(Number.NaN).months).toBe(0)
    })

    it("keeps a month defined as 30 days of entitlement", () => {
        for (const product of BILLING_PRODUCTS) {
            expect(product.entitlementDays % DAYS_PER_MONTH).toBe(0)
        }
    })
})

describe("display helpers", () => {
    it("formats numbers with Persian digits and thousands separators", () => {
        expect(faGrouped(90_000)).toBe("۹۰٬۰۰۰")
        expect(faGrouped(1_500)).toBe("۱٬۵۰۰")
        expect(faGrouped(0)).toBe("۰")
    })

    it("rounds the per-day cost to the nearest hundred toman", () => {
        // ۳۵٬۰۰۰ تومان برای ۳۰ روز
        expect(perDayToman(35_000, 30)).toBe(1_200)
        // ۶۰٬۰۰۰ تومان برای ۶۰ روز
        expect(perDayToman(60_000, 60)).toBe(1_000)
        // ۹۰٬۰۰۰ تومان برای ۹۰ روز
        expect(perDayToman(90_000, 90)).toBe(1_000)
    })
})