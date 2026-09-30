// AI Quota — لایهٔ نمایش (pure)
//
// این فایل **هیچ منطق quota ندارد**. ورودی‌اش همان اعدادی است که
// `GET /api/ai/quota` برمی‌گرداند و خروجی‌اش فقط متنِ نمایشی است.
//
// چرا pure و جدا از کامپوننت؟
// پروژه DOM test environment ندارد (نه jsdom، نه testing-library)، و قرارداد
// تستش تستِ تابع خالص است. با جدا کردن «تصمیمِ متن» از رندر، می‌شود تمام حالت‌های
// UX (عادی / کم / صفر / هدیه) را بدون browser واقعی و قطعی تست کرد.
//
// ── آیا این «منطق quota جدید» است؟ نه ─────────────────────────────────────────
// اینجا فقط نگاشت عدد → جمله است. عددها از بک‌اند می‌آیند و این فایل هیچ محاسبه‌ای
// روی `granted`/`consumed` انجام نمی‌دهد؛ `remaining` را همان‌طور که هست نشان می‌دهد.

import { faDigits } from "@/app/lib/time"

export type AiQuotaFeatureKey = "analyze" | "plan"

/** آستانهٔ «کم شده» — زیر این عدد لحن نمایش کمی صریح‌تر می‌شود. */
export const LOW_QUOTA_THRESHOLD = 3

export type AiQuotaTone = "normal" | "low" | "exhausted"

export interface AiQuotaDimensionInput {
    remaining: number
    granted: number
    consumed: number
    promoRemaining: number
}

export interface AiQuotaDimensionView {
    key: AiQuotaFeatureKey
    tone: AiQuotaTone
    /** برچسب ثابت بُعد — «تحلیل هوشمند» / «برنامه‌ریزی هوشمند» */
    label: string
    /** متن اصلیِ کوتاه، بدون فشار و بدون دعوت به مصرف. */
    text: string
    /**
     * جملهٔ کامل برای screen-reader. معنی را **بدون اتکا به رنگ** منتقل می‌کند
     * (الزام دسترس‌پذیری) و در element جدا با `aria-label` می‌نشیند.
     */
    ariaLabel: string
    /**
     * آیا بخشی از باقی‌مانده از کد هدیه تأمین شده است؟
     *
     * عمداً فقط یک boolean است، نه یک عدد. نمایش «۲ مورد هدیه» کنار «۱۱ باقی‌مانده»
     * برای کاربر دو عددِ ناهم‌خوان کنار هم می‌گذاشت و وسوسه‌ی جمع‌زدنشان می‌داد؛ منبعِ
     * سهمیه فقط یک توضیح ثانویه است و در متنِ اصلیِ هر بُعد جایی ندارد.
     */
    hasPromo: boolean
}

/**
 * توضیح ثانویهٔ منبع سهمیه — یک جمله برای کل نوار، بدون عدد.
 * عمداً بدون رقم است تا با «باقی‌مانده» جمع نشود و شمرده نشود.
 */
export const QUOTA_PROMO_SOURCE_NOTE = "بخشی از این سهمیه از کد هدیه تأمین شده است."

/** نام نمایشی هر بُعد — واژهٔ «فرصت» عمداً استفاده نشده (لحن غیرتحریکی). */
export function quotaFeatureLabel(key: AiQuotaFeatureKey): string {
    return key === "analyze" ? "تحلیل هوشمند" : "برنامه‌ریزی هوشمند"
}

/** لحن بر اساس باقی‌مانده — تنها نقطهٔ تصمیمِ آستانه در کل UI. */
export function quotaTone(remaining: number): AiQuotaTone {
    if (remaining <= 0) return "exhausted"
    if (remaining <= LOW_QUOTA_THRESHOLD) return "low"
    return "normal"
}

/**
 * describeQuotaDimension — عددِ واقعیِ بک‌اند را به جملهٔ نمایشی تبدیل می‌کند.
 *
 * لحن عمداً «خبررسی» است، نه «ترغیبی»: هیچ «فرصت»، «از دست می‌رود»، شمارش معکوس
 * یا نوار پیشرفتی تولید نمی‌شود.
 */
export function describeQuotaDimension(
    key: AiQuotaFeatureKey,
    status: AiQuotaDimensionInput,
): AiQuotaDimensionView {
    const label = quotaFeatureLabel(key)
    const remaining = Math.max(0, status.remaining)
    const tone = quotaTone(remaining)
    const hasPromo = status.promoRemaining > 0

    if (tone === "exhausted") {
        return {
            key,
            tone,
            label,
            text: `سهمیهٔ ${label} این دوره تمام شده است.`,
            ariaLabel: `سهمیهٔ ${label} برای این دوره تمام شده است.`,
            hasPromo,
        }
    }

    const remainingDigits = faDigits(remaining)

    // حالت «عادی» و «کم» یک قالبِ یکسان دارند: فقط «چقدر قابل استفاده مانده».
    // عمداً هیچ عددِ دومی (مثلاً موجودیِ کد هدیه) کنار این عدد نمی‌آید.
    return {
        key,
        tone,
        label,
        text: `${label}: ${remainingDigits} مورد باقی‌مانده`,
        ariaLabel: `${remainingDigits} مورد ${label} برای این دوره باقی مانده است.`,
        hasPromo,
    }
}
