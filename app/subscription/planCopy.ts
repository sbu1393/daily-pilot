// محتوای نمایشی صفحهٔ اشتراک — متن‌ها و «سهمیه‌ی هوشمند».
//
// این ماژول فقط **لایه‌ی نمایش** است (هیچ I/O، بدون Prisma، بدون env) تا کامپوننت
// کلاینتی بتواند مستقیم import کند.
//
// تفکیک مسئولیت:
// - قیمت، تخفیف، مدت و «سود شما» از `app/lib/billing/products.ts` می‌آیند (کاتالوگ).
// - این فایل فقط **متن** و **شمارِ نمایشی سهمیه‌ی هوشمند** را نگه می‌دارد.
//
// چرا سهمیه اینجا و نه در کاتالوگ بیلینگ؟ سهمیه‌ی AI یک سیاست جدا است که در جدول
// `AiQuotaPolicy` (seed مهاجرت `20260929120000_...`) نگهداری می‌شود و در هر ماه ریست
// می‌گردد؛ کاتالوگ بیلینگ فقط پول و مدت را می‌فروشد. اینجا فقط همان اعداد policy را
// برای نمایشِ «در ماه / در مجموعِ دوره» می‌خوانیم — بدون اینکه در منطق سهمیه‌دهی
// دخالتی کنیم. اگر روزی seed جدول عوض شد، فقط همین اعداد را به‌روز کن.

import type { ProductCode } from "@/app/lib/billing/products"

import { faDigits } from "@/app/lib/time"

/**
 * عدد با جداکننده‌ی هزارگان و ارقام فارسی: `35000` → «۳۵٬۰۰۰».
 *
 * فقط برای خوانایی است؛ عدد نمایشی از همان مقدار کاتالوگ می‌آید و هیچ نقشی در
 * مبلغ پرداختی ندارد.
 */
export function faGrouped(value: number): string {
    const safe = Number.isFinite(value) ? Math.round(value) : 0
    return faDigits(safe.toLocaleString("en-US")).replace(/,/g, "٬")
}

/** آیکون‌های مینیمال بولت‌ها — نگاشت به lucide در `SubscriptionView`. */
export type FeatureIcon = "unlimited" | "analyze" | "plan" | "support" | "tasks" | "basic"

export interface PlanFeature {
    label: string
    icon: FeatureIcon
}

export interface PlanCopy {
    /** عنوان پلن. */
    title: string
    /** زیرعنوان کوتاه زیر عنوان (پلن رایگان). */
    subtitle?: string
    /** بولت‌های مزیت. */
    features: PlanFeature[]
    /** توضیح تک‌خطی زیر سهمیه‌ها (پلن ماهانه). */
    note?: string
    /** برچسب دکمهٔ اقدام. */
    cta: string
    /** فقط پلن سه‌ماهه: برجسته‌سازی بصری + بج «پیشنهاد ویژه». */
    featured?: boolean
}

/** پلن رایگان — قابل خرید نیست و از کاتالوگ نمی‌آید (قیمتش همیشه صفر است). */
export const FREE_PLAN: PlanCopy & { price: string; period: string } = {
    title: "رایگان",
    subtitle: "همیشه رایگان",
    price: "۰",
    period: "همیشه",
    features: [
        { label: "تا ۱۰ کار در روز", icon: "tasks" },
        { label: "مدیریت و پیگیری ساده‌ی کارها", icon: "basic" },
        { label: "برنامه‌ریزی هوشمند پایه", icon: "plan" },
    ],
    cta: "شروع کنید",
}

/** متن و ترتیب بولت‌های هر محصول اشتراکی. */
export const PLAN_COPY: Record<ProductCode, PlanCopy> = {
    PRO_1M: {
        title: "اشتراک ماهانه",
        features: [
            { label: "کارهای نامحدود روزانه", icon: "unlimited" },
            { label: "برنامه‌ریزی هوشمند پیشرفته", icon: "plan" },
            { label: "تحلیل و اولویت‌بندی هوشمند کارها با AI", icon: "analyze" },
            { label: "پشتیبانی اولویت‌دار", icon: "support" },
        ],
        note: "سهمیه‌های هوشمند شما در ابتدای هر ماه دوباره شارژ می‌شوند.",
        cta: "خرید اشتراک",
    },
    PRO_2M: {
        title: "اشتراک دوماهه",
        features: [
            { label: "تمام امکانات اشتراک ماهانه", icon: "basic" },
            { label: "کارهای نامحدود روزانه", icon: "unlimited" },
            { label: "استفاده از امکانات هوشمند در هر دو ماه", icon: "plan" },
            { label: "پشتیبانی اولویت‌دار", icon: "support" },
        ],
        cta: "خرید اشتراک",
    },
    PRO_3M: {
        title: "اشتراک سه‌ماهه",
        features: [
            { label: "تمام امکانات اشتراک ماهانه", icon: "basic" },
            { label: "کارهای نامحدود روزانه", icon: "unlimited" },
            { label: "۳ ماه استفاده از امکانات هوشمند", icon: "plan" },
            { label: "پشتیبانی اولویت‌دار", icon: "support" },
        ],
        cta: "دریافت پیشنهاد ویژه",
        featured: true,
    },
}

// ────────────────────────────────────────────────────────────────────────────
// سهمیه‌ی هوشمند (نمایشی) — از policy پلن PRO مشتق می‌شود.
// ────────────────────────────────────────────────────────────────────────────

/** تعداد روزی که یک «ماه» اشتراک در نظر گرفته می‌شود (هم‌راستا با `entitlementDays`). */
export const DAYS_PER_MONTH = 30

/** سهمیه‌ی ماهانه‌ی پلن PRO: `AiQuotaPolicy` → plan=PRO. */
export const PRO_MONTHLY_ANALYZE_UNITS = 270
export const PRO_MONTHLY_PLAN_UNITS = 50

export interface SmartQuota {
    /** تعداد ماه‌های کامل دوره (۱ / ۲ / ۳). */
    months: number
    /** مجموع اعتبار تحلیل هوشمند در کل دوره. */
    analyze: number
    /** مجموع اعتبار برنامه‌ریزی هوشمند در کل دوره. */
    plan: number
    /** واژه‌ی جمع/مفرد برای متن: «ماه» یا «ماه». */
    scopeLabel: string
}

/**
 * سهمیه‌ی نمایشی یک محصول = ماهانه × تعداد ماه‌های دوره.
 *
 * چرا ضرب می‌کنیم: سهمیه در هر ماه دوباره شارژ می‌شود، پس دوره‌ی دوماهه‌ای همیشه
 * «ماهانه × ۲» است و سه‌ماهه «ماهانه × ۳» — نه یک انبارِ جمع‌شونده.
 */
export function smartQuotaFor(entitlementDays: number): SmartQuota {
    const days = Number.isFinite(entitlementDays) ? Math.max(0, Math.trunc(entitlementDays)) : 0
    const months = Math.round(days / DAYS_PER_MONTH)
    return {
        months,
        analyze: PRO_MONTHLY_ANALYZE_UNITS * months,
        plan: PRO_MONTHLY_PLAN_UNITS * months,
        scopeLabel: "مجموعِ دوره",
    }
}

/**
 * هزینه‌ی هر روزِ دوره (تومان) — برای کارت ویژه.
 * گرد‌کردن به نزدیک‌ترین صد تومان فقط برای خوانایی است؛ مبلغ پرداختی همچنان
 * `product.amount` از کاتالوگ است و این عدد صرفاً یک نسبت نمایشی است.
 */
export function perDayToman(amountToman: number, entitlementDays: number): number {
    if (entitlementDays <= 0) return 0
    return Math.round((amountToman / entitlementDays) / 100) * 100
}