import { z } from "zod"

// AI Quota v2 — قرارداد ورودی API (Phase 2)
//
// قاعده‌ی امنیتی که این فایل enforce می‌کند:
//   **کلاینت هرگز `userId` / `plan` / `units` / `bonus` را تعیین نمی‌کند.**
//   • `userId` از session می‌آید، نه از body.
//   • `plan` فقط برای ادمین و فقط در ویرایش policy معتبر است.
//   • `units` از جدول هزینه‌ی فیچر در سرور خوانده می‌شود.
//   • `bonus*` فقط توسط ادمین هنگام ساخت کد داده می‌شود و هنگام redeem **snapshot**
//     می‌گردد، پس کلاینت در آن دخالتی ندارد.
//
// بنابراین هر schema این فایل عمداً `.strict()` است: هر کلید اضافه‌ای که کلاینت
// بفرستد رد می‌شود (نه نادیده گرفته) تا حمله‌ی «فیلد اضافی را دور بزن» بی‌اثر بماند.

/** سقف ادمین برای یک policy — سقف نمایشی/سقف محافظ، نه محدودیت محصول. */
export const MAX_ALLOWED_UNITS = 1_000_000

export const quotaFeatureSchema = z.enum(["ANALYZE", "PLAN"])
export const userPlanSchema = z.enum(["FREE", "PRO"])

/** POST/PATCH /api/admin/quota-policy — فقط ادمین، فقط روی بدنه. */
export const updateQuotaPolicySchema = z
    .object({
        plan: userPlanSchema,
        feature: quotaFeatureSchema,
        allowedUnits: z
            .number("سهمیه باید عدد باشد")
            .int("سهمیه باید عدد صحیح باشد")
            .min(0, "سهمیه نمی‌تواند منفی باشد")
            .max(MAX_ALLOWED_UNITS, "سهمیه بیش از حد بزرگ است"),
    })
    .strict()

/** کد promo: trim + upper در نرمال‌سازی؛ طول هم کنترل می‌شود تا ورودی ابرطول نشود. */
export const promoCodeStringSchema = z
    .string()
    .trim()
    .min(3, "کد هدیه نامعتبر است")
    .max(64, "کد هدیه نامعتبر است")

export const isoDateSchema = z
    .string()
    .datetime({ offset: true, message: "تاریخ و زمان باید ISO معتبر باشد" })

/** POST /api/admin/promo-codes — فقط ادمین. */
export const createPromoCodeSchema = z
    .object({
        code: promoCodeStringSchema,
        isActive: z.boolean().default(true),
        validFrom: isoDateSchema,
        expiresAt: isoDateSchema,
        maxRedemptions: z.number().int().min(1, "سقف ریدیمپشن باید حداقل ۱ باشد").max(1_000_000).nullish(),
        bonusAnalyzeUnits: z.number().int().min(0, "بونوس نمی‌تواند منفی باشد").max(100_000).default(0),
        bonusPlanUnits: z.number().int().min(0, "بونوس نمی‌تواند منفی باشد").max(100_000).default(0),
    })
    .strict()
    .refine((v) => new Date(v.expiresAt).getTime() > new Date(v.validFrom).getTime(), {
        message: "زمان پایان باید بعد از زمان شروع باشد",
        path: ["expiresAt"],
    })
    .refine((v) => v.bonusAnalyzeUnits + v.bonusPlanUnits >= 1, {
        message: "حداقل یک واحد بونوس لازم است",
        path: ["bonusAnalyzeUnits"],
    })

/**
 * POST /api/promo/redeem — کاربر عادی.
 *
 * عمداً **فقط** `code` می‌پذیرد. هیچ `bonus`، `userId`، `plan` یا `feature` از
 * کلاینت پذیرفته نمی‌شود؛ سرویس خودش featureها را از snapshot کد می‌گیرد.
 */
export const redeemPromoCodeSchema = z
    .object({
        code: promoCodeStringSchema,
    })
    .strict()

/** نرمال‌سازی کد promo برای lookup یونیک و case-insensitive. */
export function normalizePromoCode(raw: string): string {
    return raw.trim().toUpperCase()
}
