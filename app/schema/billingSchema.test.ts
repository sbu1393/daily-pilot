// تست مرز ورودی checkout — تنها دروازه‌ی ورود کلاینت به بیلینگ.
//
// این تست همان چیزی را قفل می‌کند که امنیت پرداخت به آن وابسته است: کلاینت فقط یک
// `productCode` می‌فرستد و هر تلاش برای تعیین مبلغ/مدت/ارز در همان مرز رد می‌شود.

import { describe, expect, it } from "vitest"

import { PRODUCT_CODES } from "@/app/lib/billing/products"
import { checkoutRequestSchema } from "./billingSchema"

describe("checkoutRequestSchema", () => {
    it("accepts every catalog product code", () => {
        for (const productCode of PRODUCT_CODES) {
            const parsed = checkoutRequestSchema.safeParse({ productCode })
            expect(parsed.success).toBe(true)
            expect(parsed.success && parsed.data.productCode).toBe(productCode)
        }
    })

    it("rejects an unknown / malformed product code", () => {
        for (const productCode of [
            "PRO_6M",
            "pro_1m",
            "PRO_1M ",
            "FREE",
            "PRO",
            "",
            1,
            null,
            ["PRO_1M"],
        ]) {
            expect(checkoutRequestSchema.safeParse({ productCode }).success).toBe(false)
        }
    })

    it("rejects a body without productCode (no implicit default product)", () => {
        for (const body of [undefined, null, {}, { amount: 1 }, { userId: 1 }, []]) {
            expect(checkoutRequestSchema.safeParse(body).success).toBe(false)
        }
    })

    it("rejects a client-supplied amount, currency, entitlementDays or plan", () => {
        const attacks: unknown[] = [
            { productCode: "PRO_1M", amount: 1 },
            { productCode: "PRO_1M", amount: "1" },
            { productCode: "PRO_1M", currency: "USD" },
            { productCode: "PRO_1M", entitlementDays: 3650 },
            { productCode: "PRO_1M", planCode: "PRO" },
            { productCode: "PRO_1M", plan: "MAX" },
            { productCode: "PRO_1M", userId: 999 },
            { productCode: "PRO_1M", status: "PAID" },
            { productCode: "PRO_1M", providerAuthority: "A-ATTACKER" },
        ]

        for (const body of attacks) {
            expect(checkoutRequestSchema.safeParse(body).success).toBe(false)
        }
    })

    it("strips nothing silently — a valid body has exactly one key", () => {
        const parsed = checkoutRequestSchema.parse({ productCode: "PRO_2M" })
        expect(Object.keys(parsed)).toEqual(["productCode"])
    })
})