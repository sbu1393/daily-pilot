// فاز ۵ — گام ۱۱: callback زرین‌پال (GET) — سند §11، §13، §14، §15، §20، §28، §33
//
// این endpoint بازگشتِ **مرورگر کاربر** از درگاه است: ورودی‌ها کاملاً UNTRUSTED هستند و خروجی
// مسیر عادی همیشه یک ریدایرکت به یکی از دو مقصد ثابت config است (success/failure) — نه Envelope
// JSON. تنها استثناء، نقص پیکربندی سرور است که هیچ مقصد امنی باقی نمی‌گذارد: آن‌جا همان Envelope
// استاندارد خطای پیکربندی (۵۰۰) برگردانده می‌شود، بدون حدس/fallback و بدون افشای مقدار config.
//
// جریان LOCKED (قرارداد نهایی A1–A7):
//   ۱) request context/requestId از زیرساخت موجود observability
//   ۲) parse پارامترهای callback با `zarinpalProvider.parseCallback` (خالص؛ فقط Authority/Status)
//   ۳) الزامی بودن `ref` و `Authority` — در نبود هرکدام → نتیجه‌ی شکست (بدون لاگ مقدار خام)
//   ۴) resolve سفارش: `ref` = `merchantOrderId` + تطابق دوگانه با Authority (A2) → PAYMENT_NOT_FOUND
//   ۵) state gate (A5): PAID → موفق idempotent و بدون verify · FAILED/EXPIRED/CANCELED → شکست و بدون verify
//      A4: PENDINGِ گذشته از `expiresAt` → شکست (بدون grant، بدون revive، بدون سفارش تازه)
//      A3: `Status=NOK` → شکست بدون هیچ mutation (Status هرگز تصمیم نهایی نمی‌گیرد)
//   ۶) verify سمت سرور **بیرون از هر DB transaction** (سند §28) — بدون retry خودکار (سند §7)
//   ۷) `finalizeVerifiedPayment` (مالک transaction؛ از گام‌های ۹/۱۰ دست‌نخورده)
//   ۸) ریدایرکت به مقصد ثابت config (A1)
//
// مرزها و امنیت (سند §33):
// - احراز هویت لازم نیست (provider مرورگر کاربر را می‌فرستد) و هیچ query paramی قابل اعتماد نیست؛
//   تصمیم نهایی فقط بر اساس state سروری + verify سمت سرور گرفته می‌شود.
// - مقصد ریدایرکت فقط از config سروری می‌آید (مطلق http(s)) → هیچ open redirect و هیچ
//   destination کنترل‌شده توسط کلاینت وجود ندارد.
// - هیچ پیلود خام provider، هیچ پارامتر خام callback، هیچ secret/merchant/token و هیچ داده‌ی
//   کارتی لاگ یا برگردانده نمی‌شود؛ فقط خطاهای عملیاتی نرمال‌شده به observability می‌روند.
// - بدون raw SQL، بدون SDK، بدون queue/lock و بدون rate limiting (A6: هیچ عددی اختراع نمی‌شود).
//
// فاز ۵ — گام ۱۴ (observability integration، سند §۲۲):
// - شکست‌های عملیاتی (config/provider/verify/finalize) طبق قرارداد موجود `recordError` ثبت می‌شوند؛
//   category/severity آن‌ها از taxonomy بیلینگ (فاز ۵ §۲۰) می‌آید، نه fallback عمومی.
// - «duplicate successful callback» فقط یک مشاهده‌ی کم‌نویز است (severity=INFO، کد IDEMPOTENCY_CONFLICT
//   که طبق policy فاز ۲ §۱۹ هرگز در ErrorLog ذخیره نمی‌شود) — تکرار خطا ثبت نمی‌شود.
// - هیچ telemetry/لاگی مسیر پاسخ را نمی‌شکند: `recordError` خودش fail-open است و خروجی این route
//   همیشه همان ریدایرکت ثابت یا Envelope خطای config باقی می‌ماند.
//
// فاز ۵ — گام ۱۵ (ProductEvent، سند §۲۳):
// - فقط دو رویداد مجازند: `billing.entitlement_activated` (اولین فعال‌سازی) و
//   `billing.entitlement_renewed` (امتداد دوره‌ی فعال).
// - ثبت **فقط بعد از commit تراکنش finalization** و **فقط برای finalization واقعی همین درخواست**
//   (`finalized === true`) — پس replay/duplicate callback هیچ رویداد تکراری نمی‌سازد.
// - properties فقط از قرارداد فاز ۳ می‌آیند (provider/مدت/نوع تمدید)؛ هیچ Authority/پیلود خام/
//   خطای خام/کارت و هیچ PII اضافه‌ای وارد رویداد نمی‌شود؛ userId فقط از snapshot سروری سفارش است.
// - fail-open: شکست analytics هرگز ریدایرکت نتیجه را تغییر نمی‌دهد.
//
// خارج از scope این route: subscription، quota، admin، frontend و هر تغییر
// schema/migration. طبق A3 ثبت FAILED/CANCELED/failureCode هم در callback انجام نمی‌شود.

import { NextRequest, NextResponse } from "next/server"

import type { VerifyPaymentResult } from "@/app/lib/billing/provider"
import { zarinpalProvider } from "@/app/lib/billing/zarinpal.adapter"
import { getPrisma } from "@/app/lib/getPrisma"
import { errorResponse, toServiceErrorResponse } from "@/app/lib/apiResponse"
import { IdempotencyConflictError, PaymentNotFoundError } from "@/app/lib/services/errors"
import { recordProductEvent } from "@/app/lib/services/productEvent.service"
import {
    finalizeVerifiedPayment,
    resolveCallbackOrder,
    resolveCallbackResultUrls,
    type CallbackResultUrls,
    type PaymentOrderRecord,
} from "@/app/lib/services/billing.service"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import type { ObservabilityContext } from "@/src/lib/observability/types"

/** فقط همین دو رویداد billing مجاز است (سند §۲۳) — هیچ نام دیگری ساخته نمی‌شود. */
const ENTITLEMENT_ACTIVATED_EVENT = "billing.entitlement_activated" as const
const ENTITLEMENT_RENEWED_EVENT = "billing.entitlement_renewed" as const

/**
 * ریدایرکت امن (A1): مقصد فقط از config سروری می‌آید و هیچ‌وقت از ورودی درخواست ساخته نمی‌شود.
 * `no-store` تا نتیجه‌ی پرداخت cache نشود و مرورگر همیشه تازه‌ترین ریدایرکت را ببیند.
 * کد ۳۰۲ سبک استاندارد بازگشت از درگاه است (GET→GET، بدون preserve کردن متد).
 */
function redirectTo(url: string): NextResponse {
    const response = NextResponse.redirect(url, 302)
    response.headers.set("Cache-Control", "no-store")
    return response
}

/**
 * A4/§15 — بررسی انقضای lazy، فقط خواندن. callback هیچ سفارشی را expire/revive نمی‌کند؛
 * materialize شدن PENDING→EXPIRED کار مسیر checkout است و این‌جا تکرار نمی‌شود.
 */
function isPastDue(order: PaymentOrderRecord, now: Date): boolean {
    return now.getTime() > order.expiresAt.getTime()
}

/**
 * سند §۲۲ — «Duplicate successful callback: low-noise observation only — not repeatedly recorded as
 * an error»: یک مشاهده‌ی ساختاریافته با severity=INFO و کد `IDEMPOTENCY_CONFLICT` (طبق policy فاز ۲ §۱۹
 * در ErrorLog ذخیره **نمی‌شود**؛ فقط مسیر console). هیچ کد/کلاس جدیدی ساخته نمی‌شود، هیچ مقدار خامی
 * (Authority/merchant/ref/پارامتر خام) وارد رکورد نمی‌شود، و شکست telemetry به‌خاطر fail-open بودن
 * `recordError` هرگز پاسخ (ریدایرکت) را نمی‌شکند.
 */
function observeDuplicateCallback(context: ObservabilityContext): void {
    recordError(new IdempotencyConflictError(), context, { category: "CONFLICT", severity: "INFO" })
}

// GET /api/billing/callback/zarinpal — بازگشت مرورگر کاربر از درگاه (سند §11)
export async function GET(req: NextRequest) {
    // ۱) context/requestId از زیرساخت موجود observability
    const context = createObservabilityContext("/api/billing/callback/zarinpal", "billing")

    // مقصدهای نتیجه فقط سرور-محورند؛ اگر config نامعتبر باشد هیچ مقصد امنی برای ریدایرکت
    // وجود ندارد و به‌جای حدس، همان Envelope استاندارد خطای پیکربندی برگردانده می‌شود (سند §20).
    let resultUrls: CallbackResultUrls
    try {
        resultUrls = resolveCallbackResultUrls()
    } catch (error) {
        recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }

    const success = () => redirectTo(resultUrls.successUrl)
    const failure = () => redirectTo(resultUrls.failureUrl)

    try {
        // ۲/۳) پارامترها کاملاً UNTRUSTED هستند: فقط normalize می‌شوند و هیچ مقدار خامی
        //      لاگ/برگردانده نمی‌شود. `Status` به‌تنهایی هرگز ملاک نهایی نیست (سند §11/§13).
        const params = req.nextUrl.searchParams
        const ref = (params.get("ref") ?? "").trim()
        const parsed = zarinpalProvider.parseCallback({
            authority: params.get("Authority"),
            status: params.get("Status"),
        })

        if (!ref || !parsed.authority) return failure()

        // ۴) resolve سفارش: ref (merchantOrderId) + تطابق دوگانه با Authority (A2)
        const prisma = getPrisma()
        const order = await resolveCallbackOrder(prisma, { ref, authority: parsed.authority })

        // ۵) state gate (A5) — سفارش terminal هرگز provider را صدا نمی‌زند و هیچ‌وقت زنده نمی‌شود
        if (order.status === "PAID") {
            // duplicate callback = موفق idempotent (بدون provider/بدون mutation) + مشاهده‌ی کم‌نویز
            observeDuplicateCallback(context)
            return success()
        }
        if (order.status !== "PENDING") return failure() // FAILED / EXPIRED / CANCELED

        // A4 — PENDINGِ گذشته از expiresAt منقضی است: بدون entitlement، بدون revive، بدون سفارش تازه
        if (isPastDue(order, new Date())) return failure()

        // A3 — `Status=NOK` تنها سیگنال قطعی منفی provider است: شکست بدون هیچ mutation روی سفارش.
        //      `SUCCESS`/`UNKNOWN` تصمیم نهایی را به verify سمت سرور می‌سپارند.
        if (parsed.status === "FAILURE") return failure()

        // Authority تأییدشده‌ی سروری (برابری با ورودی قبلاً اثبات شده) — نه مقدار خام callback
        const authority = order.providerAuthority
        if (authority === null) return failure()

        // ۶) verify **بیرون از هر DB transaction** (سند §28) — بدون retry خودکار (سند §7).
        //    timeout/outage/rejection/پاسخ نامعتبر → سفارش دست‌نخورده می‌ماند و نتیجه شکست است (A3).
        let verification: VerifyPaymentResult
        try {
            verification = await zarinpalProvider.verifyPayment({
                authority,
                amount: order.amount,
            })
        } catch (error) {
            recordError(error, context)
            return failure()
        }

        // A4 — پیش از finalization یک‌بار دیگر state/expiry تازه خوانده می‌شود (verify زمان‌بر بوده است)
        const current = await resolveCallbackOrder(prisma, { ref, authority })
        if (current.status === "PAID") {
            // هم‌زمان توسط callback دیگری نهایی شده → همان موفقیت idempotent + مشاهده‌ی کم‌نویز
            observeDuplicateCallback(context)
            return success()
        }
        if (current.status !== "PENDING" || isPastDue(current, new Date())) return failure()

        // ۷) finalize اتمیک (مالکیت transaction دست‌نخورده از گام ۹؛ provider داخل آن صدا زده نمی‌شود)
        const finalized = await finalizeVerifiedPayment(prisma, { authority, verification })

        // ۷.۱) گام ۱۵ (سند §۲۳) — ProductEvent **بعد از commit تراکنش** و **فقط برای
        //      finalization واقعی همین درخواست**: replay/duplicate (finalized=false) هیچ
        //      رویدادی ثبت نمی‌کند → رویداد تکراری روی callback تکراری ممکن نیست.
        //      properties از snapshot سروری سفارش‌اند؛ هیچ شناسه‌ی provider/پرداخت یا PII اضافه نمی‌شود.
        if (finalized.finalized && finalized.entitlementAction !== null) {
            try {
                await recordProductEvent(
                    finalized.order.userId,
                    finalized.entitlementAction === "RENEWED"
                        ? ENTITLEMENT_RENEWED_EVENT
                        : ENTITLEMENT_ACTIVATED_EVENT,
                    finalized.entitlementAction === "RENEWED"
                        ? {
                              provider: finalized.order.provider,
                              entitlementDays: finalized.order.entitlementDays,
                              renewalType: "EXTENDS_CURRENT",
                          }
                        : {
                              provider: finalized.order.provider,
                              entitlementDays: finalized.order.entitlementDays,
                          },
                    {
                        requestId: context.requestId,
                        endpoint: "/api/billing/callback/zarinpal",
                        feature: "billing",
                    },
                )
            } catch {
                // fail-open — analytics failure هرگز ریدایرکت نتیجه‌ی پرداخت را تغییر نمی‌دهد (§۲۳)
            }
        }

        // ۸) فقط PAID نتیجه‌ی موفق است؛ finalize تکراری هم no-op موفق برمی‌گرداند (سند §14)
        return finalized.order.status === "PAID" ? success() : failure()
    } catch (error) {
        // PAYMENT_NOT_FOUND (ref ناموجود یا عدم تطابق Authority) رفتار عادی و بدون لاگ است؛
        // سایر شکست‌های عملیاتی (مبلغ نامعتبر، entitlement conflict، خطای غیرمنتظره) ثبت می‌شوند.
        if (!(error instanceof PaymentNotFoundError)) recordError(error, context)
        return failure()
    }
}
