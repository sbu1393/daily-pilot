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
 * 4. رزرو اتمیک داخل $transaction:
 *      - re-check شرطی روی مقادیر تازه + increment در همان transaction.
 *      - اگر شرط برقرار نبود → QUOTA_EXCEEDED (هیچ تغییر دیگری باقی نمی‌ماند چون transaction
 *        rollback می‌شود و رویداد RESERVED هم حذف می‌شود — all-or-nothing).
 */
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
            // 3) رویداد RESERVED داخل همان transaction — تکراری بودن هم‌زمان با P2002 رد می‌شود
            await tx.aiUsageEvent.create({
                data: {
                    requestId: input.requestId,
                    userId: input.userId,
                    feature: input.feature,
                    model: input.model,
                    units: input.units,
                    status: "RESERVED",
                    attempts: 1,
                },
            })

            // 4) خواندن مقادیر تازه و رزرو شرطی اتمیک در همان transaction
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

            // Increment شرطی: فقط اگر از آخرین خواندن چیزی تغییر نکرده باشد (optimistic concurrency).
            // در PostgreSQL تحت READ COMMITTED، Prisma update با where روی مقادیر خوانده‌شده،
            // تغییرات هم‌زمان را با count===0 آشکار می‌کند؛ در آن صورت برای سادگی و بدون
            // حلقه‌ی بی‌پایان، رزرو رد می‌شود (safe-side: کم‌رزرو، هرگز overspend).
            const conditional = await tx.aiUsage.updateMany({
                where: {
                    id: row.id,
                    reservedUnits: usage.reservedUnits,
                    consumedUnits: usage.consumedUnits,
                },
                data: { reservedUnits: { increment: input.units } },
            })
            if (conditional.count === 0) {
                throw new QuotaExceededError()
            }
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
 */
export async function completeQuota(
    prisma: PrismaClientLike,
    requestId: string,
    /** فقط برای fallback وقتی event یافت نشود؛ عمل واقعی از event.units خوانده می‌شود */
    units?: number,
): Promise<boolean> {
    const status = await findEventStatusByRequestId(prisma, requestId)
    const transition = status === null ? "allowed" : assertTransitionAllowed(status, "CONSUMED")
    if (transition === "conflict") throw new AiUsageConflictError()
    if (transition === "idempotent") return false

    try {
        return await prisma.$transaction(async (tx: any) => {
            const event = await tx.aiUsageEvent.findUnique({
                where: { requestId },
                select: { units: true, userId: true },
            })
            if (!event) return false

            // تغییر وضعیت فقط از RESERVED — اتمیک، دوباره‌complete ناممکن (سند §11)
            const updatedEvent = await tx.aiUsageEvent.updateMany({
                where: { requestId, status: "RESERVED" },
                data: { status: "CONSUMED" },
            })
            if (updatedEvent.count === 0) return false

            const usage = await tx.aiUsage.findFirst({
                where: { userId: event.userId },
                orderBy: { periodStart: "desc" },
                select: { id: true },
            })
            if (!usage) return false

            await tx.aiUsage.update({
                where: { id: usage.id },
                data: {
                    reservedUnits: { decrement: event.units ?? units ?? 0 },
                    consumedUnits: { increment: event.units ?? units ?? 0 },
                },
            })
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
 */
export async function releaseQuota(
    prisma: PrismaClientLike,
    requestId: string,
    /** فقط برای fallback وقتی event یافت نشود؛ عمل واقعی از event.units خوانده می‌شود */
    units?: number,
): Promise<boolean> {
    const status = await findEventStatusByRequestId(prisma, requestId)
    const transition = status === null ? "allowed" : assertTransitionAllowed(status, "RELEASED")
    if (transition === "conflict") throw new AiUsageConflictError()
    if (transition === "idempotent") return false

    try {
        return await prisma.$transaction(async (tx: any) => {
            const event = await tx.aiUsageEvent.findUnique({
                where: { requestId },
                select: { units: true, userId: true },
            })
            if (!event) return false

            const updatedEvent = await tx.aiUsageEvent.updateMany({
                where: { requestId, status: "RESERVED" },
                data: { status: "RELEASED" },
            })
            if (updatedEvent.count === 0) return false

            const usage = await tx.aiUsage.findFirst({
                where: { userId: event.userId },
                orderBy: { periodStart: "desc" },
                select: { id: true },
            })
            if (!usage) return false

            await tx.aiUsage.update({
                where: { id: usage.id },
                data: { reservedUnits: { decrement: event.units ?? units ?? 0 } },
            })
            return true
        })
    } catch (error) {
        // سند §13: خطای release → event در RESERVED می‌ماند (قابل تشخیص برای reconciliation)
        // و پاسخ fail-closed QUOTA_UNAVAILABLE است.
        throw new QuotaUnavailableError()
    }
}
