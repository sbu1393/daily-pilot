import { z } from "zod"

import { PRODUCT_CODES } from "@/app/lib/billing/products"

// قرارداد ورودی بیلینگ (فاز ۵) — فقط برای مرز HTTP.
//
// قاعده‌ی امنیتی که این فایل enforce می‌کند (هم‌راستا با `aiQuotaSchema.ts`):
//   **کلاینت هرگز مبلغ یا مدت اشتراک را تعیین نمی‌کند.**
//   • `amount` / `currency` / `entitlementDays` از بدنه اصلاً پذیرفته نمی‌شوند و تنها از
//     کاتالوگ سروری (`app/lib/billing/products.ts`) خوانده و روی `PaymentOrder` snapshot
//     می‌شوند؛ پس ارسال `amount: 1` حتی به نقطه‌ی DB نمی‌رسد.
//   • تنها ورودی مجاز `productCode` است که خودش یک enum از کاتالوگ است.
//
// schema عمداً `.strict()` است: هر کلید اضافه‌ای که کلاینت بفرستد **رد** می‌شود (نه نادیده
// گرفته) تا حمله‌ی «فیلد اضافی را دور بزن» بی‌اثر بماند — همان تصمیمی که در
// `app/schema/aiQuotaSchema.ts` برای کدهای promo گرفته شده است.

/**
 * POST /api/billing/checkout — کاربر احراز‌شده.
 *
 * فقط `productCode`؛ هر مقدار دیگری (از جمله `amount`/`entitlementDays`) یا نامعتبر است
 * یا به‌خاطر `.strict()` رد می‌شود و پاسخ ۴۰۰ `VALIDATION_ERROR` می‌گیرد — پیش از هر DB write
 * و پیش از هر تماس درگاه.
 */
export const checkoutRequestSchema = z
    .object({
        productCode: z.enum(PRODUCT_CODES, {
            message: "محصول انتخاب‌شده معتبر نیست",
        }),
    })
    .strict()

export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>