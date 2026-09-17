// فاز ۵ — گام ۸: سرویس Entitlement (سند فاز ۵ §16، §17، §18، §27، §29)
//
// مسئولیت (سند §27) — فقط همین چهار operation:
//   activate · renew · lazyExpire · resolveEffectivePlan
//
// قواعد LOCKED:
// - فقط یک ردیف Entitlement per user (`Entitlement.userId` unique) و همان ردیف منبع effective plan است.
// - activation/renewal هرگز دوره‌ی فعالِ پرداخت‌شده را کوتاه نمی‌کند (سند §16).
// - «ACTIVE» به‌تنهایی ملاک تمدید نیست: ردیف ACTIVEی که `now >= currentPeriodEnd` دارد از نظر
//   §17 عملاً منقضی است (expiration فقط lazy materialize می‌شود)، پس خرید جدید از `now` شروع
//   می‌شود — وگرنه پرداختِ تازه دوره‌ای می‌ساخت که همان لحظه تمام شده است.
// - مدت از snapshot سفارش (`PaymentOrder.entitlementDays`) می‌آید؛ این سرویس هرگز مقدار فعلی
//   `BILLING_PRO_ENTITLEMENT_DAYS` را برای یک payment قدیمی resolve نمی‌کند (سند §4/§16).
// - واحد «روز» = دقیقاً ۲۴ ساعت؛ timezone کاربر در محاسبه‌ی دوره‌ی entitlement دخالت نمی‌کند.
// - expiration فقط lazy است (سند §17): هیچ cron/background job و هیچ تصمیم سمت client وجود ندارد.
// - این سرویس مالک transaction نیست (تصمیم گام ۸): finalization transaction در billing.service
//   (سند §28) باز می‌شود و همان client/`tx` به این‌جا پاس داده می‌شود؛ پس این فایل هرگز
//   `$transaction` باز نمی‌کند و commit/rollback نمی‌کند — هم با client عادی و هم با `tx`
//   قابل فراخوانی است. `now` نیز injectable است تا رفتار deterministic/قابل‌تست بماند.
// - concurrency طبق §29: فقط Prisma-supported conditional updates — بدون raw SQL،
//   بدون SERIALIZABLE، بدون lock/queue. race ساختِ اولین ردیف → bounded retry/re-read
//   (همان الگوی `upsertUsageRow` در aiQuota.service.ts).
// - خطای این سرویس فقط `EntitlementConflictError` است (سند §20: ENTITLEMENT_CONFLICT).
//
// خارج از scope این گام: finalization سفارش (status/paidAt/entitlementId)، ProductEvent،
// wiring effective plan در getCurrentUser/quota، admin read model و هر route.

import type { UserPlan } from "@prisma/client"

import type { BillingProviderId } from "../billing/config"
import type { PrismaClientLike } from "./aiUsage.service"
import { EntitlementConflictError } from "./errors"

/** مقادیر enum قفل‌شده‌ی `EntitlementStatus` در اسکیمای فاز ۵ (سند §3.3). */
export type EntitlementStatusValue = "ACTIVE" | "EXPIRED"

/**
 * شکل ردیف Entitlement که این سرویس برمی‌گرداند.
 *
 * نکته: `prisma generate` برای اسکیمای فاز ۵ اجرا نشده است (تصمیم گام ۳)، پس تایپ تولیدشده‌ی
 * `Entitlement` هنوز در `@prisma/client` وجود ندارد؛ این اینترفیس ساختاری دقیقاً همان ستون‌های
 * اسکیمای فاز ۵ است و بعد از generate می‌توان آن را با تایپ تولیدشده جایگزین کرد.
 */
export interface EntitlementRecord {
    id: string
    userId: number
    provider: BillingProviderId
    status: EntitlementStatusValue
    planCode: UserPlan
    currentPeriodStart: Date
    currentPeriodEnd: Date
}

/** ورودی mutationهای entitlement — همه از سمت سرور و از snapshot سفارش/پرداخت. */
export interface EntitlementMutationInput {
    userId: number
    /** provider پرداخت جاری — از caller (PaymentOrder.provider)؛ هرگز از config استنتاج نمی‌شود. */
    provider: BillingProviderId
    /** مدت خریداری‌شده از `PaymentOrder.entitlementDays` (snapshot) — نه configuration فعلی. */
    entitlementDays: number
}

/** نتیجه‌ی lazy expiration — effective plan به‌همراه ردیف نهایی (بدون read دوباره در caller). */
export interface LazyExpireResult {
    effectivePlan: UserPlan
    entitlement: EntitlementRecord | null
}

/** یک روز = دقیقاً ۲۴ ساعت (بدون تقویم/timezone — تصمیم گام ۸). */
const MS_PER_DAY = 24 * 60 * 60 * 1000

/** سقف تلاش برای raceهای conditional — هم‌اندازه‌ی الگوی موجود `upsertUsageRow`. */
const MAX_ATTEMPTS = 3

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

/** مدت خریداری‌شده باید عدد صحیح مثبت باشد؛ ورودی نامعتبر = نقض invariant دامنه. */
function assertEntitlementDays(value: number): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        throw new EntitlementConflictError()
    }
    return value
}

function addDays(base: Date, days: number): Date {
    return new Date(base.getTime() + days * MS_PER_DAY)
}

function resolveNow(now?: Date): Date {
    return now instanceof Date ? now : new Date()
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
 * آینه‌ی سروری `User.plan` (سند §18) — این write فقط از همین لایه‌ی billing/entitlement مجاز است.
 * ردیف کاربر نبودن = نقض invariant جریان finalization → ENTITLEMENT_CONFLICT.
 */
async function setUserPlan(
    db: PrismaClientLike,
    userId: number,
    plan: UserPlan,
): Promise<void> {
    const result = await db.user.updateMany({ where: { id: userId }, data: { plan } })
    if (result.count === 0) throw new EntitlementConflictError()
}

/**
 * اعمال یک خرید پرداخت‌شده روی ردیف یگانه‌ی Entitlement (سند §16) — منطق مشترک activate/renew:
 *
 * - بدون ردیف                        → start = now · end = now + purchasedDays · ACTIVE · PRO
 * - ACTIVE و `now < currentPeriodEnd` → start دست‌نخورده · end = currentPeriodEnd + purchasedDays
 * - ACTIVE و `now >= currentPeriodEnd` (عملاً منقضی، حتی اگر lazy expiration هنوز status را
 *   materialize نکرده باشد — سند §17) → start = now · end = now + purchasedDays
 * - ردیف EXPIRED                      → start = now · end = now + purchasedDays · ACTIVE · PRO
 *
 * «ACTIVE» به‌تنهایی برای تشخیص تمدید کافی نیست: دوره‌ی گذشته باید مثل ردیف منقضی از `now`
 * دوباره شروع شود، وگرنه خرید تازه دوره‌ای می‌ساخت که همان لحظه تمام شده است.
 *
 * هرگز دوره‌ی فعال را کوتاه نمی‌کند و هرگز configuration فعلی را جای snapshot سفارش نمی‌گذارد.
 * همه‌ی updateها conditional و بر اساس state/period خوانده‌شده‌اند تا renewal/expiration
 * هم‌زمان روی همین ردیف سریالایز شود (سند §29)؛ تغییر هم‌زمان → re-read و بازمحاسبه.
 */
async function applyPurchasedPeriod(
    db: PrismaClientLike,
    input: EntitlementMutationInput,
    now?: Date,
): Promise<EntitlementRecord> {
    const days = assertEntitlementDays(input.entitlementDays)
    const at = resolveNow(now)

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const existing = await readEntitlement(db, input.userId)

        // ۱) بدون ردیف → ساخت اولین entitlement (سند §29: race روی unique(userId) با retry محدود)
        if (!existing) {
            try {
                const created = await db.entitlement.create({
                    data: {
                        userId: input.userId,
                        provider: input.provider,
                        status: "ACTIVE",
                        planCode: "PRO",
                        currentPeriodStart: at,
                        currentPeriodEnd: addDays(at, days),
                    },
                    select: ENTITLEMENT_SELECT,
                })
                await setUserPlan(db, input.userId, "PRO")
                return created as EntitlementRecord
            } catch (error) {
                // P2002 → ردیف هم‌زمان ساخته شده است؛ re-read و ادامه از مسیر update
                if (isUniqueViolation(error) && attempt < MAX_ATTEMPTS - 1) continue
                throw new EntitlementConflictError()
            }
        }

        // ۲) تمدید فقط برای دوره‌ی فعالِ هنوز معتبر؛ در غیر آن (EXPIRED یا ACTIVEِ گذشته)
        //    یک دوره‌ی جدید از now ساخته می‌شود (سند §16/§17)
        const isActiveExtension =
            existing.status === "ACTIVE" && at.getTime() < existing.currentPeriodEnd.getTime()
        const nextStart = isActiveExtension ? existing.currentPeriodStart : at
        const nextEnd = addDays(isActiveExtension ? existing.currentPeriodEnd : at, days)

        const updated = await db.entitlement.updateMany({
            where: {
                userId: input.userId,
                status: existing.status,
                currentPeriodStart: existing.currentPeriodStart,
                currentPeriodEnd: existing.currentPeriodEnd,
            },
            data: {
                provider: input.provider,
                status: "ACTIVE",
                planCode: "PRO",
                currentPeriodStart: nextStart,
                currentPeriodEnd: nextEnd,
            },
        })

        if (updated.count === 0) {
            // ردیف هم‌زمان تغییر کرد (تمدید/انقضای موازی) → re-read و بازمحاسبه روی state تازه
            if (attempt < MAX_ATTEMPTS - 1) continue
            throw new EntitlementConflictError()
        }

        await setUserPlan(db, input.userId, "PRO")

        const final = await readEntitlement(db, input.userId)
        if (!final) throw new EntitlementConflictError()
        return final
    }

    throw new EntitlementConflictError()
}

/**
 * activate — خرید پرداخت‌شده (سند §16/§27). حالت‌های بدون ردیف/فعالِ معتبر/فعالِ گذشته/منقضی را
 * طبق §16 می‌پوشاند. تفاوتش با `renew` فقط «قصد caller» و taxonomy رویداد است (سند §23: first
 * activation در برابر extension)؛ محاسبه‌ی دوره در هر دو مورد دقیقاً همان قواعد §16 است.
 */
export async function activate(
    db: PrismaClientLike,
    input: EntitlementMutationInput,
    now?: Date,
): Promise<EntitlementRecord> {
    return applyPurchasedPeriod(db, input, now)
}

/**
 * renew — تمدید (سند §16/§27): فقط روی دوره‌ی فعالِ هنوز معتبر، دوره از `currentPeriodEnd`
 * امتداد می‌یابد و هرگز کوتاه نمی‌شود؛ اگر دوره گذشته باشد یا ردیف منقضی/نباشد، دوره‌ی جدید
 * از `now` ساخته می‌شود.
 */
export async function renew(
    db: PrismaClientLike,
    input: EntitlementMutationInput,
    now?: Date,
): Promise<EntitlementRecord> {
    return applyPurchasedPeriod(db, input, now)
}

/**
 * lazyExpire — انقضای lazy (سند §17/§27):
 *
 * - ردیف ACTIVE و `now < currentPeriodEnd` → هیچ تغییری؛ effective plan = PRO
 * - ردیف ACTIVE و `now >= currentPeriodEnd` → materialize اتمیک: `status = EXPIRED` و
 *   `User.plan = FREE` (آینه‌ی سروری، سند §18)؛ effective plan = FREE
 * - ردیف EXPIRED یا بدون ردیف → effective plan = FREE
 *
 * حفاظت در برابر expiration کهنه (سند §17/§29): update فقط اگر همان state/period خوانده‌شده
 * هنوز برقرار باشد match می‌شود؛ پس یک تمدید هم‌زمان هرگز downgrade نمی‌شود. در تغییر هم‌زمان،
 * ردیف دوباره خوانده و بازمحاسبه می‌شود (bounded) و در invariant failure واقعی
 * `EntitlementConflictError` می‌آید.
 *
 * نکته‌ی تراکنشی: دو write این مسیر (EXPIRED کردن ردیف و FREE کردن `User.plan`) طبق سند §17
 * اتمیک‌اند وقتی caller آن‌ها را داخل یک transaction اجرا کند؛ این سرویس طبق تصمیم گام ۸ خودش
 * transaction باز نمی‌کند. ترتیب عمداً «ابتدا entitlement، سپس plan» است تا وضعیت entitlement
 * (منبع حقیقت) هرگز عقب‌تر از آینه‌ی plan نماند.
 */
export async function lazyExpire(
    db: PrismaClientLike,
    userId: number,
    now?: Date,
): Promise<LazyExpireResult> {
    const at = resolveNow(now)

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const existing = await readEntitlement(db, userId)

        // بدون ردیف → FREE (هیچ نوشتنی لازم نیست)
        if (!existing) return { effectivePlan: "FREE", entitlement: null }

        // فعال و هنوز معتبر → PRO، بدون هیچ تغییری
        if (existing.status === "ACTIVE" && at.getTime() < existing.currentPeriodEnd.getTime()) {
            return { effectivePlan: "PRO", entitlement: existing }
        }

        // فعال و منقضی → materialize اتمیک انقضا
        if (existing.status === "ACTIVE") {
            const expired = await db.entitlement.updateMany({
                where: {
                    userId,
                    status: "ACTIVE",
                    currentPeriodStart: existing.currentPeriodStart,
                    currentPeriodEnd: existing.currentPeriodEnd,
                },
                data: { status: "EXPIRED" },
            })

            if (expired.count === 0) {
                // تمدید هم‌زمان → PRO تازه‌تمدیدشده هرگز downgrade نمی‌شود
                if (attempt < MAX_ATTEMPTS - 1) continue
                throw new EntitlementConflictError()
            }

            await setUserPlan(db, userId, "FREE")
            return { effectivePlan: "FREE", entitlement: await readEntitlement(db, userId) }
        }

        // EXPIRED (قبلاً materialize شده) → FREE
        return { effectivePlan: "FREE", entitlement: existing }
    }

    throw new EntitlementConflictError()
}

/**
 * resolveEffectivePlan — effective plan از state سروری (سند §17/§27): PRO فقط اگر ردیف ACTIVE و
 * هنوز معتبر باشد؛ در غیر این صورت lazy expiration انجام و FREE برگردانده می‌شود. این تابع نه JWT
 * را تغییر می‌دهد و نه client-provided plan را معتبر می‌داند؛ wiring آن به getCurrentUser/quota
 * طبق Blueprint در گام‌های بعدی است.
 */
export async function resolveEffectivePlan(
    db: PrismaClientLike,
    userId: number,
    now?: Date,
): Promise<UserPlan> {
    const result = await lazyExpire(db, userId, now)
    return result.effectivePlan
}
