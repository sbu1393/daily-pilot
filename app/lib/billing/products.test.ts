// تست کاتالوگ محصولات بیلینگ — منبع حقیقت قیمت/مدت.
//
// این تست عمداً «سخت‌گیر» است: قیمت‌هایی را که محصول باید بفروشد قفل می‌کند تا یک ویرایش
// اشتباه (مثلاً ریال/تومان جابه‌جایی یا درصد تخفیف غلط) بی‌سروصدا از تست‌ها رد نشود.

import { describe, expect, it } from "vitest"

import {
    BILLING_CURRENCY,
    BILLING_PRODUCTS,
    BILLING_PRODUCT_CATALOG,
    PRODUCT_CODES,
    RIAL_PER_TOMAN,
    findProduct,
    getProduct,
    isProductCode,
    tomanFromRial,
    type ProductCode,
} from "./products"

describe("billing product catalog", () => {
    it("contains exactly the three approved products", () => {
        expect(PRODUCT_CODES).toEqual(["PRO_1M", "PRO_2M", "PRO_3M"])
        expect(Object.keys(BILLING_PRODUCT_CATALOG).sort()).toEqual(
            ["PRO_1M", "PRO_2M", "PRO_3M"].sort(),
        )
        expect(BILLING_PRODUCTS.map((product) => product.code)).toEqual([
            "PRO_1M",
            "PRO_2M",
            "PRO_3M",
        ])
    })

    it("uses Rial only — the gateway currency never changes and no conversion happens server-side", () => {
        expect(BILLING_CURRENCY).toBe("IRR")
        for (const product of BILLING_PRODUCTS) {
            // هر مبلغ یک عدد صحیح ریالی است؛ adapter فقط IRR را می‌پذیرد.
            expect(Number.isSafeInteger(product.amount)).toBe(true)
            expect(product.amount % 1000).toBe(0)
        }
    })

    it("PRO_1M is 30 days for 350,000 IRR", () => {
        expect(BILLING_PRODUCT_CATALOG.PRO_1M).toEqual({
            code: "PRO_1M",
            baseAmount: 500_000,
            discountPercent: 30,
            amount: 350_000,
            entitlementDays: 30,
        })
    })

    it("PRO_2M is 60 days for 600,000 IRR", () => {
        expect(BILLING_PRODUCT_CATALOG.PRO_2M).toEqual({
            code: "PRO_2M",
            baseAmount: 1_000_000,
            discountPercent: 40,
            amount: 600_000,
            entitlementDays: 60,
        })
    })

    it("PRO_3M is 90 days for 900,000 IRR", () => {
        expect(BILLING_PRODUCT_CATALOG.PRO_3M).toEqual({
            code: "PRO_3M",
            baseAmount: 1_500_000,
            discountPercent: 40,
            amount: 900_000,
            entitlementDays: 90,
        })
    })

    it("baseAmount / discountPercent / amount are mutually consistent", () => {
        for (const product of BILLING_PRODUCTS) {
            const expected = Math.round(
                (product.baseAmount * (100 - product.discountPercent)) / 100,
            )
            expect(product.amount).toBe(expected)
            expect(product.amount).toBeLessThan(product.baseAmount)
            expect(product.discountPercent).toBeGreaterThan(0)
            expect(product.discountPercent).toBeLessThan(100)
        }
    })

    it("durations are the 30/60/90 day ladder and are strictly increasing with price", () => {
        expect(BILLING_PRODUCTS.map((product) => product.entitlementDays)).toEqual([
            30, 60, 90,
        ])
        const amounts = BILLING_PRODUCTS.map((product) => product.amount)
        expect(amounts).toEqual([...amounts].sort((a, b) => a - b))
        // بیشتر از یک سال نمی‌فروشیم (سقف مدت دسترسی)
        for (const product of BILLING_PRODUCTS) {
            expect(product.entitlementDays).toBeLessThanOrEqual(365)
            expect(product.entitlementDays % 30).toBe(0)
        }
    })

    it("the catalog is frozen — nothing can rewrite a price at runtime", () => {
        expect(Object.isFrozen(BILLING_PRODUCT_CATALOG)).toBe(true)
        expect(Object.isFrozen(BILLING_PRODUCT_CATALOG.PRO_1M)).toBe(true)
        expect(Object.isFrozen(BILLING_PRODUCTS)).toBe(true)
    })

    describe("isProductCode / findProduct / getProduct", () => {
        it("accepts every catalog code", () => {
            for (const code of PRODUCT_CODES) {
                expect(isProductCode(code)).toBe(true)
                expect(findProduct(code)?.code).toBe(code)
                expect(getProduct(code)).toBe(BILLING_PRODUCT_CATALOG[code])
            }
        })

        it("rejects anything that is not exactly a catalog code", () => {
            for (const value of [
                "pro_1m",
                "PRO_1M ",
                " PRO_1M",
                "PRO_6M",
                "PRO_1Y",
                "FREE",
                "",
                null,
                undefined,
                1,
                {},
                ["PRO_1M"],
                // prototype pollution: کلید inherited نباید محصول بدهد
                "constructor",
                "toString",
                "__proto__",
            ]) {
                expect(isProductCode(value)).toBe(false)
                expect(findProduct(value)).toBeNull()
                expect(() => getProduct(value)).toThrow()
            }
        })

        it("never falls back to a default product for an unknown code", () => {
            expect(() => getProduct("PRO_2M")).not.toThrow()
            expect(() => getProduct("PRO_4M")).toThrow(/unknown product code/)
        })
    })

    describe("tomanFromRial (display-only conversion)", () => {
        it("converts Rial to Toman for the UI without touching gateway amounts", () => {
            expect(RIAL_PER_TOMAN).toBe(10)
            expect(tomanFromRial(350_000)).toBe(35_000)
            expect(tomanFromRial(600_000)).toBe(60_000)
            expect(tomanFromRial(900_000)).toBe(90_000)
        })
    })

    it("every product is its own catalog entry (no aliasing / accidental shared object)", () => {
        const seen = new Set<ProductCode>()
        for (const product of BILLING_PRODUCTS) {
            seen.add(product.code)
            expect(product.code).toBe(getProduct(product.code).code)
        }
        expect(seen.size).toBe(PRODUCT_CODES.length)
    })
})