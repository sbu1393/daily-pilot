// فاز ۵ — گام ۵: interface پرداختِ provider-neutral (سند فاز ۵ §8 و §27)
//
// مسئولیت: فقط «قرارداد» بین billing.service و provider. هیچ پیاده‌سازی، HTTP call، SDK،
// URL، merchant ID یا منطق مخصوص ZarinPal این‌جا نیست — سند §27:
//   Route → billing.service → paymentProvider interface → zarinpal.adapter → Prisma
// و پیاده‌سازی واقعی ZarinPal گام ۶ است.
//
// مرزهای قرارداد (سند §8 / §27):
// - adapter هرگز Prisma، User.plan، entitlement rules یا authorization را نمی‌شناسد؛ پس
//   این interface هم هیچ‌کدام را expose نمی‌کند (بدون PaymentOrder/Entitlement).
// - دامنه فقط نتیجه‌ی نرمال‌شده می‌گیرد: هیچ raw provider payload/response نگه داشته نمی‌شود.
// - هیچ secret/credential/card/CVV/Authorization header در قرارداد نیست.
// - نام‌های `authority` و `reference` عیناً از سند §8/§2 آمده‌اند، چون
//   PaymentOrder.providerAuthority/providerReference همان source of truth دامنه‌اند؛ هیچ
//   validation/format مربوط به provider در این قرارداد نیست.

import type { BillingProviderId } from "./config"

// ---------- createPayment (سند §8/§10) ----------

/** ورودی درخواست پرداخت — همه‌ی مقادیر از سرور می‌آیند (سند §10: client هیچ‌کدام را نمی‌دهد). */
export interface CreatePaymentInput {
    /** شناسه‌ی یکتای سفارش در سمت ما (سند §6) — idempotency provider-side ندارد (سند §7). */
    merchantOrderId: string
    /** مبلغ اسنپ‌شات‌شده‌ی سفارش (سند §4) — هرگز از client. */
    amount: number
    /**
     * ارز اسنپ‌شات‌شده‌ی سفارش — هرگز از client.
     * MVP فاز ۵ فقط `IRR` را پشتیبانی می‌کند: `IRT` پشتیبانی نمی‌شود و هیچ تبدیل واحد یا
     * normalization عددی روی amount انجام نمی‌شود.
     */
    currency: string
    /** callback عمومی سرور (سند §26) — از config، نه از client. */
    callbackUrl: string
    /** توضیح اختیاری برای صفحه‌ی پرداخت — باید عمومی/بی‌خطر باشد. */
    description?: string
}

/**
 * نتیجه‌ی پذیرش درخواست توسط provider.
 * - `authority`: شناسه‌ی provider که باید ذخیره شود (PaymentOrder.providerAuthority) و در
 *   verify/inquiry و callback دوباره استفاده می‌شود.
 * - `redirectUrl`: آدرس امن ادامه‌ی پرداخت که Route به frontend برمی‌گرداند (سند §10).
 * اطلاعات انقضا در این قرارداد نیست؛ منبع آن PaymentOrder.expiresAt خودمان است (سند §10).
 */
export interface CreatePaymentResult {
    authority: string
    redirectUrl: string
}

// ---------- verifyPayment (سند §8/§13) ----------

/** ورودی verify سمت سرور — `amount` مبلغ ذخیره‌شده‌ی سفارش است، نه مبلغ client (سند §13). */
export interface VerifyPaymentInput {
    authority: string
    amount: number
}

/**
 * نتیجه‌ی verify موفق.
 *
 * `reference` شناسه‌ی نهایی provider است و به‌صورت `string | null` تعریف شده چون مستند رسمی
 * ZarinPal فقط برای پاسخ موفقِ اولین verify (`code = 100`) وجود `ref_id` را تضمین می‌کند؛ در
 * حالت «قبلاً verify شده» (`code = 101`) وجود آن تضمین نشده است. در آن حالت adapter باید
 * `null` برگرداند و **هیچ مقدار جعلی برای reference ساخته نشود**.
 *
 * `amount` مبلغ تأییدشده‌ی provider است که سرویس باید آن را با amount سفارش مقایسه کند
 * (سند §13: exact amount verification) و به‌صورت `number | null` تعریف شده چون مستند رسمی
 * Verify تضمین نمی‌کند provider فیلد `amount` را در پاسخ برگرداند:
 * - `null` یعنی «provider مبلغ قابل‌استناد برنگرداند» — نه صفر و نه مبلغ درخواست.
 * - consumer/service **نباید** `null` را به‌عنوان amount تأییدشده تفسیر کند؛ در این حالت مبلغ
 *   تأییدشده‌ی provider در دسترس نیست و رفتار باید طبق سیاست دامنه تعیین شود، نه با fallback
 *   محلی به مبلغ درخواست.
 * - adapter هرگز مبلغ درخواست را به‌جای مبلغ provider جا نمی‌زند.
 */
export interface VerifyPaymentResult {
    reference: string | null
    amount: number | null
}

// ---------- inquirePayment (سند §8؛ صرفاً برای reconciliation دستی سند §7) ----------

export interface InquirePaymentInput {
    authority: string
}

/**
 * وضعیت نرمال‌شده‌ی پرداخت از دید provider.
 * EXPIRED/CANCELED عمداً این‌جا نیستند: آن‌ها حالت‌های داخلی خودمان‌اند (سند §14) و provider
 * هرگز آن‌ها را گزارش نمی‌کند.
 */
export type NormalizedPaymentStatus = "PENDING" | "PAID" | "FAILED" | "UNKNOWN"

export interface InquirePaymentResult {
    status: NormalizedPaymentStatus
    /** null وقتی provider مرجع نهایی را برنمی‌گرداند (مثلاً پرداخت هنوز ناتمام). */
    reference: string | null
    /** null وقتی provider مبلغ را گزارش نمی‌کند — هیچ مقداری حدس زده نمی‌شود. */
    amount: number | null
}

// ---------- parseCallback (سند §8/§11) ----------

/** پارامترهای callback — همه UNTRUSTED (سند §11) و به‌صورت رشته‌ی خام می‌آیند. */
export interface ParseCallbackInput {
    authority?: string | null
    status?: string | null
}

/**
 * وضعیت نرمال‌شده‌ی callback. `UNKNOWN` یعنی پارامتر قابل نگاشت نبود (سند §11: Status تنها
 * هرگز کافی نیست — تصمیم نهایی با verify سمت سرور است، سند §13).
 */
export type NormalizedCallbackStatus = "SUCCESS" | "FAILURE" | "UNKNOWN"

/** خروجی parse — فقط همین دو فیلد؛ هیچ پارامتر خام دیگری از callback نگه داشته نمی‌شود. */
export interface NormalizedCallback {
    authority: string
    status: NormalizedCallbackStatus
}

// ---------- خطای provider-neutral (contract کوچک؛ taxonomy بیلینگ = گام ۷) ----------

/**
 * نوع شکست provider — provider-neutral و بدون هیچ کد خطای دامنه‌ای:
 * - `UNAVAILABLE`: outage/timeout/شبکه. در createPayment این حالت «مبهم» است (سند §7: هرگز
 *   کورکورانه retry نشود؛ سفارش PENDING بماند) و در verify یعنی «شکست موقت، نه قطعی» (سند §13).
 * - `REJECTED`: provider قطعی رد کرد / verify قطعی شکست خورد (سند §13) → entitlement صفر.
 * - `INVALID_RESPONSE`: پاسخ provider قابل استفاده/نرمال‌سازی نبود (defense؛ معادل قطعی گرفته می‌شود).
 * نگاشت این kinds به کدهای خطای بیلینگ (سند §20) کار گام ۷/سرویس است، نه این قرارداد.
 */
export type PaymentProviderFailure = "UNAVAILABLE" | "REJECTED" | "INVALID_RESPONSE"

/**
 * خطای provider. هیچ raw payload/secret در آن حمل نمی‌شود: پیاده‌کننده فقط پیامِ کوتاهِ
 * ایمن و نرمال‌شده می‌دهد (سند §33: normalized provider errors + safe public messages).
 */
export class PaymentProviderError extends Error {
    readonly kind: PaymentProviderFailure
    /** فقط UNAVAILABLE قابل تلاش مجدد است؛ REJECTED/INVALID_RESPONSE هرگز (سند §7/§13). */
    readonly retryable: boolean

    constructor(kind: PaymentProviderFailure, message: string) {
        super(message)
        this.name = "PaymentProviderError"
        this.kind = kind
        this.retryable = kind === "UNAVAILABLE"
    }
}

// ---------- قرارداد ----------

/**
 * قرارداد provider پرداخت — سند §8:
 * «Create a provider-neutral payment interface» و «The domain must receive normalized
 * results only». پیاده‌سازی‌ها (مثل zarinpal.adapter در گام ۶) این interface را implement
 * می‌کنند و billing.service فقط به همین interface وابسته است.
 */
export interface PaymentProvider {
    /** شناسه‌ی provider — برای تطبیق با PaymentOrder.provider (سند §13: «provider matches»). */
    readonly id: BillingProviderId

    /**
     * ایجاد/درخواست پرداخت. شکست قطعی یا مبهم → `PaymentProviderError`
     * (UNAVAILABLE یعنی وضعیت provider نامعلوم است؛ سند §7).
     */
    createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>

    /**
     * verify سمت سرور با authority + amount ذخیره‌شده (سند §13).
     * رد قطعی → REJECTED؛ timeout/outage → UNAVAILABLE (سفارش PENDING می‌ماند).
     */
    verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult>

    /** استعلام وضعیت برای reconciliation دستی مجاز (سند §7/§8). */
    inquirePayment(input: InquirePaymentInput): Promise<InquirePaymentResult>

    /** نگاشت پارامترهای خام و نامعتبر callback به نتیجه‌ی نرمال‌شده (خالص و بدون I/O). */
    parseCallback(input: ParseCallbackInput): NormalizedCallback
}
