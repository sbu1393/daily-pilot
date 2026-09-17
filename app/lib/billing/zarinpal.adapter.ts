// فاز ۵ — گام ۶: adapter زرین‌پال با HTTP خام (سند §8، §9، §27)
//
// تنها جای «جزئیات provider» همین فایل است: مسیرهای v4، فیلدهای wire، کدهای وضعیت و نگاشت
// خطا. دامنه فقط نتیجه‌ی نرمال‌شده‌ی contract موجود در ./provider را می‌بیند.
//
// منابع رسمی که این mapping از آن‌ها استخراج شده (هیچ مقدار حدسی وجود ندارد):
// - Create / Callback / Verify: https://www.zarinpal.com/docs/paymentGateway/connectToGateway
// - لیست کدها:                  https://www.zarinpal.com/docs/paymentGateway/errorList
// - Inquiry:                    https://www.zarinpal.com/docs/paymentGateway/otherMethods/Inquiry
// - واحد پولی:                  https://www.zarinpal.com/docs/paymentGateway/moreFeatures/currency
//
// مرزها (سند §8/§27):
// - بدون SDK و بدون dependency؛ فقط `fetch` بومی + `AbortController` با timeout از config.
// - هیچ import از Prisma/Next.js/ServiceError؛ هیچ route/entitlement/payment-order logic.
// - هیچ retry خودکار — به‌ویژه برای createPayment (سند §7: timeout مبهم هرگز retry نمی‌شود).
// - هیچ secret/merchant_id/raw request/raw response/card_pan/card_hash در log، error یا نتیجه نیست.

import { getBillingConfig, type BillingConfig, type ZarinpalMode } from "./config"
import {
    PaymentProviderError,
    type CreatePaymentInput,
    type CreatePaymentResult,
    type InquirePaymentInput,
    type InquirePaymentResult,
    type NormalizedCallback,
    type NormalizedCallbackStatus,
    type NormalizedPaymentStatus,
    type ParseCallbackInput,
    type PaymentProvider,
    type VerifyPaymentInput,
    type VerifyPaymentResult,
} from "./provider"

/** شناسه‌ی provider — باید با `BillingProviderId` سازگار بماند. */
const PROVIDER_ID = "ZARINPAL" as const

/** مسیرهای رسمی v4 (روی `config.zarinpal.baseUrl` سوار می‌شوند؛ هیچ hostی hardcode نمی‌شود). */
const API_PATHS = {
    create: "/pg/v4/payment/request.json",
    verify: "/pg/v4/payment/verify.json",
    inquiry: "/pg/v4/payment/inquiry.json",
} as const

/**
 * صفحه‌ی پرداخت (browser-facing) — مستند رسمی: `Location: https://payment.zarinpal.com/pg/StartPay/{authority}`.
 * این URL از `config.mode` انتخاب می‌شود (production/sandbox) و هرگز از input کاربر ساخته نمی‌شود.
 */
const STARTPAY_HOST: Record<ZarinpalMode, string> = {
    production: "https://payment.zarinpal.com",
    sandbox: "https://sandbox.zarinpal.com",
}
const STARTPAY_PATH = "/pg/StartPay/"

/**
 * redirect پرداخت (browser-facing) — فقط از یک authority می‌سازد.
 *
 * - host فقط از `config.mode` انتخاب می‌شود (production/sandbox) و هیچ‌وقت از client/ورودی.
 * - authority امن encode می‌شود (encodeURIComponent) تا امکان تزریق مسیر/query یا
 *   open-redirect وجود نداشته باشد.
 * - این helper هیچ ورودی دیگری (host/URL/destination) نمی‌پذیرد؛ پس مقصد redirect
 *   هرگز client-controlled نیست. گام ۱۰ برای reuse سفارش PENDING از همین تابع استفاده می‌کند.
 */
export function buildRedirectUrl(authority: string): string {
    const config = getBillingConfig()
    return `${STARTPAY_HOST[config.zarinpal.mode]}${STARTPAY_PATH}${encodeURIComponent(authority)}`
}

/** کد موفقیت رسمی (create و اولین verify). */
const SUCCESS_CODE = 100

/** کد رسمی «قبلاً verify شده» — تراکنش موفق است و نباید FAILED شود. */
const ALREADY_VERIFIED_CODE = 101

/** کدهای رسمی PaymentVerify که «رد قطعی» هستند (سند لیست خطاها). */
const VERIFY_REJECTED_CODES: ReadonlySet<number> = new Set([-50, -51, -53, -54, -55])

/** کد رسمی -52: «Oops!!, please contact our support team» — خطای غیرمنتظره‌ی provider. */
const VERIFY_UNEXPECTED_CODE = -52

/** کد رسمی -12: «Too many attempts, please try again later» — گذرا؛ نه رد قطعی. */
const CREATE_RETRYABLE_CODE = -12

/** MVP فاز ۵ فقط IRR (ریال) — هیچ تبدیل واحد انجام نمی‌شود. */
const IRR = "IRR"

/** نگاشت وضعیت‌های رسمی inquiry به وضعیت نرمال‌شده‌ی contract. */
const INQUIRY_STATUS: Readonly<Record<string, NormalizedPaymentStatus>> = {
    VERIFIED: "PAID",
    PAID: "PENDING",
    IN_BANK: "PENDING",
    FAILED: "FAILED",
    REVERSED: "FAILED",
}

// ---------- Guards (pure؛ محافظه‌کارانه و بدون any) ----------

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(source: Record<string, unknown>, key: string): string | null {
    const value = source[key]
    return typeof value === "string" ? value : null
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
    const value = source[key]
    return typeof value === "number" && Number.isFinite(value) ? value : null
}

/** بدنه‌ی `data` پاسخ — همه‌ی پاسخ‌های موفق زرین‌پال به این شکل‌اند. */
function readData(payload: unknown): Record<string, unknown> | null {
    if (!isRecord(payload)) return null
    const data = payload.data
    return isRecord(data) ? data : null
}

/** ارز غیر از IRR پذیرفته نمی‌شود: بدون تماس با provider و بدون هرگونه conversion. */
function assertIrr(currency: string): void {
    if (currency !== IRR) {
        throw new PaymentProviderError("REJECTED", "unsupported currency for billing provider")
    }
}

/**
 * `description` نزد زرین‌پال اجباری است. مقدار خالی/whitespace هرگز ارسال نمی‌شود و هیچ متن
 * ساختگی/پیش‌فرضی ساخته نمی‌شود؛ درخواست **قبل از هر تماس با provider** رد می‌شود.
 * این اعتبارسنجی ورودی است (نه پاسخ provider)، پس رد قطعی و غیرقابل‌retry است — هم‌راستا با
 * گارد currency بالا؛ `INVALID_RESPONSE` نمی‌تواند باشد چون هیچ پاسخی وجود ندارد.
 */
function requireDescription(description: string | undefined): string {
    const value = typeof description === "string" ? description.trim() : ""
    if (!value) {
        throw new PaymentProviderError("REJECTED", "billing provider requires a description")
    }
    return value
}

/**
 * callback URL مخصوص همین سفارش — سمت سرور ساخته می‌شود (سند §10/§11) و هرگز از client
 * گرفته نمی‌شود. اگر نبود، هیچ درخواستی به provider فرستاده نمی‌شود (provider بدون callback
 * بی‌معنا است و نباید URL سراسری config به‌جای آن جا زده شود).
 */
function requireCallbackUrl(callbackUrl: string | undefined): string {
    const value = typeof callbackUrl === "string" ? callbackUrl.trim() : ""
    if (!value) {
        throw new PaymentProviderError("REJECTED", "billing provider requires a callback URL")
    }
    return value
}

/**
 * مبلغ تأییدشده‌ی verify. مستندات رسمی verify وجود `amount` در پاسخ را تضمین نمی‌کنند، پس:
 * - اگر provider عدد معتبری برگرداند → همان مقدار.
 * - در غیر این صورت → `null`؛ هیچ fallback به مبلغ درخواست و هیچ مقدار ساختگی‌ای وجود ندارد.
 *
 * مبلغ درخواست (ورودی دامنه) هرگز به‌جای مبلغ تأییدشده‌ی provider جا زده نمی‌شود؛ مصرف‌کننده
 * باید `null` را «مبلغ قابل‌استناد در دسترس نیست» تفسیر کند، نه یک amount تأییدشده.
 */
function readVerifiedAmount(data: Record<string, unknown>): number | null {
    return readNumber(data, "amount")
}

// ---------- HTTP (تنها نقطه‌ی تماس با provider) ----------

/**
 * POST JSON با timeout از config. هیچ بدنه/هدر/مقدار حساسی در پیام خطا قرار نمی‌گیرد.
 * نگاشت خطا: timeout/network/abort → UNAVAILABLE · بدنه‌ی غیر-JSON → INVALID_RESPONSE.
 */
async function postJson(
    config: BillingConfig,
    path: string,
    body: Record<string, unknown>,
): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.zarinpal.timeoutMs)
    if (typeof timer.unref === "function") timer.unref()

    let rawBody: string
    try {
        const response = await fetch(`${config.zarinpal.baseUrl}${path}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify(body),
            signal: controller.signal,
            cache: "no-store",
        })
        rawBody = await response.text()
    } catch {
        // timeout/network/DNS/abort — پیام ثابت و بدون هیچ داده‌ی درخواست یا credential
        throw new PaymentProviderError("UNAVAILABLE", "provider request failed or timed out")
    } finally {
        clearTimeout(timer)
    }

    try {
        return JSON.parse(rawBody) as unknown
    } catch {
        throw new PaymentProviderError("INVALID_RESPONSE", "provider response was not valid JSON")
    }
}

// ---------- Contract implementation ----------

/** `POST /pg/v4/payment/request.json` — سند: موفقیت فقط `data.code === 100` + authority غیرخالی. */
async function createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const config = getBillingConfig()
    assertIrr(input.currency)
    const description = requireDescription(input.description)
    const callbackUrl = requireCallbackUrl(input.callbackUrl)

    const payload = await postJson(config, API_PATHS.create, {
        merchant_id: config.zarinpal.merchantId,
        amount: input.amount,
        currency: input.currency,
        // (referrer_id/metadata/mobile/email/order_id ارسال نمی‌شوند.)
        description,
        // callback مخصوص همین سفارش (شامل `ref` ارجاع داخلی) — نه URL سراسری config
        callback_url: callbackUrl,
    })

    const data = readData(payload)
    const code = data ? readNumber(data, "code") : null
    if (data === null || code === null) {
        throw new PaymentProviderError("INVALID_RESPONSE", "provider create response was invalid")
    }
    if (code === CREATE_RETRYABLE_CODE) {
        // -12 «Too many attempts» گذراست، نه رد قطعی → retryable (هیچ retry خودکاری انجام نمی‌شود)
        throw new PaymentProviderError("UNAVAILABLE", "provider is temporarily rejecting new requests")
    }
    if (code !== SUCCESS_CODE) {
        throw new PaymentProviderError("REJECTED", "provider rejected the payment request")
    }

    const authority = (readString(data, "authority") ?? "").trim()
    if (!authority) {
        throw new PaymentProviderError("INVALID_RESPONSE", "provider create response had no authority")
    }

    return {
        authority,
        redirectUrl: buildRedirectUrl(authority),
    }
}

/**
 * `POST /pg/v4/payment/verify.json` — amount دقیقاً همان مبلغ دامنه ارسال می‌شود (بدون conversion).
 * `100` → موفق با reference · `101` → موفق/قبلاً verify شده با reference = null.
 * amount پاسخ فقط اگر provider عدد معتبری برگرداند پر می‌شود؛ در غیر این صورت `null`
 * (هیچ fallback به مبلغ درخواست و هیچ مقدار ساختگی).
 */
async function verifyPayment(input: VerifyPaymentInput): Promise<VerifyPaymentResult> {
    const config = getBillingConfig()

    const payload = await postJson(config, API_PATHS.verify, {
        merchant_id: config.zarinpal.merchantId,
        amount: input.amount,
        authority: input.authority,
    })

    const data = readData(payload)
    const code = data ? readNumber(data, "code") : null
    if (data === null || code === null) {
        throw new PaymentProviderError("INVALID_RESPONSE", "provider verify response was invalid")
    }

    if (code === ALREADY_VERIFIED_CODE) {
        // «قبلاً verify شده» یعنی پرداخت موفق بوده؛ ref_id برای این کد تضمین نشده → null
        return { reference: null, amount: readVerifiedAmount(data) }
    }

    if (code === SUCCESS_CODE) {
        const refId = readNumber(data, "ref_id")
        if (refId === null) {
            throw new PaymentProviderError("INVALID_RESPONSE", "provider verify response had no reference")
        }
        return { reference: String(refId), amount: readVerifiedAmount(data) }
    }

    if (code === VERIFY_UNEXPECTED_CODE) {
        // -52 «خطای غیرمنتظره‌ی provider» است، نه رد قطعی؛ طبق سند §13 در حالت نامعلوم
        // سفارش باید PENDING بماند و نتیجه retryable باشد → UNAVAILABLE (retryable = true).
        throw new PaymentProviderError("UNAVAILABLE", "provider verify reported an unexpected error")
    }

    if (VERIFY_REJECTED_CODES.has(code)) {
        throw new PaymentProviderError("REJECTED", "provider verify was rejected")
    }

    // کد ناشناسِ غیرموفق: قطعی در نظر گرفته می‌شود (هیچ retry کوری انجام نمی‌شود).
    throw new PaymentProviderError("REJECTED", "provider verify returned an unrecognized failure code")
}

/**
 * `POST /pg/v4/payment/inquiry.json` — فقط وضعیت provider را normalize می‌کند.
 * هیچ entitlement‌ای فعال نمی‌کند و جای verify را نمی‌گیرد (سند رسمی inquiry هم صریحاً
 * می‌گوید از این متد برای تأیید/verify استفاده نکنید).
 */
async function inquirePayment(input: InquirePaymentInput): Promise<InquirePaymentResult> {
    const config = getBillingConfig()

    const payload = await postJson(config, API_PATHS.inquiry, {
        merchant_id: config.zarinpal.merchantId,
        authority: input.authority,
    })

    const data = readData(payload)
    const status = data ? readString(data, "status") : null

    if (status === null) {
        // شکل رسمی پاسخ ناموفق: `{ message, errors: { authority: [ ..., "-54" ] } }` بدون data
        if (isRecord(payload) && "errors" in payload) {
            throw new PaymentProviderError("REJECTED", "provider inquiry was rejected")
        }
        throw new PaymentProviderError("INVALID_RESPONSE", "provider inquiry response was invalid")
    }

    return {
        status: INQUIRY_STATUS[status] ?? "UNKNOWN",
        // مستندات inquiry نه reference برمی‌گرداند و نه amount → null (هیچ مقداری جعل نمی‌شود)
        reference: null,
        amount: null,
    }
}

/**
 * پارس پارامترهای خام و UNTRUSTED callback (`Authority`, `Status`) به نتیجه‌ی نرمال‌شده.
 * خالص و بدون I/O: هیچ verify/DB/تفسیر پرداختی اینجا نیست و callback هرگز خودش PAID نمی‌سازد.
 */
function parseCallback(input: ParseCallbackInput): NormalizedCallback {
    const authority = typeof input.authority === "string" ? input.authority.trim() : ""
    const rawStatus = typeof input.status === "string" ? input.status.trim() : ""

    // فقط دو مقدار رسمی مستندشده؛ هر چیز دیگر (از جمله حروف کوچک) → UNKNOWN
    let status: NormalizedCallbackStatus = "UNKNOWN"
    if (rawStatus === "OK") status = "SUCCESS"
    else if (rawStatus === "NOK") status = "FAILURE"

    return { authority, status }
}

/** پیاده‌سازی provider-neutral contract فاز ۵ برای زرین‌پال. */
export const zarinpalProvider: PaymentProvider = {
    id: PROVIDER_ID,
    createPayment,
    verifyPayment,
    inquirePayment,
    parseCallback,
}
