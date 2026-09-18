// فاز ۵ — گام ۴: ماژول configuration بیلینگ (سند فاز ۵ §5، §9، §27)
//
// مسئولیت: تمام مقادیر product/provider بیلینگ فقط از این‌جا خوانده می‌شوند تا هیچ
// business value‌ای در route/service/adapter hard-code نشود (سند §5: «Do not hard-code
// business values inside routes» و «The client must never provide amount/currency/
// entitlementDays/plan»).
//
// اصول این ماژول:
// - Fail-fast: هر کلید لازم یا موجود/معتبر است یا همان‌جا خطا داده می‌شود؛ هیچ مقدار
//   پیش‌فرض حدسی برای business value وجود ندارد (مقدار واقعی = deployment/business config).
// - بدون نشت secret: پیام خطا فقط «نام کلید» را می‌گوید؛ مقدار کلید هرگز در پیام/لاگ نمی‌آید.
// - بدون Prisma: provider ID به‌صورت literal تعریف شده تا این ماژول به client تولیدشده‌ی
//   فاز ۵ وابسته نباشد (adapter طبق سند §8 هرگز Prisma را import نمی‌کند).
// - timeout یک مقدار فنی است (نه business value) و مانند الگوی موجود پروژه
//   (app/lib/ai/analyzeTask.ts) با clamp خوانده می‌شود.
//
// خارج از scope این گام: هیچ HTTP call، adapter، service، route، entity، Error taxonomy
// بیلینگ یا ProductEvent‌ای این‌جا ساخته نمی‌شود (سند §36 مراحل ۵–۷ بعدی هستند).

// گام ۱۰ (checkout): دو کلید سروری دیگر به همین ماژول اضافه شد — `BILLING_ORDER_TTL_MS`
// (`orderTtlMs`) و `BILLING_ZARINPAL_DESCRIPTION` (`zarinpal.description`). متن/عدد آن‌ها هنوز
// هیچ‌جا hard-code نمی‌شود و هیچ secretی log/return نمی‌شود.
//
// گام ۱۱ (callback): دو مقصد ثابت ریدایرکت مرورگر اضافه شد — `BILLING_RESULT_URL_SUCCESS` و
// `BILLING_RESULT_URL_FAILURE` (`resultUrls`). هر دو الزامی‌اند و فقط از config سروری می‌آیند
// (مطلق http(s)) تا هیچ مقصدی از query param کلاینت ساخته نشود — بدون open redirect (سند §11/§33).

import type { UserPlan } from "@prisma/client"

/** providerهای MVP — سند §9: فاز ۵ فقط یک provider دارد (چرخه‌ی چند-provider ممنوع). */
export type BillingProviderId = "ZARINPAL"

/** حالت محیطی provider — سند §9 («base URL / sandbox-production mode»). */
export type ZarinpalMode = "sandbox" | "production"

/** product تجاری PRO — سند §5: plan/amount/currency/entitlementDays سرور-محور. */
export interface BillingProductConfig {
    readonly planCode: UserPlan
    readonly amount: number
    readonly currency: string
    readonly entitlementDays: number
}

export interface ZarinpalBillingConfig {
    /** merchant ID — سند §9؛ secret است و هرگز log/return نمی‌شود. */
    readonly merchantId: string
    readonly mode: ZarinpalMode
    /**
     * host پایه‌ی provider. مسیرهای v4 سند §8 (`/pg/v4/payment/request.json` و …)
     * در adapter به همین base اضافه می‌شوند؛ این ماژول هیچ URL را حدس نمی‌زند.
     */
    readonly baseUrl: string
    /**
     * callback عمومی همین سرور — سند §26: «Callback destination must come from server
     * configuration» و هرگز از client گرفته نمی‌شود.
     * در گام ۱۰ (checkout) ارجاع داخلی سفارش (`ref`) سمت سرور به همین URL اضافه می‌شود.
     */
    readonly callbackUrl: string
    /**
     * توضیح عمومی صفحه‌ی پرداخت — سند §10: مقدار محصول/برند سرور-محور و هرگز از client.
     * متن آن در این ماژول hard-code نمی‌شود (business value = deployment config).
     */
    readonly description: string
    readonly timeoutMs: number
}

/**
 * گام ۱۱ — مقصدهای ثابت نتیجه‌ی پرداخت (browser-facing). این‌ها deployment config هستند و
 * مرورگر کاربر پس از callback فقط به همین دو URL هدایت می‌شود؛ هیچ ورودی کلاینت در آن دخالت ندارد.
 */
export interface BillingResultUrls {
    readonly success: string
    readonly failure: string
}

export interface BillingConfig {
    readonly provider: BillingProviderId
    /**
     * عمر سفارش پرداخت PENDING (میلی‌ثانیه) — سند §14/§15: مبنای `PaymentOrder.expiresAt`.
     * یک business value است، پس نه default دارد و نه hard-code؛ مقدار آن از config می‌آید.
     */
    readonly orderTtlMs: number
    readonly pro: BillingProductConfig
    readonly zarinpal: ZarinpalBillingConfig
    /** گام ۱۱ — مقصدهای ریدایرکت callback؛ الزامی و فقط سرور-محور (سند §11). */
    readonly resultUrls: BillingResultUrls
}

/** منبع env — تزریق‌پذیر تا resolver خالص و بدون دست‌زدن به env واقعی قابل تست باشد. */
export type BillingEnvSource = Record<string, string | undefined>

/** provider فعال — سند §2/§9 (MVP: ZarinPal). */
export const BILLING_PROVIDER: BillingProviderId = "ZARINPAL"

/** plan محصول PRO — سند §5 (Product DB table لازم نیست؛ همین config کافی است). */
export const BILLING_PRO_PLAN_CODE: UserPlan = "PRO"

/** نام کلیدهای environment (فقط نام‌ها عمومی‌اند؛ مقدارها secret/deployment config). */
export const BILLING_ENV = {
    proAmount: "BILLING_PRO_AMOUNT",
    proCurrency: "BILLING_PRO_CURRENCY",
    proEntitlementDays: "BILLING_PRO_ENTITLEMENT_DAYS",
    merchantId: "BILLING_ZARINPAL_MERCHANT_ID",
    mode: "BILLING_ZARINPAL_MODE",
    baseUrl: "BILLING_ZARINPAL_BASE_URL",
    callbackUrl: "BILLING_ZARINPAL_CALLBACK_URL",
    zarinpalDescription: "BILLING_ZARINPAL_DESCRIPTION",
    providerTimeoutMs: "BILLING_PROVIDER_TIMEOUT_MS",
    orderTtlMs: "BILLING_ORDER_TTL_MS",
    resultUrlSuccess: "BILLING_RESULT_URL_SUCCESS",
    resultUrlFailure: "BILLING_RESULT_URL_FAILURE",
} as const

/** مقادیر فنی پیش‌فرض (نه business value) — هم‌سبک با AI_TIMEOUT_MS در analyzeTask.ts. */
export const BILLING_TIMEOUT_DEFAULTS = {
    providerTimeoutMs: 12_000,
    minProviderTimeoutMs: 3_000,
} as const

// ---------- Readers (pure؛ fail-fast؛ هرگز مقدار را در پیام خطا نمی‌گذارند) ----------

function requiredString(env: BillingEnvSource, key: string): string {
    const raw = env[key]
    const value = typeof raw === "string" ? raw.trim() : ""
    if (!value) throw new Error(`billing config: ${key} is missing or empty`)
    return value
}

function positiveInt(env: BillingEnvSource, key: string): number {
    const value = requiredString(env, key)
    if (!/^\d+$/.test(value)) {
        throw new Error(`billing config: ${key} must be a positive integer`)
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`billing config: ${key} must be a positive integer`)
    }
    return parsed
}

/** URL مطلق http(s) — بدون حدس روی host؛ فقط اعتبارسنجی شکل.
 *  @param httpsOnly اگر true باشد، فقط https: پذیرفته می‌شود (RB6: production HTTPS enforcement). */
function httpUrl(env: BillingEnvSource, key: string, httpsOnly = false): string {
    const value = requiredString(env, key)
    let parsed: URL
    try {
        parsed = new URL(value)
    } catch {
        throw new Error(`billing config: ${key} must be an absolute http(s) URL`)
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error(`billing config: ${key} must be an absolute http(s) URL`)
    }
    if (httpsOnly && parsed.protocol !== "https:") {
        throw new Error(`billing config: ${key} must use HTTPS in production mode`)
    }
    // حذف اسلش‌های انتهایی تا الحاق مسیرهای provider به double-slash منجر نشود.
    return value.replace(/\/+$/, "")
}

/**
 * ارز محصول — MVP فاز ۵ فقط `IRR` را پشتیبانی می‌کند (تصمیم قطعی).
 * هر مقدار دیگری از جمله `IRT` → fail-fast؛ هیچ تبدیل واحد یا normalization انجام نمی‌شود.
 * مقایسه دقیق (case-sensitive) است — `irr` هم پذیرفته نمی‌شود.
 */
function irrCurrency(env: BillingEnvSource): string {
    const value = requiredString(env, BILLING_ENV.proCurrency)
    if (value !== "IRR") {
        throw new Error(`billing config: ${BILLING_ENV.proCurrency} must be "IRR"`)
    }
    return value
}

function zarinpalMode(env: BillingEnvSource): ZarinpalMode {
    const value = requiredString(env, BILLING_ENV.mode).toLowerCase()
    if (value !== "sandbox" && value !== "production") {
        throw new Error(`billing config: ${BILLING_ENV.mode} must be "sandbox" or "production"`)
    }
    return value
}

/** مقدار فنی: اگر ست نشده باشد پیش‌فرض؛ اگر ست شده ولی نامعتبر باشد → fail-fast. */
function providerTimeoutMs(env: BillingEnvSource): number {
    const raw = env[BILLING_ENV.providerTimeoutMs]
    const value = typeof raw === "string" ? raw.trim() : ""
    if (!value) return BILLING_TIMEOUT_DEFAULTS.providerTimeoutMs
    if (!/^\d+$/.test(value)) {
        throw new Error(`billing config: ${BILLING_ENV.providerTimeoutMs} must be a positive integer`)
    }
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`billing config: ${BILLING_ENV.providerTimeoutMs} must be a positive integer`)
    }
    return Math.max(BILLING_TIMEOUT_DEFAULTS.minProviderTimeoutMs, parsed)
}

// ---------- Public API ----------

/**
 * resolve پیکربندی بیلینگ از یک منبع env — خالص و بدون I/O.
 * در نبود/نامعتبر بودن هر کلید لازم، بلافاصله خطا می‌دهد (fail-fast).
 */
export function resolveBillingConfig(env: BillingEnvSource): BillingConfig {
    // RB6: mode را ابتدا resolve کن تا httpsOnly بر اساس آن تعیین شود.
    const mode = zarinpalMode(env)
    const isProduction = mode === "production"

    return {
        provider: BILLING_PROVIDER,
        orderTtlMs: positiveInt(env, BILLING_ENV.orderTtlMs),
        pro: {
            planCode: BILLING_PRO_PLAN_CODE,
            amount: positiveInt(env, BILLING_ENV.proAmount),
            currency: irrCurrency(env),
            entitlementDays: positiveInt(env, BILLING_ENV.proEntitlementDays),
        },
        zarinpal: {
            merchantId: requiredString(env, BILLING_ENV.merchantId),
            mode,
            baseUrl: httpUrl(env, BILLING_ENV.baseUrl, isProduction),
            callbackUrl: httpUrl(env, BILLING_ENV.callbackUrl, isProduction),
            description: requiredString(env, BILLING_ENV.zarinpalDescription),
            timeoutMs: providerTimeoutMs(env),
        },
        // مقصدهای ریدایرکت callback: هر دو الزامی و مطلق http(s) — بدون default حدسی (سند §11).
        // RB6: در production مقصدهای نتیجه هم باید HTTPS باشند.
        resultUrls: {
            success: httpUrl(env, BILLING_ENV.resultUrlSuccess, isProduction),
            failure: httpUrl(env, BILLING_ENV.resultUrlFailure, isProduction),
        },
    }
}

/**
 * پیکربندی بیلینگ از environment فرایند.
 * خواندن در لحظه‌ی فراخوانی (بدون cache و بدون خواندن در زمان import) تا نبود config
 * باعث crash ماژول route نشود و همان مسیر درخواست، خطای پیکربندی را fail-fast ببیند.
 */
export function getBillingConfig(): BillingConfig {
    return resolveBillingConfig(process.env)
}
