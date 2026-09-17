// فاز ۵ — گام ۹: سرویس Billing (orchestration سمت سرور پرداخت) — سند فاز ۵ §2، §4، §6، §7، §13،
// §14، §27، §28، §29، §30
//
// مسئولیت (سند §27: «billing.service — checkout · callback processing · payment lifecycle
// orchestration») فقط دو operation در این گام:
//   prepareCheckout          → ساخت/بازیابی idempotent سفارش پرداخت (PENDING) از config سروری
//   finalizeVerifiedPayment  → نهایی‌سازی اتمیک پرداخت تأییدشده + entitlement + User.plan + link
//
// قواعد LOCKED:
// - provider-neutral: این فایل هیچ provider/adapter/URL/merchant را نمی‌شناسد و **هیچ تماس
//   provider‌ای** انجام نمی‌دهد؛ `provider` سفارش فقط از provider selection سروری (config) می‌آید
//   (سند §4) و provider call/authority persistence کار گام checkout route است (سند §10).
// - transaction boundary (سند §28): provider call بیرون از transaction است و transaction فقط
//   finalization داخلی DB را در بر می‌گیرد: load/check سفارش → transition شرطی PENDING→PAID →
//   entitlement (از entitlement.service، همان tx) → User.plan=PRO (داخل همان سرویس) →
//   entitlementId → paidAt → commit. بدون raw SQL / $queryRaw / $executeRaw / SERIALIZABLE /
//   SELECT ... FOR UPDATE / lock / queue.
// - مقادیر authoritative فقط سروری‌اند (سند §4/§5/§33): amount/currency/entitlementDays از
//   config، userId از context احراز‌شده، merchantOrderId و expiresAt سمت سرور ساخته می‌شوند؛
//   هیچ ورودی client در این سرویس مصرف نمی‌شود و هیچ business value‌ای حدس زده نمی‌شود.
// - idempotency (سند §6): کلید `userId + checkoutIdempotencyKey` (unique در اسکیمای فاز ۵)؛
//   پارامترهای immutable ناسازگار → PAYMENT_IDEMPOTENCY_CONFLICT؛ `requestId` هرگز idempotency
//   نیست و فقط correlation است (سند §6/§22).
// - finalization (سند §13/§14/§28): فقط سفارش PENDING نهایی می‌شود؛ سفارش PAID فقط state نهایی
//   را برمی‌گرداند (duplicate callback = no-op) و هرگز دوباره entitlement نمی‌گیرد؛ سفارش‌های
//   terminal دیگر (FAILED/EXPIRED/CANCELED) زنده نمی‌شوند؛ mismatch مبلغ → PAYMENT_INVALID_AMOUNT
//   و `amount === null` به‌معنی mismatch نیست (قرارداد provider گام ۵/۶).
// - خطاها فقط از taxonomy موجود (گام ۷) هستند؛ هیچ error جدیدی ساخته نمی‌شود.
// - log/persist نمی‌شود: merchant secret، raw callback، raw provider response، card data،
//   JWT/cookie/Authorization (سند §33). هیچ ProductEvent‌ای در این گام ثبت نمی‌شود (گام ۱۵).
//
// گام ۱۰ (checkout orchestration) روی همین فایل اضافه کرد:
//   resolveCheckoutSettings    → خواندن تنظیمات سروری checkout (TTL/description/callback/ provider)
//   attachProviderAuthority    → persist کردن authority برگردانده‌شده‌ی provider روی سفارش PENDING
//   + lazy expiration سفارش PENDING گذشته از expiresAt داخل idempotency lookup
//
// همچنان خارج از scope (طبق قرارداد قطعی): تماس provider (این فایل provider-neutral است و
// هیچ adapter/URL/merchant را نمی‌شناسد)، ثبت FAILED/failureCode، routeها، ProductEvent،
// quota/getCurrentUser و admin.

import { randomUUID } from "node:crypto"

import { getBillingConfig, type BillingProviderId } from "../billing/config"
import type { VerifyPaymentResult } from "../billing/provider"
import type { PrismaClientLike } from "./aiUsage.service"
import { activate, renew, type EntitlementRecord } from "./entitlement.service"
import {
    PaymentConfigurationError,
    PaymentIdempotencyConflictError,
    PaymentInvalidAmountError,
    PaymentNotFoundError,
    PaymentStateUnresolvedError,
    PaymentVerificationFailedError,
    ServiceError,
} from "./errors"

/** مقادیر enum قفل‌شده‌ی `PaymentOrderStatus` در اسکیمای فاز ۵ (سند §3.2). */
export type PaymentOrderStatusValue = "PENDING" | "PAID" | "FAILED" | "EXPIRED" | "CANCELED"

/**
 * شکل ردیف PaymentOrder که این سرویس برمی‌گرداند (record ساختاری، بدون expose کردن object خام).
 *
 * نکته: `prisma generate` برای اسکیمای فاز ۵ اجرا نشده است (تصمیم گام ۳)؛ این اینترفیس دقیقاً
 * همان ستون‌های اسکیمای فاز ۵ است و بعد از generate می‌توان آن را با تایپ تولیدشده جایگزین کرد.
 */
export interface PaymentOrderRecord {
    id: string
    userId: number
    provider: BillingProviderId
    merchantOrderId: string
    checkoutIdempotencyKey: string
    amount: number
    currency: string
    status: PaymentOrderStatusValue
    providerAuthority: string | null
    providerReference: string | null
    entitlementDays: number
    requestId: string | null
    expiresAt: Date
    paidAt: Date | null
    failureCode: string | null
    entitlementId: string | null
}

/** محصول سروری که هر سفارش از آن snapshot می‌شود (سند §4/§5). */
interface CheckoutProduct {
    provider: BillingProviderId
    amount: number
    currency: string
    entitlementDays: number
}

export interface PrepareCheckoutInput {
    /** از context احراز‌شده‌ی سرور (سند §33) — هرگز از client. */
    userId: number
    /** هدر Idempotency-Key درخواست (سند §6)؛ اعتبارسنجی شکل آن کار route است (سند §35). */
    checkoutIdempotencyKey: string
    /**
     * مهلت پرداخت سفارش بر حسب میلی‌ثانیه — از سمت سرور (caller).
     *
     * این سرویس این مقدار را حدس نمی‌زند: در Blueprint هیچ مقدار/کلید configی برای عمر سفارش
     * تعریف نشده (سند §15 فقط `now > expiresAt` را می‌گوید) و تغییر config خارج از scope این گام
     * است. پس `expiresAt` سروری ساخته می‌شود اما نرخ آن صریحاً از caller می‌آید.
     */
    orderTtlMs: number
    /** correlation اختیاری (سند §22) — هرگز idempotency نیست (سند §6). */
    requestId?: string
}

export interface CheckoutPreparation {
    order: PaymentOrderRecord
    /** true = سفارش موجود برای همین کلید بازیابی شد (route نباید پرداخت دوم بسازد — سند §6). */
    reused: boolean
}

export interface FinalizePaymentInput {
    /**
     * authority پرداخت که caller سمت سرور می‌شناسد (سند §13). همان کلید resolve سفارش است، پس
     * شرط «Authority matches» سند §13 ساختاری است و مسیر mismatch اصلاً وجود ندارد.
     */
    authority: string
    /**
     * نتیجه‌ی نرمال‌شده‌ی verify سمت سرور (گام ۵/۶): `reference` می‌تواند null باشد (verify تکراری
     * provider) و `amount === null` یعنی «provider مبلغ قابل استناد نداد» — نه mismatch (سند §6).
     */
    verification: VerifyPaymentResult
}

export interface FinalizePaymentResult {
    order: PaymentOrderRecord
    /** false = این فراخوانی هیچ mutationی انجام نداد (duplicate/PAID = no-op، سند §14). */
    finalized: boolean
    /** entitlement نهایی کاربر (فقط read) — در مسیر no-op همان ردیف قبلی برگردانده می‌شود. */
    entitlement: EntitlementRecord | null
}

/**
 * تنظیمات سروری checkout (سند §10): عمر سفارش، توضیح محصول و base callback.
 * همه از config می‌آیند؛ هیچ‌کدام از این مقادیر نمی‌توانند از client بیایند (سند §5).
 */
export interface CheckoutSettings {
    provider: BillingProviderId
    orderTtlMs: number
    description: string
    callbackUrl: string
}

export interface AttachAuthorityInput {
    /** مالک سفارش — از context احراز‌شده‌ی سرور (سند §33)؛ هرگز از client. */
    userId: number
    /** همان کلید idempotency که سفارش با آن ساخته شده (سند §6). */
    checkoutIdempotencyKey: string
    /** authority برگردانده‌شده‌ی provider برای همین سفارش (createPayment بیرون از تراکنش). */
    authority: string
}

/** سقف تلاش برای raceهای unique — همان اندازه‌ی الگوی موجود repo (`upsertUsageRow`/گام ۸). */
const MAX_ATTEMPTS = 3

const ORDER_SELECT = {
    id: true,
    userId: true,
    provider: true,
    merchantOrderId: true,
    checkoutIdempotencyKey: true,
    amount: true,
    currency: true,
    status: true,
    providerAuthority: true,
    providerReference: true,
    entitlementDays: true,
    requestId: true,
    expiresAt: true,
    paidAt: true,
    failureCode: true,
    entitlementId: true,
} as const

const ENTITLEMENT_SELECT = {
    id: true,
    userId: true,
    provider: true,
    status: true,
    planCode: true,
    currentPeriodStart: true,
    currentPeriodEnd: true,
} as const

/** تشخیص unique-constraint violation با duck-typing — الگوی موجود repo (بدون runtime import از Prisma). */
function isUniqueViolation(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "P2002"
    )
}

function resolveNow(now?: Date): Date {
    return now instanceof Date ? now : new Date()
}

/**
 * پیکربندی محصول از config سروری (سند §5/§7). خطای config هرگز به بیرون درز نمی‌کند:
 * پیام آن فقط نام کلید است و این‌جا به PAYMENT_CONFIGURATION_ERROR (500) نگاشت می‌شود.
 */
function readCheckoutProduct(): CheckoutProduct {
    try {
        const config = getBillingConfig()
        return {
            provider: config.provider,
            amount: config.pro.amount,
            currency: config.pro.currency,
            entitlementDays: config.pro.entitlementDays,
        }
    } catch {
        throw new PaymentConfigurationError()
    }
}

/**
 * تنظیمات checkout برای route (سند §10). خواندن config و نگاشت خطای آن به
 * PAYMENT_CONFIGURATION_ERROR (سند §20) این‌جا متمرکز می‌ماند تا route فقط مقادیر معتبر
 * سروری را مصرف کند؛ هیچ مقدار خام config در پیام خطا منتشر نمی‌شود.
 */
export function resolveCheckoutSettings(): CheckoutSettings {
    try {
        const config = getBillingConfig()
        return {
            provider: config.provider,
            orderTtlMs: config.orderTtlMs,
            description: config.zarinpal.description,
            callbackUrl: config.zarinpal.callbackUrl,
        }
    } catch {
        throw new PaymentConfigurationError()
    }
}

/**
 * عمر سفارش هم یک ورودی سروری است؛ مقدار نامعتبر/غایب یک نقص پیکربندی سرور است (سند §20:
 * PAYMENT_CONFIGURATION_ERROR برای «invalid/missing server billing configuration»).
 */
function assertOrderTtl(orderTtlMs: number): number {
    if (typeof orderTtlMs !== "number" || !Number.isSafeInteger(orderTtlMs) || orderTtlMs <= 0) {
        throw new PaymentConfigurationError()
    }
    return orderTtlMs
}

/**
 * پارامترهای immutable یک checkout (سند §6: «compare immutable checkout parameters»):
 * مبلغ، ارز، مدت entitlement و provider. این‌ها همان snapshot محصول سروری‌اند؛ planCode در MVP
 * یک محصول ثابت (`PRO`) است و ستونی برای snapshot آن در PaymentOrder وجود ندارد (سند §3.4).
 */
function hasSameCheckoutParameters(order: PaymentOrderRecord, product: CheckoutProduct): boolean {
    return (
        order.provider === product.provider &&
        order.amount === product.amount &&
        order.currency === product.currency &&
        order.entitlementDays === product.entitlementDays
    )
}

async function findOrderByKey(
    db: PrismaClientLike,
    userId: number,
    checkoutIdempotencyKey: string,
): Promise<PaymentOrderRecord | null> {
    const row = await db.paymentOrder.findUnique({
        where: { userId_checkoutIdempotencyKey: { userId, checkoutIdempotencyKey } },
        select: ORDER_SELECT,
    })
    return (row as PaymentOrderRecord | null) ?? null
}

async function findOrderByAuthority(
    db: PrismaClientLike,
    authority: string,
): Promise<PaymentOrderRecord | null> {
    const row = await db.paymentOrder.findFirst({
        where: { providerAuthority: authority },
        select: ORDER_SELECT,
    })
    return (row as PaymentOrderRecord | null) ?? null
}

async function findOrderById(
    db: PrismaClientLike,
    id: string,
): Promise<PaymentOrderRecord | null> {
    const row = await db.paymentOrder.findUnique({
        where: { id },
        select: ORDER_SELECT,
    })
    return (row as PaymentOrderRecord | null) ?? null
}

async function readEntitlement(
    db: PrismaClientLike,
    userId: number,
): Promise<EntitlementRecord | null> {
    const row = await db.entitlement.findUnique({
        where: { userId },
        select: ENTITLEMENT_SELECT,
    })
    return (row as EntitlementRecord | null) ?? null
}

/**
 * prepareCheckout — ساخت/بازیابی idempotent سفارش پرداخت (سند §6/§10):
 *
 * 1. پارامترهای محصول فقط از config سروری خوانده می‌شوند (client هیچ‌کدام را نمی‌دهد — سند §5).
 * 2. lookup روی `userId + checkoutIdempotencyKey` (unique اسکیمای فاز ۵).
 * 3. موجود با پارامترهای سازگار → همان سفارش reuse می‌شود (هیچ سفارش دومی ساخته نمی‌شود)؛ اگر
 *    آن سفارش PENDING و گذشته از `expiresAt` باشد، ابتدا lazy expire می‌شود (سند §14/§15).
 * 4. موجود با پارامترهای ناسازگار → PAYMENT_IDEMPOTENCY_CONFLICT (سند §6/§20).
 * 5. در نبود رکورد → سفارش PENDING با merchantOrderId/expiresAt سروری ساخته می‌شود؛ race روی
 *    کلید یکتا با bounded retry/re-read (الگوی موجود repo) مدیریت می‌شود.
 *
 * طبق سند §7/§10 این operation **هیچ تماس provider‌ای** انجام نمی‌دهد: authority و redirect
 * بعد از createPayment در گام checkout route ذخیره/برگردانده می‌شوند.
 */
export async function prepareCheckout(
    db: PrismaClientLike,
    input: PrepareCheckoutInput,
    now?: Date,
): Promise<CheckoutPreparation> {
    const at = resolveNow(now)
    const product = readCheckoutProduct()
    const ttlMs = assertOrderTtl(input.orderTtlMs)

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const existing = await findOrderByKey(db, input.userId, input.checkoutIdempotencyKey)
        if (existing) {
            if (!hasSameCheckoutParameters(existing, product)) {
                throw new PaymentIdempotencyConflictError()
            }
            // گام ۱۰ — سفارش PENDINGی که از expiresAt گذشته، همین‌جا (به‌صورت شرطی) EXPIRED می‌شود
            const settled = await settleExpiredPendingOrder(db, existing, at)
            return { order: settled, reused: true }
        }

        try {
            const created = await db.paymentOrder.create({
                data: {
                    userId: input.userId,
                    provider: product.provider,
                    // opaque و server-generated؛ هیچ ورودی کاربر/داده‌ی حساسی داخلش نیست (سند §33)
                    merchantOrderId: randomUUID(),
                    checkoutIdempotencyKey: input.checkoutIdempotencyKey,
                    amount: product.amount,
                    currency: product.currency,
                    entitlementDays: product.entitlementDays,
                    status: "PENDING",
                    expiresAt: new Date(at.getTime() + ttlMs),
                    // correlation اختیاری (سند §22) — idempotency جدا از آن است (سند §6)
                    ...(input.requestId ? { requestId: input.requestId } : {}),
                },
                select: ORDER_SELECT,
            })
            return { order: created as PaymentOrderRecord, reused: false }
        } catch (error) {
            // P2002 → کلید یکتا هم‌زمان توسط درخواست دیگری گرفته شده است؛ re-read و مقایسه
            if (isUniqueViolation(error) && attempt < MAX_ATTEMPTS - 1) continue
            if (isUniqueViolation(error)) throw new PaymentIdempotencyConflictError()
            // هر خطای زیرساختی دیگر دست‌نخورده بالا می‌رود تا مسیر استاندارد ۵۰۰ آن را بپوشاند
            throw error
        }
    }

    throw new PaymentIdempotencyConflictError()
}

/**
 * lazy expiration سفارش PENDING (سند §14/§15: «now > expiresAt») — تنها نقطه‌ی بررسی، همین
 * idempotency lookup است؛ هیچ job/queue پس‌زمینه‌ای در MVP وجود ندارد.
 *
 * - transition **شرطی** است (`id + status=PENDING + expiresAt`ِ خوانده‌شده)؛ اگر هم‌زمان تغییر
 *   کرده باشد روی state نادرست نوشته نمی‌شود.
 * - در نبود match، رکورد دوباره خوانده می‌شود (race) و همان state جاری برگردانده می‌شود.
 * - هیچ سفارش terminalی revive نمی‌شود، هیچ سفارش دومی با همان کلید ساخته نمی‌شود و
 *   entitlement/User.plan هرگز این‌جا تغییر نمی‌کند (سند §14/§15).
 */
async function settleExpiredPendingOrder(
    db: PrismaClientLike,
    order: PaymentOrderRecord,
    at: Date,
): Promise<PaymentOrderRecord> {
    if (order.status !== "PENDING") return order
    if (at.getTime() <= order.expiresAt.getTime()) return order

    const expired = await db.paymentOrder.updateMany({
        where: { id: order.id, status: "PENDING", expiresAt: order.expiresAt },
        data: { status: "EXPIRED" },
    })

    const current = await findOrderById(db, order.id)
    if (current) return current
    return expired.count > 0 ? { ...order, status: "EXPIRED" } : order
}

/**
 * attachProviderAuthority — persist کردن authority برگردانده‌شده‌ی provider روی سفارش PENDING
 * (سند §6 مرحله ۸ / §10). createPayment سمت caller و **بیرون از هر تراکنش** انجام شده است؛ این
 * operation خودش تراکنش باز نمی‌کند و فقط یک mutation شرطی روی همان state مورد انتظار می‌زند:
 *
 * 1. `PENDING` و `providerAuthority === null` → authority ذخیره می‌شود
 * 2. `PENDING` با همان authority → no-op (همان ردیف برگردانده می‌شود)
 * 3. `PENDING` با authority متفاوت → هیچ overwriteی انجام نمی‌شود → CONFLICT
 * 4. سفارش terminal → هیچ mutation/reviveی انجام نمی‌شود → CONFLICT
 *
 * update شرطی (`id + status=PENDING + providerAuthority=null`) تضمین می‌کند دو درخواست هم‌زمان
 * authority یکدیگر را بازنویسی نکنند؛ فقط برنده‌ی شرط می‌نویسد و بازنده re-read می‌کند.
 *
 * اگر createPayment موفق شده باشد ولی این persistence fail شود، هیچ create دوباره‌ای انجام
 * نمی‌شود، سفارش PENDING می‌ماند و `PAYMENT_STATE_UNRESOLVED` برگردانده می‌شود؛ جزئیات خام DB
 * هرگز به بیرون درز نمی‌کند و وضعیت برای inquiry/reconciliation دستی باقی می‌ماند (سند §7).
 */
export async function attachProviderAuthority(
    db: PrismaClientLike,
    input: AttachAuthorityInput,
): Promise<PaymentOrderRecord> {
    try {
        const order = await findOrderByKey(db, input.userId, input.checkoutIdempotencyKey)
        if (!order) throw new PaymentNotFoundError()

        // سفارش terminal زنده نمی‌شود و authority جدیدی نمی‌پذیرد (سند §14)
        if (order.status !== "PENDING") throw new PaymentIdempotencyConflictError()

        if (order.providerAuthority !== null) {
            if (order.providerAuthority === input.authority) return order
            // authority قبلی هرگز overwrite نمی‌شود (سند §6/§7)
            throw new PaymentIdempotencyConflictError()
        }

        const attached = await db.paymentOrder.updateMany({
            where: { id: order.id, status: "PENDING", providerAuthority: null },
            data: { providerAuthority: input.authority },
        })

        const current = await findOrderById(db, order.id)

        if (attached.count === 0) {
            // درخواست دیگری زودتر نوشته است → فقط وقتی همان authority است no-op موفق
            if (current && current.providerAuthority === input.authority) return current
            throw new PaymentIdempotencyConflictError()
        }

        if (!current || current.providerAuthority !== input.authority) {
            // write موفق ولی state خوانده‌شده تأیید‌کننده نیست → وضعیت برای ما قابل‌تعیین نیست
            throw new PaymentStateUnresolvedError()
        }

        return current
    } catch (error) {
        // خطاهای دامنه (not-found/conflict/unresolved) دست‌نخورده می‌مانند؛ هر شکست زیرساختی
        // دیگر (بدون افشای جزئیات خام) به «وضعیت قابل‌تعیین نیست» نگاشت می‌شود (سند §7).
        if (error instanceof ServiceError) throw error
        throw new PaymentStateUnresolvedError()
    }
}

/**
 * finalizeVerifiedPayment — نهایی‌سازی اتمیک پرداخت **تأییدشده** (سند §13/§28):
 *
 * تمام mutationها داخل یک Prisma interactive transaction هستند و provider هیچ‌وقت داخل تراکنش
 * صدا زده نمی‌شود (verify سمت سرور قبل از این فراخوانی انجام شده و نتیجه‌ی نرمال‌شده ورودی است):
 *
 * 1. resolve سفارش با authority → نبود → PAYMENT_NOT_FOUND
 * 2. سفارش PAID → no-op: همان state نهایی برمی‌گردد؛ هیچ entitlement/paidAt/entitlementId دوباره
 *    نوشته نمی‌شود و هیچ خطای «already processed» ساخته نمی‌شود (سند §14/§28)
 * 3. سفارش terminal غیر-PAID (FAILED/EXPIRED/CANCELED) → زنده نمی‌شود (سند §14)
 * 4. بررسی exact amount (سند §13): `amount !== null && amount !== order.amount` →
 *    PAYMENT_INVALID_AMOUNT بدون هیچ mutation (severity همان کلاس گام ۷)
 * 5. claim شرطی `PENDING → PAID` + paidAt + providerReference (فقط اگر provider reference
 *    واقعی داده باشد) — دو callback هم‌زمان فقط یکی موفق می‌شود
 * 6. entitlement داخل همان تراکنش: `renew` برای دوره‌ی فعال و `activate` در غیر آن (سند §16/§27)؛
 *    مدت فقط از `order.entitlementDays` و provider فقط از `order.provider` (سند §4/§16)
 * 7. link `entitlementId` و commit → خروجی `finalized: true`
 *
 * هر خطایی در این مسیر (مثلاً EntitlementConflictError) کل تراکنش را rollback می‌کند: سفارش به
 * PAID تبدیل نمی‌شود، entitlement گرنت نمی‌شود و سرویس هیچ موفقیت جعلی برنمی‌گرداند (سند §28/§29).
 */
export async function finalizeVerifiedPayment(
    db: PrismaClientLike,
    input: FinalizePaymentInput,
    now?: Date,
): Promise<FinalizePaymentResult> {
    const at = resolveNow(now)

    return (await db.$transaction(async (tx: PrismaClientLike) => {
        const order = await findOrderByAuthority(tx, input.authority)
        if (!order) throw new PaymentNotFoundError()

        // duplicate/تکرار callback روی سفارش نهایی‌شده → no-op موفق، بدون هیچ mutation (سند §14/§28)
        if (order.status === "PAID") {
            return {
                order,
                finalized: false,
                entitlement: await readEntitlement(tx, order.userId),
            }
        }

        // فقط سفارش PENDING قابل finalize است؛ سفارش‌های terminal زنده نمی‌شوند (سند §14)
        if (order.status !== "PENDING") {
            throw new PaymentVerificationFailedError()
        }

        // exact amount verification (سند §13): `null` یعنی provider مبلغ قابل استناد نداد و
        // mismatch نیست؛ در آن حالت mبلغ ذخیره‌شده جعل نمی‌شود (قرارداد گام ۵/۶).
        if (input.verification.amount !== null && input.verification.amount !== order.amount) {
            throw new PaymentInvalidAmountError()
        }

        // claim شرطی: تنها یک finalization برای این سفارش برنده می‌شود (سند §28/§29).
        // reference provider فقط وقتی ذخیره می‌شود که واقعاً برگردانده شده باشد؛ `null`
        // (verify تکراری/قبلاً verify شده — سند §13) هرگز جعل یا جایگزین نمی‌شود.
        const claimed = await tx.paymentOrder.updateMany({
            where: { id: order.id, status: "PENDING" },
            data: {
                status: "PAID",
                paidAt: at,
                ...(input.verification.reference !== null
                    ? { providerReference: input.verification.reference }
                    : {}),
            },
        })

        if (claimed.count === 0) {
            // هم‌زمان finalize شد → اگر PAID شده باشد no-op موفق است (entitlement فقط یک بار داده شده)
            const current = (await tx.paymentOrder.findUnique({
                where: { id: order.id },
                select: ORDER_SELECT,
            })) as PaymentOrderRecord | null
            if (current && current.status === "PAID") {
                return {
                    order: current,
                    finalized: false,
                    entitlement: await readEntitlement(tx, current.userId),
                }
            }
            throw new PaymentVerificationFailedError()
        }

        // entitlement داخل همان تراکنش — منطق entitlement دوباره پیاده نشده (سند §27)
        const entitlement = await applyEntitlement(tx, order, at)

        // link نهایی و خواندن state نهایی سفارش در همین تراکنش (سند §28 مرحله ۶)
        const finalizedOrder = (await tx.paymentOrder.update({
            where: { id: order.id },
            data: { entitlementId: entitlement.id },
            select: ORDER_SELECT,
        })) as PaymentOrderRecord

        return { order: finalizedOrder, finalized: true, entitlement }
    })) as FinalizePaymentResult
}

/**
 * انتخاب activate/renew طبق semantics سند §16/§27: تمدید فقط وقتی دوره‌ی فعال هنوز معتبر است
 * (`ACTIVE && now < currentPeriodEnd`)، در غیر آن یک دوره‌ی جدید از now ساخته می‌شود (activate).
 * مدت و provider فقط از snapshot سفارش می‌آیند (سند §4/§16) — هیچ خوانشی از config این‌جا نیست.
 */
async function applyEntitlement(
    tx: PrismaClientLike,
    order: PaymentOrderRecord,
    at: Date,
): Promise<EntitlementRecord> {
    const mutation = {
        userId: order.userId,
        provider: order.provider,
        entitlementDays: order.entitlementDays,
    }

    const existing = await readEntitlement(tx, order.userId)
    const isActiveExtension =
        existing !== null &&
        existing.status === "ACTIVE" &&
        at.getTime() < existing.currentPeriodEnd.getTime()

    // EntitlementConflictError (در صورت نقض invariant) تراکنش را rollback می‌کند (سند §29)
    // هر خطای entitlement (مثل EntitlementConflictError) دست‌نخورده بالا می‌رود تا کل تراکنش
    // rollback شود: سفارش PAID نمی‌شود و سرویس موفقیت جعلی برنمی‌گرداند (سند §28/§29).
    return isActiveExtension ? renew(tx, mutation, at) : activate(tx, mutation, at)
}
