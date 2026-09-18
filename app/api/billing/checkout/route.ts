// فاز ۵ — گام ۱۰: Checkout orchestration (سند §6، §7، §10، §14، §15، §25)
//
// جریان LOCKED (سند §10):
//   authentication → validation (Idempotency-Key) → server-side product config
//   → prepare/reuse PaymentOrder (idempotency) → provider createPayment **خارج از تراکنش**
//   → persist providerAuthority → پاسخ امن (orderId/status/redirectUrl/expiresAt)
//
// مرزها:
// - transaction (سند §10/§28): هیچ DB transactionی هنگام انتظار provider باز نیست؛ در این route
//   هیچ `$transaction` باز نمی‌شود. finalization (گام ۱۱) تنها مالک transaction است.
// - دامنه (سند §4/§5): مقادیر authoritative (amount/currency/entitlementDays/provider) فقط از config
//   سروری، userId فقط از context احراز‌شده، و merchantOrderId/expiresAt سمت سرور ساخته می‌شوند.
//   client هیچ‌یک از این‌ها را تعیین نمی‌کند.
// - provider (سند §7): هیچ retry خودکاری وجود ندارد؛ timeout/outage → سفارش PENDING +
//   PAYMENT_PROVIDER_UNAVAILABLE؛ رد → PAYMENT_PROVIDER_REJECTED؛ پاسخ نامعتبر →
//   PAYMENT_PROVIDER_INVALID_RESPONSE؛ وضعیت نامعلوم پس از تعامل موفق → PAYMENT_STATE_UNRESOLVED.
// - callback URL هر سفارش سمت سرور از config + `ref=<merchantOrderId>` ساخته می‌شود (سند §6/§11)؛
//   هیچ مسیر open-redirect و هیچ ورودی client در آن وجود ندارد.
// - log/return نمی‌شود (سند §33): merchant secret، raw provider request/response، raw error provider،
//   card data، Authorization/cookie/JWT و بدنه‌ی خام درخواست.
// - rate limit (سخت‌سازی امنیتی): شروع پرداخت یک عملیات حساس/پرهزینه است (هر درخواست تازه یک
//   فراخوانی provider + یک سفارش DB می‌سازد). از همان limiter درون‌حافظه‌ی موجود استفاده می‌شود
//   (بدون dependency جدید) با کلید user-scoped — پس پشت پراکسی/NAT رفتار درست است. محدودیت فقط
//   نرخ را می‌بندد و هیچ semantics دیگری (idempotency/state) را تغییر نمی‌دهد.
// - خارج از scope این گام: callback/finalization (گام ۱۱)، subscription، ProductEvent (گام ۱۵)،
//   quota، getCurrentUser، admin و هر تغییری در schema/migration.

import { NextRequest } from "next/server"

import type { BillingProviderId } from "@/app/lib/billing/config"
import type { PaymentProvider } from "@/app/lib/billing/provider"
import { PaymentProviderError } from "@/app/lib/billing/provider"
import { buildRedirectUrl, zarinpalProvider } from "@/app/lib/billing/zarinpal.adapter"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { getPrisma } from "@/app/lib/getPrisma"
import { isRateLimited } from "@/app/lib/rateLimit"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"
import {
    attachProviderAuthority,
    prepareCheckout,
    resolveCheckoutSettings,
    type CheckoutSettings,
    type PaymentOrderRecord,
} from "@/app/lib/services/billing.service"
import {
    PaymentConfigurationError,
    PaymentProviderInvalidResponseError,
    PaymentProviderRejectedError,
    PaymentProviderUnavailableError,
    PaymentStateUnresolvedError,
} from "@/app/lib/services/errors"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

/**
 * انتخاب provider سمت سرور (سند §4). MVP فاز ۵ فقط یک provider دارد؛ ناسازگاری مقدار
 * provider با implementation موجود یعنی config سرور نامعتبر است → PAYMENT_CONFIGURATION_ERROR.
 * هیچ ورودی client در این انتخاب دخالت ندارد.
 */
function resolveCheckoutProvider(providerId: BillingProviderId): PaymentProvider {
    if (providerId !== zarinpalProvider.id) throw new PaymentConfigurationError()
    return zarinpalProvider
}

/**
 * callback URL مخصوص همین سفارش (سند §11: «Payment identity comes from the internal payment
 * reference stored in the callback URL plus the provider Authority»).
 *
 * - base فقط از config سروری (`BILLING_ZARINPAL_CALLBACK_URL`) می‌آید و client نمی‌تواند عوضش کند.
 * - ارجاع داخلی (`ref`) همان `merchantOrderId` سروری است (هرگز از ورودی کاربر).
 * - ساخت با URL API استاندارد: queryهای موجود base حفظ می‌شوند و هیچ چسباندن دستی رشته نیست.
 * - مقصد redirect/بازگشت client-controlled نیست، پس open-redirect ممکن نیست.
 */
function buildOrderCallbackUrl(baseUrl: string, merchantOrderId: string): string {
    const url = new URL(baseUrl)
    url.searchParams.set("ref", merchantOrderId)
    return url.toString()
}

/**
 * ایجاد پرداخت نزد provider با نگاشت کامل `PaymentProviderError.kind` به taxonomy بیلینگ (سند §7/§10):
 * UNAVAILABLE → PAYMENT_PROVIDER_UNAVAILABLE · REJECTED → PAYMENT_PROVIDER_REJECTED ·
 * INVALID_RESPONSE → PAYMENT_PROVIDER_INVALID_RESPONSE. پیام/بدنه‌ی provider هرگز منتقل نمی‌شود؛
 * فقط kind نگاشت می‌شود تا هیچ داده‌ی خامی به log/پاسخ نرسد.
 */
async function requestProviderPayment(
    provider: PaymentProvider,
    order: PaymentOrderRecord,
    settings: CheckoutSettings,
    callbackUrl: string,
) {
    try {
        // همه‌ی مقادیر از snapshot سروری سفارش/config می‌آیند — هیچ مقدار client این‌جا نیست.
        return await provider.createPayment({
            merchantOrderId: order.merchantOrderId,
            amount: order.amount,
            currency: order.currency,
            callbackUrl,
            description: settings.description,
        })
    } catch (error) {
        if (error instanceof PaymentProviderError) {
            if (error.kind === "UNAVAILABLE") throw new PaymentProviderUnavailableError()
            if (error.kind === "REJECTED") throw new PaymentProviderRejectedError()
            throw new PaymentProviderInvalidResponseError()
        }
        throw error
    }
}

/**
 * پاسخ امن (سند §25/§10): فقط orderId/status/redirectUrl/expiresAt.
 * `redirectUrl === null` یعنی سفارش terminal است و هیچ آدرس پرداختی برگردانده نمی‌شود.
 * در غیر این صورت redirect فقط از authority ذخیره‌شده‌ی سرور ساخته شده است.
 */
function checkoutResponse(order: PaymentOrderRecord, redirectUrl: string | null, requestId: string) {
    return okResponse(
        {
            orderId: order.id,
            status: order.status,
            ...(redirectUrl === null ? {} : { redirectUrl }),
            expiresAt: order.expiresAt,
        },
        { requestId },
    )
}

// POST /api/billing/checkout — شروع/ادامه‌ی یک checkout idempotent (سند §25)
export async function POST(req: NextRequest) {
    const context = createObservabilityContext("/api/billing/checkout", "billing")
    try {
        // ۱) authentication — نبود نشست → همان 401 موجود
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        // ۲) rate limit — حداکثر ۱۰ شروع پرداخت در ۱۵ دقیقه برای هر کاربر احراز‌شده.
        //    پیش از هر کار/کوئری/فراخوانی provider بررسی می‌شود تا ارسال انبوه سفارش و
        //    hammering درگاه پرداخت بسته باشد. کلید شامل userId است، پس قابل دور زدن با IP نیست.
        if (isRateLimited(`checkout:user:${user.id}`, 10, 15 * 60 * 1000)) {
            return errorResponse(
                429,
                "RATE_LIMITED",
                "تعداد درخواست‌های پرداخت زیاد شده؛ کمی بعد دوباره تلاش کن",
                undefined,
                context.requestId,
            )
        }

        // ۳) اعتبارسنجی Idempotency-Key (سند §6 مرحله ۲): required/non-empty پس از trim.
        // Blueprint هیچ max length تعیین نکرده، پس هیچ عدد دلخواهی اضافه نشده است.
        const rawKey = req.headers.get("idempotency-key")
        const idempotencyKey = typeof rawKey === "string" ? rawKey.trim() : ""
        if (!idempotencyKey) {
            return validationErrorResponse(
                { idempotencyKey: "هدر Idempotency-Key الزامی و باید غیرخالی باشد" },
                undefined,
                context.requestId,
            )
        }

        // ۴) config سروری (سند §10) — خطای config به PAYMENT_CONFIGURATION_ERROR نگاشت شده است
        const settings = resolveCheckoutSettings()
        const provider = resolveCheckoutProvider(settings.provider)
        const prisma = getPrisma()

        // ۵) idempotency lookup/create + lazy expiration سفارش PENDING (سند §6/§14/§15)
        const { order, reused } = await prepareCheckout(prisma, {
            userId: user.id,
            checkoutIdempotencyKey: idempotencyKey,
            orderTtlMs: settings.orderTtlMs,
            // correlation فقط (سند §22) — هرگز جای Idempotency-Key نیست (سند §6)
            requestId: context.requestId,
        })

        // ۶) سفارش terminal (PAID/FAILED/CANCELED/EXPIRED) → نتیجه‌ی idempotent بدون هیچ mutation،
        //    هیچ provider call و هیچ redirectی. هیچ revive و هیچ کد «already processed» وجود ندارد
        //    و خرید جدید نیازمند کلید idempotency تازه است (سند §14/§15).
        if (order.status !== "PENDING") {
            return checkoutResponse(order, null, context.requestId)
        }

        // ۷) سفارش PENDING با authority → هیچ create دوباره‌ای؛ redirect از همان authority ذخیره‌شده
        if (order.providerAuthority !== null) {
            return checkoutResponse(
                order,
                buildRedirectUrl(order.providerAuthority),
                context.requestId,
            )
        }

        // ۸) سفارش PENDING بدون authority که «reuse» شده است یعنی یک تلاش قبلی، createPayment را
        //    موفق خوانده ولی authority را persist نکرده است. این‌جا هیچ create دوباره‌ای انجام نمی‌شود
        //    (خطر پرداخت تکراری نزد provider) و هیچ مقدار جعلی ساخته نمی‌شود → وضعیت قابل‌تعیین نیست.
        if (reused) throw new PaymentStateUnresolvedError()

        // ۹) سفارش تازه‌ی PENDING → createPayment **بیرون از هر DB transaction** (سند §7/§10)
        const callbackUrl = buildOrderCallbackUrl(settings.callbackUrl, order.merchantOrderId)
        const created = await requestProviderPayment(provider, order, settings, callbackUrl)

        // ۱۰) persist کردن authority روی همان سفارش (شرطی و بدون overwrite). شکست این مرحله →
        //    سفارش PENDING می‌ماند و PAYMENT_STATE_UNRESOLVED برمی‌گردد (هیچ create دوباره‌ای).
        const attached = await attachProviderAuthority(prisma, {
            userId: user.id,
            checkoutIdempotencyKey: idempotencyKey,
            authority: created.authority,
        })

        // ۱۱) redirect صرفاً از authority ذخیره‌شده ساخته می‌شود؛ payload خام provider به client نمی‌رود
        if (attached.providerAuthority === null) throw new PaymentStateUnresolvedError()
        return checkoutResponse(
            attached,
            buildRedirectUrl(attached.providerAuthority),
            context.requestId,
        )
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
