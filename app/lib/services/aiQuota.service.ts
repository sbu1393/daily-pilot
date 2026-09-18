// فاز ۱ — هسته‌ی کووتای ماهانه‌ی AI (سند §8/§9/§10/§11/§13)
//
// قواعد LOCKED:
// - Fail-Closed: هر خطای DB → QUOTA_UNAVAILABLE (503) — هیچ مسیری open نمی‌ماند.
// - Reservation اتمیک با conditional updateMany + increment (بدون raw SQL، بدون Serializable).
//   Invariant: reservedUnits + consumedUnits + units <= allowedUnits
//   count === 0 → QUOTA_EXCEEDED (429)
// - Idempotency بر اساس requestId در AiUsageEvent (§15): RESERVED/CONSUMED/RELEASED → رزرو جدید ممنوع.
// - AI call هرگز داخل transaction کووتا نیست (§10) — این سرویس فقط reserve/complete/release دارد.
// - کاملاً مستقل از HTTP: هیچ import از next/Request/NextResponse (§18).

import {
    AiUsageConflictError,
    IdempotencyConflictError,
    QuotaExceededError,
    QuotaUnavailableError,
} from "./errors"
import {
    assertTransitionAllowed,
    createReservedEvent,
    findEventStatusByRequestId,
    transitionEventToConsumed,
    transitionEventToReleased,
    type PrismaClientLike,
} from "./aiUsage.service"

export { getMonthlyPeriod, resolvePlanPolicy } from "./planPolicy.service"

export interface ReserveQuotaInput {
    userId: number
    requestId: string
    /** سقف ماهانه از planPolicy — فقط سروری، هرگز از کلاینت (§26) */
    allowedUnits: number
    units: number
    feature: string
    model?: string
    /** شروع پریود ماهانه (00:00:00.000 UTC) — از getMonthlyPeriod */
    periodStart: Date
}

/**
 * reserveQuota — رزرو اتمیک units برای یک logical AI request (سند §8).
 *
 * 1. idempotency: requestId موجود (هر وضعیتی) → IdempotencyConflictError؛ رزرو جدیدی ساخته نمی‌شود.
 * 2. upsert ایمن ردیف AiUsage ماهانه (race اولین ردیف با unique constraint + retry محدود).
 * 3. ثبت AiUsageEvent RESERVED.
 * 4. رزرو اتمیک داخل $transaction (bounded optimistic retry — سند §8/§9):
 *      - در هر دور مقادیر تازه خوانده می‌شوند؛
 *      - اگر `reserved + consumed + units > allowed` → QUOTA_EXCEEDED (exceed واقعی، بدون retry)؛
 *      - CAS increment فقط روی همان مقادیر خوانده‌شده؛ count===1 → موفق؛
 *      - count===0 (تغییر همزمان) → دور بعد، نه denial جعلی؛
 *      - exhaustion (فقط contention) → QUOTA_UNAVAILABLE (fail-closed).
 *      transaction rollback می‌شود و رویداد RESERVED هم حذف می‌شود — all-or-nothing.
 *
 * نکته‌ی محدودیت Prisma (§9): expression `consumedUnits + reservedUnits + n <= allowedUnits`
 * داخل `where` قابل بیان نیست (Prisma مقایسه‌ی بین دو ستون را پشتیبانی نمی‌کند)؛ raw SQL و
 * Serializable هم طبق سند ممنوع‌اند. پس guard با CAS روی مقادیر تازه + retry محدود پیاده شده است.
 */

/** حداکثر تلاش optimistic برای رزرو (بدون حلقه‌ی بی‌پایان) */
const RESERVE_MAX_ATTEMPTS = 5
export async function reserveQuota(
    prisma: PrismaClientLike,
    input: ReserveQuotaInput,
): Promise<void> {
    // 1) Idempotency — قبل از هر چیز (سند §15)
    const existingStatus = await findEventStatusByRequestId(prisma, input.requestId)
    if (existingStatus !== null) {
        throw new IdempotencyConflictError()
    }

    // 2) upsert ایمن ردیف پریود
    const row = await upsertUsageRow(prisma, input.userId, input.periodStart)

    try {
        await prisma.$transaction(async (tx: any) => {
            // 3) رویداد RESERVED داخل همان transaction — creation مالکیت aiUsage است (سند §18)
            //    و تکراری بودن هم‌زمان با P2002 رد می‌شود (mapping داخل همان helper).
            //    کلاینت همان `tx` است تا atomicity حفظ شود.
            await createReservedEvent(tx, {
                requestId: input.requestId,
                userId: input.userId,
                feature: input.feature,
                model: input.model,
                units: input.units,
            })

            // 4) رزرو اتمیک با bounded optimistic retry (سند §8/§9):
            //    در هر دور مقادیر تازه خوانده می‌شوند و increment فقط با CAS روی همان مقادیر
            //    اجرا می‌شود — هرگز overspend، و یک تغییر همزمان باعث denial جعلی نمی‌شود.
            for (let attempt = 0; attempt < RESERVE_MAX_ATTEMPTS; attempt++) {
                const usage = await tx.aiUsage.findUnique({
                    where: { id: row.id },
                    select: { reservedUnits: true, consumedUnits: true },
                })
                if (!usage) throw new QuotaUnavailableError()

                // Invariant دقیق سند: reservedUnits + consumedUnits + units <= allowedUnits
                const claimedTotal = usage.reservedUnits + usage.consumedUnits + input.units
                if (claimedTotal > input.allowedUnits) {
                    throw new QuotaExceededError()
                }

                const conditional = await tx.aiUsage.updateMany({
                    where: {
                        id: row.id,
                        reservedUnits: usage.reservedUnits,
                        consumedUnits: usage.consumedUnits,
                    },
                    data: { reservedUnits: { increment: input.units } },
                })
                if (conditional.count === 1) return // رزرو موفق — خروج از transaction
                // count === 0 → تغییر همزمان؛ دور بعد با مقادیر تازه
            }

            // exhaustion: فقط contention بوده (نه exceed) → fail-closed، نه QUOTA_EXCEEDED جعلی
            throw new QuotaUnavailableError()
        })
    } catch (error) {
        if (
            error instanceof QuotaExceededError ||
            error instanceof IdempotencyConflictError
        ) {
            throw error
        }
        // هر خطای دیگر (شامل P2002 race requestId هم‌زمان) → conflict یا fail-closed
        const code = (error as { code?: unknown })?.code
        if (code === "P2002") throw new IdempotencyConflictError()
        throw new QuotaUnavailableError()
    }
}

/** upsert ردیف AiUsage با کنترل race روی unique(userId, periodType, periodStart) */
async function upsertUsageRow(
    prisma: PrismaClientLike,
    userId: number,
    periodStart: Date,
): Promise<{ id: number }> {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await prisma.aiUsage.upsert({
                where: {
                    userId_periodType_periodStart: {
                        userId,
                        periodType: "MONTHLY",
                        periodStart,
                    },
                },
                create: { userId, periodType: "MONTHLY", periodStart },
                update: {},
                select: { id: true },
            })
        } catch (error) {
            const isUniqueRace = (error as { code?: unknown })?.code === "P2002"
            if (isUniqueRace && attempt < 2) continue // retry محدود و مشخص (سند §8)
            throw new QuotaUnavailableError()
        }
    }
    throw new QuotaUnavailableError()
}

/**
 * completeQuota — RESERVED → CONSUMED (سند §11).
 * در یک transaction: reservedUnits − units و consumedUnits + units (اتمیک، دقیقاً یک‌بار).
 * Idempotent: CONSUMED → no-op (false). نامعتبر: RELEASED → AiUsageConflictError.
 *
 * `options.periodStart` دقیقاً همان periodی است که رزرو روی آن انجام شده (سند §۶/§۱۱)؛
 * دیگر با `findFirst … orderBy periodStart desc` «آخرین ماه» حدس زده نمی‌شود — پس rollover
 * ماه، رزرو ماه قبل را آلوده نمی‌کند. گارد `reservedUnits >= delta` invariant
 * `reservedUnits >= 0` را حفظ می‌کند و نبود/ناسازگاری ردیف → fail-closed.
 */
export async function completeQuota(
    prisma: PrismaClientLike,
    requestId: string,
    /** فقط برای fallback وقتی event یافت نشود؛ عمل واقعی از event.units خوانده می‌شود */
    units: number | undefined,
    /** periodStart دقیقِ همان رزرو (اجباری — بدون آن complete مبهم است) */
    options: { periodStart: Date },
): Promise<boolean> {
    if (!options?.periodStart) throw new QuotaUnavailableError()

    const status = await findEventStatusByRequestId(prisma, requestId)
    const transition = status === null ? "allowed" : assertTransitionAllowed(status, "CONSUMED")
    if (transition === "conflict") throw new AiUsageConflictError()
    if (transition === "idempotent") return false

    try {
        return await prisma.$transaction(async (tx: any) => {
            // transition مالکیت aiUsage است (سند §18) — با همان `tx` تراکنش کووتا:
            // read event → conditional event update → (در ادامه) quota-row update
            const event = await transitionEventToConsumed(tx, requestId)
            if (event === null) return false

            const delta = event.units ?? units ?? 0

            // فقط روی همان periodStart رزرو + گارد `reservedUnits >= delta` (invariant §7).
            const applied = await tx.aiUsage.updateMany({
                where: {
                    userId: event.userId,
                    periodType: "MONTHLY",
                    periodStart: options.periodStart,
                    reservedUnits: { gte: delta },
                },
                data: {
                    reservedUnits: { decrement: delta },
                    consumedUnits: { increment: delta },
                },
            })
            if (applied.count === 0) throw new QuotaUnavailableError()
            return true
        })
    } catch (error) {
        // fail-closed: خطای DB هنگام complete → QUOTA_UNAVAILABLE (سند §19)
        throw new QuotaUnavailableError()
    }
}

/**
 * releaseQuota — RESERVED → RELEASED (سند §11/§13).
 * کاهش اتمیک reservedUnits به اندازه‌ی رزرو. Idempotent: RELEASED → no-op (false).
 * نامعتبر: CONSUMED → AiUsageConflictError. خطای DB → QuotaUnavailableError (fail-closed).
 *
 * `options.failureCode` (فاز ۱ §۱۲) در همان transition اتمیک نوشته می‌شود؛ در صورت ندادن آن،
 * رفتار و داده‌ی نوشته‌شده دقیقاً مثل قبل است (backward compatible). مقدار آن باید یک کد امن
 * از taxonomy خطا باشد (مثل کد همان ServiceError) — هرگز پیام/provider payload نیست.
 *
 * `options.periodStart` دقیقاً همان periodی است که رزرو روی آن انجام شده (سند §۶/§۱۱)؛
 * دیگر «آخرین ماه» با `findFirst … desc` انتخاب نمی‌شود و گارد `reservedUnits >= delta`
 * invariant `reservedUnits >= 0` را حفظ می‌کند.
 */
export async function releaseQuota(
    prisma: PrismaClientLike,
    requestId: string,
    /** فقط برای fallback وقتی event یافت نشود؛ عمل واقعی از event.units خوانده می‌شود */
    units: number | undefined,
    /** periodStart دقیقِ همان رزرو (اجباری) + failureCode اختیاری */
    options: { failureCode?: string; periodStart: Date },
): Promise<boolean> {
    if (!options?.periodStart) throw new QuotaUnavailableError()

    const status = await findEventStatusByRequestId(prisma, requestId)
    const transition = status === null ? "allowed" : assertTransitionAllowed(status, "RELEASED")
    if (transition === "conflict") throw new AiUsageConflictError()
    if (transition === "idempotent") return false

    try {
        return await prisma.$transaction(async (tx: any) => {
            // transition مالکیت aiUsage است (سند §18/§13) — با همان `tx` تراکنش کووتا
            const event = await transitionEventToReleased(tx, requestId, options.failureCode)
            if (event === null) return false

            const delta = event.units ?? units ?? 0

            // فقط روی همان periodStart رزرو + گارد `reservedUnits >= delta` (invariant §7).
            const applied = await tx.aiUsage.updateMany({
                where: {
                    userId: event.userId,
                    periodType: "MONTHLY",
                    periodStart: options.periodStart,
                    reservedUnits: { gte: delta },
                },
                data: { reservedUnits: { decrement: delta } },
            })
            if (applied.count === 0) throw new QuotaUnavailableError()
            return true
        })
    } catch (error) {
        // سند §13: خطای release → event در RESERVED می‌ماند (قابل تشخیص برای reconciliation)
        // و پاسخ fail-closed QUOTA_UNAVAILABLE است.
        throw new QuotaUnavailableError()
    }
}
