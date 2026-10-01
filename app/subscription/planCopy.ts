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
// `AiQuotaPolicy` (seed مهاجرت `20260929120000_...`) نگهداری می‌شود و در **هر دورهٔ
// ۳۰ روزه** (لنگرِ اشتراک/کاربر، نه ماه تقویمی) ریست می‌گردد؛ کاتالوگ بیلینگ فقط پول و
// مدت را می‌فروشد. اینجا فقط همان اعداد policy را برای نمایشِ «در هر دورهٔ ۳۰ روزه»
// می‌خوانیم — بدون اینکه در منطق سهمیه‌دهی دخالتی کنیم. اگر روزی seed جدول عوض شد، فقط
// همین اعداد را به‌روز کن.

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
export type FeatureIcon = "analyze" | "plan" | "support" | "tasks" | "basic"

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

/**
 * پلن رایگان — قابل خرید نیست و از کاتالوگ نمی‌آید (قیمتش همیشه صفر است).
 *
 * عمداً هیچ ادعای **تعداد** کاری در بولت‌ها نیست: نه «تا ۱۰ کار در روز» و نه «نامحدود».
 * محصول در هیچ لایه‌ای (سرویس، route یا دیتابیس) سقف روزانه‌ای برای تسک‌ها ندارد، پس هر
 * عددی اینجا وعده‌ای می‌بود که بک‌اند پشتیبانی نمی‌کند. آنچه واقعاً متفاوت است در باکس
 * «سهمیهٔ هوشمند» کارت‌های پولی نمایش داده می‌شود.
 */
export const FREE_PLAN: PlanCopy & { price: string; period: string } = {
    title: "رایگان",
    subtitle: "همیشه رایگان",
    price: "۰",
    period: "همیشه",
    features: [
        { label: "مدیریت و پیگیری کامل کارها", icon: "tasks" },
        { label: "اولویت‌بندی سادهٔ کارها", icon: "basic" },
        { label: "برنامه‌ریزی هوشمند پایه", icon: "plan" },
    ],
    cta: "شروع کنید",
}

/** متن و ترتیب بولت‌های هر محصول اشتراکی. */
export const PLAN_COPY: Record<ProductCode, PlanCopy> = {
    PRO_1M: {
        title: "اشتراک ماهانه",
        features: [
            { label: "برنامه‌ریزی هوشمند برای تمام کارهای روز", icon: "plan" },
            { label: "تحلیل و اولویت‌بندی هوشمند کارها با AI", icon: "analyze" },
            { label: "مدیریت و پیگیری کامل کارها در یک جا", icon: "tasks" },
            { label: "پشتیبانی اولویت‌دار", icon: "support" },
        ],
        note: "سهمیه‌های هوشمند شما در شروع هر دورهٔ ۳۰ روزه دوباره شارژ می‌شوند.",
        cta: "خرید اشتراک",
    },
    PRO_2M: {
        title: "اشتراک دوماهه",
        features: [
            { label: "تمام امکانات اشتراک ماهانه", icon: "basic" },
            { label: "برنامه‌ریزی هوشمند برای تمام کارهای روز", icon: "plan" },
            { label: "استفاده از امکانات هوشمند در هر {months} دورهٔ ۳۰ روزه", icon: "analyze" },
            { label: "پشتیبانی اولویت‌دار", icon: "support" },
        ],
        cta: "خرید اشتراک",
    },
    PRO_3M: {
        title: "اشتراک سه‌ماهه",
        features: [
            { label: "تمام امکانات اشتراک ماهانه", icon: "basic" },
            { label: "برنامه‌ریزی هوشمند برای تمام کارهای روز", icon: "plan" },
            { label: "استفاده از امکانات هوشمند در هر {months} دورهٔ ۳۰ روزه", icon: "analyze" },
            { label: "پشتیبانی اولویت‌دار", icon: "support" },
        ],
        cta: "دریافت پیشنهاد ویژه",
        featured: true,
    },
}

/**
 * جایگزینی `{months}` در متن بولت با تعداد ماه‌های واقعی دوره.
 *
 * چرا لازم است: تعداد ماه از `entitlementDays` کاتالوگ می‌آید (۳۰/۶۰/۹۰ روز)، پس نباید
 * در متن hard-code شود؛ وگرنه با تغییر مدت یک پلن، متنش دروغ می‌شد. `FREE_PLAN` و پلن
 * ماهانه `{months}` ندارند و دست‌نخورده برمی‌گردند.
 */
export function renderFeatureLabel(label: string, months: number): string {
    return label.replace(/\{months\}/g, faDigits(months))
}

// ────────────────────────────────────────────────────────────────────────────
// سهمیه‌ی هوشمند (نمایشی) — از policy پلن PRO مشتق می‌شود.
// ────────────────────────────────────────────────────────────────────────────

/** طول یک دورهٔ سهمیه — ۳۰ روز کامل (هم‌راستا با `entitlementDays` محصول). */
export const DAYS_PER_MONTH = 30

/** سهمیه‌ی هر دورهٔ ۳۰روزه برای پلن PRO: `AiQuotaPolicy` → plan=PRO. */
export const PRO_MONTHLY_ANALYZE_UNITS = 270
export const PRO_MONTHLY_PLAN_UNITS = 50

export interface SmartQuota {
    /** تعداد دوره‌های کامل ۳۰روزهٔ این اشتراک (۱ / ۲ / ۳). */
    months: number
    /** مجموع اعتبار تحلیل هوشمند در کل دوره. */
    analyze: number
    /** مجموع اعتبار برنامه‌ریزی هوشمند در کل دوره. */
    plan: number
    /** برچسب دامنه برای متن نمایشی («مجموعِ دوره»). */
    scopeLabel: string
}

/**
 * سهمیه‌ی نمایشی یک محصول = سهمیهٔ هر دوره × تعداد دوره‌های ۳۰روزهٔ اشتراک.
 *
 * چرا ضرب می‌کنیم: سهمیه در **هر دورهٔ ۳۰ روزه** (لنگرِ خرید، نه ماه تقویمی) دوباره
 * شارژ می‌شود، پس اشتراک ۶۰ روزه همیشه «۲ دوره» است و ۹۰ روزه «۳ دوره» — و همین
 * عددی است که به کاربر وعده داده می‌شود، چون مرز ماه تقویمی دیگر دخالتی ندارد.
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