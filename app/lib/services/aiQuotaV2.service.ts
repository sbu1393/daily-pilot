// AI Quota v2 — ledger جدید روی `AiQuotaBucket` (Phase 2)
//
// تفاوت بنیادی با `aiQuota.service.ts` (legacy):
//   • legacy یک ردیف `AiUsage` با **یک** سهمیه‌ی مشترک دارد.
//   • v2 برای هر بُعد (ANALYZE / PLAN) و هر منبع (BASE / PROMO) **یک ردیف جدا** دارد.
//
// قواعد LOCKED:
// - Fail-Closed: هر خطای DB → `QuotaUnavailableError`.
// - **ترتیب مصرف PROMO → BASE** (تصمیم D2). قطعی و تست‌شده: تا وقتی PROMO ظرفیت
//   کافی دارد، BASE دست نمی‌خورد.
// - سقف BASE **زنده** از `AiQuotaPolicy` خوانده می‌شود؛ سقف PROMO = `grantedUnits`
//   همان ردیف (مجموع بونوس‌های آن دوره).
// - هیچ واحدی از `consumed` و `reserved` هرگز از ظرفیت بیشتر نمی‌شود (CAS + bounded retry).
// - Idempotency بر اساس `requestId` در `AiUsageEvent` مثل قبل.
// - AI call هرگز داخل transaction نیست.
//
// ── چرا یک رزرو از **یک** منبع می‌آید (نه split بین PROMO و BASE) — M1 ───────────
// `AiUsageEvent` یک جفت ستون `quotaSource`/`bucketId` دارد (و DB CHECK این جفت بودن را
// enforce می‌کند). اگر یک رزرو از دو منبع split می‌شد، ثبت audit مبهم می‌شد: معلوم
// نبود مصرفِ آن عملیات از کدام ledger آمده. پس قاعده: اگر PROMO **به‌تنهایی** کل
// `units` را پوشش می‌دهد از PROMO رزرو می‌شود، وگرنه کل رزرو از BASE.
// چون هزینه‌ی همه‌ی فیچرهای فعلی ۱ واحد است، این تفکیک عملاً بی‌اثر است؛ و اگر
// روزی فیچری چندواحدی شد، رفتار همچنان **قطعی و قابل‌ممیزی** می‌ماند.
//
// این invariant (M1) هم **ساختاری** است — `reserveFromLedger` فقط یک `casReserve`
// موفق برمی‌گرداند و هرگز دو bucket را با هم به‌روز نمی‌کند — و هم با تست پوشش
// دارد.
//
// M2 — چرا `units > 1` الان fail-fast می‌شود: همه‌ی فیچرهای محصولِ فعلی تک‌واحدی
// هستند (ANALYZE=1، PLAN=1) و هیچ عملیاتِ چندواحدیِ محصولی وجود ندارد. رفتار
// «PROMO=1 / BASE=15 / units=2» عمداً **redesign نشده**؛ نتیجه‌اش این است که چون
// split ممنوع است، آن رزرو اصلاً انجام نمی‌شود (BASE می‌گوید جا نیست، PROMO هم
// تنها ۱ واحد دارد). در عوض صفت `multiUnit` صریح شده تا این وضعیت یک تصمیمِ
// ناخواسته به‌نظر نرسد.

import type { AiFeature } from "@prisma/client"

import {
    AiUsageConflictError,
    IdempotencyConflictError,
    QuotaExceededError,
    QuotaUnavailableError,
} from "./errors"
import { getMonthlyPeriod } from "./planPolicy.service"
import { readQuotaPolicy, normalizePlan, MultiUnitNotAllowedError } from "./quotaPolicy.service"
import {
    assertTransitionAllowed,
    createReservedEvent,
    findEventStatusByRequestId,
    transitionEventToConsumed,
    transitionEventToReleased,
    type PrismaClientLike,
} from "./aiUsage.service"
import type { AiCallTelemetry } from "@/app/lib/ai/aiDuration"

export type QuotaSource = "BASE" | "PROMO"

/** حداکثر تلاش optimistic برای رزرو (بدون حلقه‌ی بی‌پایان) — مثل نسخهٔ legacy. */
const RESERVE_MAX_ATTEMPTS = 5

export interface ReserveBucketQuotaInput {
    /** از session — هرگز از بدنه. */
    userId: number
    requestId: string
    /** بُعد سهمیه؛ از جدول هزینه‌ی فیچر می‌آید، نه از کلاینت. */
    feature: AiFeature
    /** هزینه‌ی عملیات؛ فقط سمت سرور. */
    units: number
    /**
     * آیا این عملیات **عمداً** چندواحدی است؟ (قاعدهٔ M2)
     *
     * پیش‌فرض `false` یعنی «deny by default»: هر `units > 1` بدون اعلام صریح
     * رد می‌شود. این عمداً در سطح سرویس هم تکرار شده (نه فقط در
     * `assertQuotaUnitsAllowed`) تا حتی یک caller که guard بالادستی را دور بزند،
     * نتواند رزرو چندواحدیِ ناخواسته ثبت کند. رزرو چندواحدی فعلاً هیچ مسیر
     * محصولی ندارد، پس مقدار `true` عملاً استفاده نمی‌شود.
     */
    multiUnit?: boolean
    /** plan کاربر از session؛ فقط برای خواندن policy. */
    plan: string | null | undefined
    /** timezone کاربر — periodStart از آن مشتق می‌شود. */
    timezone: string
    now?: Date
    model?: string
}

export interface ReserveBucketQuotaResult {
    /** منبعی که رزرو از آن انجام شد — برای audit. */
    quotaSource: QuotaSource
    bucketId: number
    periodStart: Date
    /** snapshot ظرفیت مؤثر در لحظهٔ رزرو (تصمیم D5). */
    policyAllowedUnits: number
}

/**
 * reserveBucketQuota — رزرو اتمیک از ledger نسخهٔ ۲ با ترتیب PROMO → BASE.
 *
 * all-or-nothing: اگر ظرفیت کافی نبود `QuotaExceededError` می‌گیریم و transaction
 * کامل rollback می‌شود (رویداد RESERVED هم ساخته نمی‌شود).
 */
export async function reserveBucketQuota(
    prisma: PrismaClientLike,
    input: ReserveBucketQuotaInput,
): Promise<ReserveBucketQuotaResult> {
    // ── M2: fail-fast هزینه، پیش از هر خواندن/نوشتن DB ──────────────────────────
    // عدد نامعتبر (NaN، صفر، منفی، غیرصحیح) fail-closed به `QuotaUnavailableError`
    // می‌رسد؛ عدد معتبر ولی چندواحدیِ *اعلام‌نشده* یک **باگ** است و ۴۰۰ می‌گیرد.
    if (!Number.isInteger(input.units) || input.units <= 0) {
        throw new QuotaUnavailableError()
    }
    if (input.units > 1 && input.multiUnit !== true) {
        throw new MultiUnitNotAllowedError(input.feature, input.units)
    }

    const now = input.now ?? new Date()
    const periodStart = getMonthlyPeriod(now, input.timezone).periodStart

    // ظرفیت BASE زنده از DB می‌آید (و در audit snapshot می‌شود)
    const allowedUnits = await readQuotaPolicy(prisma, normalizePlan(input.plan), input.feature)

    // Idempotency قبل از هر نوشتنی
    const existingStatus = await findEventStatusByRequestId(prisma, input.requestId)
    if (existingStatus !== null) {
        throw new IdempotencyConflictError()
    }

    try {
        return await prisma.$transaction(async (tx: any) => {
            await createReservedEvent(tx, {
                requestId: input.requestId,
                userId: input.userId,
                feature: input.feature,
                model: input.model,
                units: input.units,
                // مقادیر audit در transition نهایی پر می‌شوند؛ اینجا اولیه‌اند.
                policyAllowedUnits: allowedUnits,
            })

            const reservation = await reserveFromLedger(tx, {
                userId: input.userId,
                feature: input.feature,
                periodStart,
                units: input.units,
                allowedUnits,
            })

            // منبع/ledger واقعی را روی همان رویداد ثبت می‌کنیم
            await tx.aiUsageEvent.updateMany({
                where: { requestId: input.requestId },
                data: { quotaSource: reservation.source, bucketId: reservation.bucketId },
            })

            return {
                quotaSource: reservation.source,
                bucketId: reservation.bucketId,
                periodStart,
                policyAllowedUnits: allowedUnits,
            }
        })
    } catch (error) {
        if (
            error instanceof QuotaExceededError ||
            error instanceof IdempotencyConflictError
        ) {
            throw error
        }
        const code = (error as { code?: unknown })?.code
        if (code === "P2002") throw new IdempotencyConflictError()
        throw new QuotaUnavailableError()
    }
}

interface LedgerPick {
    source: QuotaSource
    bucketId: number
}

/**
 * حلقهٔ bounded optimistic روی ledger: اول PROMO، بعد BASE.
 *
 * برای هر دو منبع ابتدا ظرفیت باقی‌مانده خوانده می‌شود و فقط اگر **کل** `units`
 * جا شود رزرو می‌شود (توضیح «چرا یک منبع» در سر فایل).
 */
async function reserveFromLedger(
    tx: any,
    ctx: {
        userId: number
        feature: AiFeature
        periodStart: Date
        units: number
        allowedUnits: number
    },
): Promise<LedgerPick> {
    for (let attempt = 0; attempt < RESERVE_MAX_ATTEMPTS; attempt++) {
        // ── PROMO (اولویت قطعی) ────────────────────────────────────────────────
        const promo = await readBucket(tx, ctx.userId, ctx.feature, "PROMO", ctx.periodStart)
        const promoCapacity = promo?.grantedUnits ?? 0
        if (promo && hasRoom(promo.reservedUnits, promo.consumedUnits, promoCapacity, ctx.units)) {
            if (await casReserve(tx, promo, ctx.units)) {
                return { source: "PROMO", bucketId: promo.id }
            }
            continue // تغییر هم‌زمان → دور بعد با مقادیر تازه (نه denial جعلی)
        }

        // ── BASE (سقف زندهٔ policy) ─────────────────────────────────────────────
        const base = await ensureBucket(tx, ctx.userId, ctx.feature, "BASE", ctx.periodStart)
        if (hasRoom(base.reservedUnits, base.consumedUnits, ctx.allowedUnits, ctx.units)) {
            if (await casReserve(tx, base, ctx.units)) {
                return { source: "BASE", bucketId: base.id }
            }
            continue
        }

        // نه PROMO و نه BASE ظرفیت کافی ندارند ⇒ exceed واقعی (بدون retry)
        throw new QuotaExceededError()
    }

    // فقط contention ⇒ fail-closed (نه QUOTA_EXCEEDED جعلی)
    throw new QuotaUnavailableError()
}

/** invariant: reservedUnits + consumedUnits + units <= capacity */
function hasRoom(
    reserved: number,
    consumed: number,
    capacity: number,
    units: number,
): boolean {
    return reserved + consumed + units <= capacity
}

interface BucketRow {
    id: number
    reservedUnits: number
    consumedUnits: number
    grantedUnits: number | null
}

/** bucket موجود را می‌خواند؛ نبودنش برای PROMO یعنی «ظرفیت صفر» نه خطا. */
async function readBucket(
    tx: any,
    userId: number,
    feature: AiFeature,
    source: QuotaSource,
    periodStart: Date,
): Promise<BucketRow | null> {
    const row = await tx.aiQuotaBucket.findUnique({
        where: {
            userId_feature_source_periodType_periodStart: {
                userId,
                feature,
                source,
                periodType: "MONTHLY",
                periodStart,
            },
        },
        select: { id: true, reservedUnits: true, consumedUnits: true, grantedUnits: true },
    })
    return (row as BucketRow | null) ?? null
}

/** BASE همیشه باید وجود داشته باشد (حتی با مصرف صفر) تا capacity زنده قابل خواندن باشد. */
async function ensureBucket(
    tx: any,
    userId: number,
    feature: AiFeature,
    source: QuotaSource,
    periodStart: Date,
): Promise<BucketRow> {
    const existing = await readBucket(tx, userId, feature, source, periodStart)
    if (existing) return existing

    try {
        const created = await tx.aiQuotaBucket.create({
            data: {
                userId,
                feature,
                source,
                periodType: "MONTHLY",
                periodStart,
                // BASE ⇒ null (CHECK)؛ PROMO ⇒ 0 (CHECK)
                grantedUnits: source === "PROMO" ? 0 : null,
            },
            select: { id: true, reservedUnits: true, consumedUnits: true, grantedUnits: true },
        })
        return created as BucketRow
    } catch (error) {
        if ((error as { code?: unknown })?.code === "P2002") {
            // رزرو هم‌زمان همان ردیف را ساخته → بخوان و ادامه بده
            const raced = await readBucket(tx, userId, feature, source, periodStart)
            if (raced) return raced
        }
        throw new QuotaUnavailableError()
    }
}

/**
 * CAS رزرو: `UPDATE ... WHERE id = ? AND reservedUnits = ? AND consumedUnits = ?`.
 *
 * اگر `count === 0` یعنی کسی هم‌زمان تغییر داده ⇒ دور بعد با مقادیر تازه.
 * هرگز overspend رخ نمی‌دهد چون شرط `reservedUnits`/`consumedUnits` همان مقادیر
 * تازه‌ی خوانده‌شده را قفل می‌کند.
 */
async function casReserve(tx: any, bucket: BucketRow, units: number): Promise<boolean> {
    const applied = await tx.aiQuotaBucket.updateMany({
        where: {
            id: bucket.id,
            reservedUnits: bucket.reservedUnits,
            consumedUnits: bucket.consumedUnits,
        },
        data: { reservedUnits: { increment: units } },
    })
    return applied.count === 1
}

/* ──────────────────────────────────────────────────────────────────────────── */
/* complete / release روی همان bucket رزرو                                     */
/* ──────────────────────────────────────────────────────────────────────────── */

/**
 * completeBucketQuota — RESERVED → CONSUMED روی ledger نسخهٔ ۲.
 *
 * `bucketId` از خودِ رویداد خوانده می‌شود (نه از ورودی caller) تا هرگز اشتباهی
 * روی bucket دیگری ننشیند. مسیر legacy (`bucketId === null`) از این سرویس
 * استفاده نمی‌کند و همچنان `aiQuota.service` آن را اداره می‌کند.
 */
export async function completeBucketQuota(
    prisma: PrismaClientLike,
    requestId: string,
    options: { periodStart: Date },
    telemetry?: AiCallTelemetry,
): Promise<boolean> {
    return finalizeBucketQuota(prisma, requestId, "CONSUMED", undefined, options, telemetry)
}

/** releaseBucketQuota — RESERVED → RELEASED و بازگرداندن رزرو به همان bucket. */
export async function releaseBucketQuota(
    prisma: PrismaClientLike,
    requestId: string,
    options: { failureCode?: string; periodStart: Date },
    telemetry?: AiCallTelemetry,
): Promise<boolean> {
    return finalizeBucketQuota(
        prisma,
        requestId,
        "RELEASED",
        options.failureCode,
        options,
        telemetry,
    )
}

async function finalizeBucketQuota(
    prisma: PrismaClientLike,
    requestId: string,
    target: "CONSUMED" | "RELEASED",
    failureCode: string | undefined,
    options: { periodStart: Date },
    telemetry?: AiCallTelemetry,
): Promise<boolean> {
    if (!options?.periodStart) throw new QuotaUnavailableError()

    const status = await findEventStatusByRequestId(prisma, requestId)
    const transition = status === null ? "allowed" : assertTransitionAllowed(status, target)
    if (transition === "conflict") throw new AiUsageConflictError()
    if (transition === "idempotent") return false

    try {
        return await prisma.$transaction(async (tx: any) => {
            const event =
                target === "CONSUMED"
                    ? await transitionEventToConsumed(tx, requestId, telemetry)
                    : await transitionEventToReleased(tx, requestId, failureCode, telemetry)
            if (event === null) return false

            if (event.bucketId === null) {
                // رویدادِ رزروشده با ledger نسخهٔ ۲ — مسیر legacy است، اینجا نیست
                throw new QuotaUnavailableError()
            }

            const delta = event.units
            // گارد `reservedUnits >= delta` invariant عدم‌منفی‌شدن را حفظ می‌کند
            const applied = await tx.aiQuotaBucket.updateMany({
                where: { id: event.bucketId, reservedUnits: { gte: delta } },
                data:
                    target === "CONSUMED"
                        ? {
                              reservedUnits: { decrement: delta },
                              consumedUnits: { increment: delta },
                          }
                        : { reservedUnits: { decrement: delta } },
            })
            if (applied.count === 0) throw new QuotaUnavailableError()
            return true
        })
    } catch {
        // fail-closed. برای release، event در RESERVED می‌ماند تا reconcilable بماند.
        throw new QuotaUnavailableError()
    }
}

/* ──────────────────────────────────────────────────────────────────────────── */
/* خواندن وضعیت (برای نمایش/تست)                                             */
/* ──────────────────────────────────────────────────────────────────────────── */

export interface QuotaBucketView {
    feature: AiFeature
    source: QuotaSource
    capacity: number
    reserved: number
    consumed: number
    remaining: number
}

/** وضعیت دو بُعد/منبع یک دوره — ظرفیت PROMO از grantedUnits، ظرفیت BASE از policy. */
export async function readQuotaBuckets(
    prisma: PrismaClientLike,
    input: { userId: number; plan: string | null | undefined; timezone: string; now?: Date },
): Promise<QuotaBucketView[]> {
    const now = input.now ?? new Date()
    const periodStart = getMonthlyPeriod(now, input.timezone).periodStart
    const plan = normalizePlan(input.plan)
    const features: AiFeature[] = ["ANALYZE", "PLAN"]
    const views: QuotaBucketView[] = []

    for (const feature of features) {
        const allowedUnits = await readQuotaPolicy(prisma, plan, feature)

        const promo = await readBucketOrRoot(prisma, input.userId, feature, "PROMO", periodStart)
        const promoCapacity = promo?.grantedUnits ?? 0
        views.push({
            feature,
            source: "PROMO",
            capacity: promoCapacity,
            reserved: promo?.reservedUnits ?? 0,
            consumed: promo?.consumedUnits ?? 0,
            remaining: Math.max(0, promoCapacity - (promo?.reservedUnits ?? 0) - (promo?.consumedUnits ?? 0)),
        })

        const base = await readBucketOrRoot(prisma, input.userId, feature, "BASE", periodStart)
        const baseReserved = base?.reservedUnits ?? 0
        const baseConsumed = base?.consumedUnits ?? 0
        views.push({
            feature,
            source: "BASE",
            capacity: allowedUnits,
            reserved: baseReserved,
            consumed: baseConsumed,
            // اگر ادمین سقف را وسط ماه پایین آورده باشد، remaining صفر می‌شود و
            // شمارنده‌ها **دست‌نخورده** می‌مانند (هیچ negative/clamp دائمی نمی‌شود).
            remaining: Math.max(0, allowedUnits - baseReserved - baseConsumed),
        })
    }

    return views
}

async function readBucketOrRoot(
    prisma: PrismaClientLike,
    userId: number,
    feature: AiFeature,
    source: QuotaSource,
    periodStart: Date,
): Promise<BucketRow | null> {
    try {
        return await readBucket(prisma, userId, feature, source, periodStart)
    } catch {
        throw new QuotaUnavailableError()
    }
}
