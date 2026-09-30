// کاتالوگ محصولات بیلینگ — منبع حقیقت واحد قیمت/مدت (فقط سرور).
//
// چرا این فایل:
// - سه محصول اشتراک (ماهانه/دوماهه/سه‌ماهه) از نظر entitlement همگی `PRO` هستند و فقط
//   «مدت + مبلغ + شناسه» فرق دارند؛ بنابراین `UserPlan` عمداً دست‌نخورده می‌ماند
//   (`FREE | PRO`) و تمایز محصول‌ها فقط با `ProductCode` انجام می‌شود.
// - قیمت نهایی و مدت هرگز از client نمی‌آید: client فقط `productCode` می‌فرستد و سرور
//   همین‌جا مقدار `amount`/`entitlementDays` را از کاتالوگ snapshot می‌کند.
//
// واحد پول: **ریال (IRR)** — دقیقاً همان واحدی که درگاه زرین‌پال می‌گیرد و adapter با
// `irrCurrency()` fail-fast آن را اجباری می‌کند (هیچ تبدیل واحدی در backend انجام نمی‌شود).
// `baseAmount` هم ریال است تا تخفیف و مبلغ نهایی هم‌واحد و قابل‌اعتبار باشند؛ فقط UI برای
// نمایش به تومان تبدیل می‌کند (`RIAL_PER_TOMAN`) که یک تبدیل نمایشیِ سمت کلاینت است
// و هیچ نقشی در مبلغ قابل پرداخت ندارد.
//
// این ماژول خالص است (بدون I/O، بدون Prisma، بدون env، بدون Prisma client) تا هم سمت
// سرور و هم داخل کامپوننت کلاینتی صفحهٔ اشتراک قابل import باشد.

/** واحد پول — فقط ریال (IRR)؛ adapter هر واحد دیگری را fail-fast رد می‌کند. */
export const BILLING_CURRENCY = "IRR"

/** هر ریال = ۱۰ تومان (فقط برای نمایش در UI؛ مبلغ پرداختی همیشه ریال است). */
export const RIAL_PER_TOMAN = 10

/** شناسه محصول — تنها چیزی که client اجازه دارد بفرستد. */
export type ProductCode = "PRO_1M" | "PRO_2M" | "PRO_3M"

export interface BillingProduct {
    readonly code: ProductCode
    /** قیمت پایه پیش از تخفیف (ریال) — فقط برای نمایش خط‌خورده. */
    readonly baseAmount: number
    /** درصد تخفیف (۰ تا ۱۰۰) — فقط نمایشی؛ مبلغ از رابطه‌ی زیر محاسبه می‌شود. */
    readonly discountPercent: number
    /** مبلغ نهایی قابل پرداخت (ریال) — تنها عددی که به درگاه می‌رود. */
    readonly amount: number
    /** مدت دسترسی خریداری‌شده (روز) — ۳۰/۶۰/۹۰. */
    readonly entitlementDays: number
}

/**
 * کاتالوگ — تنها منبع مجاز قیمت و مدت. `Object.freeze` عمدی است تا هیچ مسیری
 * (حتی تست یا کد آینده) نتواند قیمت را در حافظه بازنویسی کند.
 *
 * مقادیر:
 *   PRO_1M → پایه ۵۰٬۰۰۰ تومان، ۳۰٪ تخفیف → ۳۵٬۰۰۰ تومان = ۳۵۰٬۰۰۰ ریال، ۳۰ روز
 *   PRO_2M → پایه ۱۰۰٬۰۰۰ تومان، ۴۰٪ تخفیف → ۶۰٬۰۰۰ تومان = ۶۰۰٬۰۰۰ ریال، ۶۰ روز
 *   PRO_3M → پایه ۱۵۰٬۰۰۰ تومان، ۴۰٪ تخفیف → ۹۰٬۰۰۰ تومان = ۹۰۰٬۰۰۰ ریال، ۹۰ روز
 */
export const BILLING_PRODUCT_CATALOG: Readonly<Record<ProductCode, BillingProduct>> =
    Object.freeze({
        PRO_1M: Object.freeze({
            code: "PRO_1M" as const,
            baseAmount: 500_000,
            discountPercent: 30,
            amount: 350_000,
            entitlementDays: 30,
        }),
        PRO_2M: Object.freeze({
            code: "PRO_2M" as const,
            baseAmount: 1_000_000,
            discountPercent: 40,
            amount: 600_000,
            entitlementDays: 60,
        }),
        PRO_3M: Object.freeze({
            code: "PRO_3M" as const,
            baseAmount: 1_500_000,
            discountPercent: 40,
            amount: 900_000,
            entitlementDays: 90,
        }),
    })

/** فهرست محصولات برای UI (ترتیب نمایش) و برای `z.enum`. */
export const PRODUCT_CODES = Object.freeze([
    "PRO_1M",
    "PRO_2M",
    "PRO_3M",
] as const satisfies readonly ProductCode[])

/** type guard — تنها شکل معتبر ورودی client. هر چیز دیگری رد می‌شود. */
export function isProductCode(value: unknown): value is ProductCode {
    return typeof value === "string" && Object.prototype.hasOwnProperty.call(BILLING_PRODUCT_CATALOG, value)
}

/** lookup امن (بدون پرتاب) — برای مرزهایی که ورودی هنوز اعتبارسنجی نشده. */
export function findProduct(value: unknown): BillingProduct | null {
    return isProductCode(value) ? BILLING_PRODUCT_CATALOG[value] : null
}

/**
 * lookup قطعی برای لایه‌ی سرور: اگر کد شناخته‌شده نباشد یعنی کاتالوگ/config سرور
 * ناسازگار است (یا ورودی از مرز عبور کرده) — هیچ مقدار پیش‌فرضی حدس زده نمی‌شود.
 */
export function getProduct(value: unknown): BillingProduct {
    const product = findProduct(value)
    if (product === null) throw new Error(`billing product: unknown product code`)
    return product
}

/** محصولات به ترتیب نمایش — فقط برای UI. */
export const BILLING_PRODUCTS: readonly BillingProduct[] = Object.freeze(
    PRODUCT_CODES.map((code) => BILLING_PRODUCT_CATALOG[code]),
)

/** تبدیل نمایشی ریال → تومان (سرور هرگز از این استفاده نمی‌کند). */
export function tomanFromRial(rial: number): number {
    return rial / RIAL_PER_TOMAN
}