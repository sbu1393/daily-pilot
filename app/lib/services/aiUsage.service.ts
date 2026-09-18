// فاز ۱ — AiUsageEvent: ثبت رویداد مصرف AI و transitionهای state machine (سند §7/§11/§15)
//
// State machine (LOCKED):
//   RESERVED ──success──→ CONSUMED
//   RESERVED ──final failure──→ RELEASED
//
// این سرویس فقط متادیتای امن ذخیره می‌کند (سند §7/§21) — ممنوعیت دائمی:
// prompt خام، response خام، JWT، cookie، Authorization، password، API key، secret، PII غیرضروری.
// کاملاً مستقل از HTTP: هیچ import از next/Request/NextResponse ندارد (سند §18).

import type { AiUsageEvent, AiUsageEventStatus, PrismaClient } from "@prisma/client"

import {
    AiUsageConflictError,
    IdempotencyConflictError,
    QuotaUnavailableError,
} from "./errors"

// تشخیص unique-constraint violation بدون import از @prisma/client runtime (مرز §9.11 — duck-typing)
function isUniqueViolation(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "P2002"
    )
}

export type PrismaClientLike = PrismaClient | any

export interface AiUsageEventInput {
    requestId: string
    userId: number
    /** نام فیچر مصرف‌کننده (مثلاً "analyze" یا "ai-test") — هرگز شامل داده‌ی کاربر نیست */
    feature: string
    units: number
    /** نام مدل provider — اختیاری و فقط متادیتای امن */
    model?: string
}

/**
 * وضعیت رویداد موجود برای یک requestId را برمی‌گرداند؛ اگر وجود نداشت null.
 * در صورت خطای DB، fail-closed: QUOTA_UNAVAILABLE.
 */
export async function findEventStatusByRequestId(
    prisma: PrismaClientLike,
    requestId: string,
): Promise<AiUsageEventStatus | null> {
    try {
        const event = await prisma.aiUsageEvent.findUnique({
            where: { requestId },
            select: { status: true },
        })
        return event ? event.status : null
    } catch (error) {
        throw new QuotaUnavailableError()
    }
}

/**
 * ساخت رویداد RESERVED برای یک logical AI request.
 * requestId UNIQUE است؛ اگر تکراری باشد → IdempotencyConflictError (سند §15).
 */
export async function createReservedEvent(
    prisma: PrismaClientLike,
    input: AiUsageEventInput,
): Promise<AiUsageEvent> {
    try {
        return await prisma.aiUsageEvent.create({
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
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw new IdempotencyConflictError()
        }
        throw new QuotaUnavailableError()
    }
}

/**
 * transitionEventToConsumed — RESERVED → CONSUMED و بازگرداندن هویت event (سند §11/§18).
 *
 * مالکیت state transition طبق §18 در همین سرویس است؛ aiQuota فقط orchestration و mutation
 * ردیف quota را انجام می‌دهد. ترتیب query دقیقاً «read → conditional update» است
 * (همان ترتیبی که قبلاً در aiQuota اجرا می‌شد) تا رفتار تراکنشی/rollback تغییر نکند.
 *
 * @param client کلاینت Prisma یا `tx` همان transaction کووتا (در مسیر تراکنشی هرگز root prisma)
 * @returns `{ units, userId }` اگر transition انجام شد؛ `null` اگر event نبود یا دیگر RESERVED نبود
 *          (تشخیص idempotent/conflict در لایه‌ی aiQuota است)
 * @throws QuotaUnavailableError در خطای DB (fail-closed) — بدون افشای خطای خام
 */
export async function transitionEventToConsumed(
    client: PrismaClientLike,
    requestId: string,
): Promise<{ units: number; userId: number } | null> {
    try {
        const event = await client.aiUsageEvent.findUnique({
            where: { requestId },
            select: { units: true, userId: true },
        })
        if (!event) return null

        // conditional update: فقط اگر هنوز RESERVED باشد — اتمیک، دوباره‌transition ناممکن (سند §11)
        const updated = await client.aiUsageEvent.updateMany({
            where: { requestId, status: "RESERVED" },
            data: { status: "CONSUMED" },
        })
        if (updated.count === 0) return null

        return { units: event.units, userId: event.userId }
    } catch (error) {
        throw new QuotaUnavailableError()
    }
}

/**
 * transitionEventToReleased — RESERVED → RELEASED و بازگرداندن هویت event (سند §11/§13/§18).
 *
 * `failureCode` فقط وقتی نوشته می‌شود که ارائه شده باشد (سند §۱۲) — بدون تغییر داده‌ی قبلی؛
 * همان failureCode موفقِ provider یا RELEASE_FAILED در همین transition می‌نشیند.
 *
 * @param client کلاینت Prisma یا `tx` همان transaction کووتا (در مسیر تراکنشی هرگز root prisma)
 * @returns `{ units, userId }` اگر transition انجام شد؛ `null` اگر event نبود یا دیگر RESERVED نبود
 * @throws QuotaUnavailableError در خطای DB (fail-closed) — بدون افشای خطای خام
 */
export async function transitionEventToReleased(
    client: PrismaClientLike,
    requestId: string,
    failureCode?: string,
): Promise<{ units: number; userId: number } | null> {
    try {
        const event = await client.aiUsageEvent.findUnique({
            where: { requestId },
            select: { units: true, userId: true },
        })
        if (!event) return null

        const updated = await client.aiUsageEvent.updateMany({
            where: { requestId, status: "RESERVED" },
            data: {
                status: "RELEASED",
                // failureCode فقط وقتی ارائه شده باشد نوشته می‌شود (بدون تغییر رفتار قبلی)
                ...(failureCode ? { failureCode } : {}),
            },
        })
        if (updated.count === 0) return null

        return { units: event.units, userId: event.userId }
    } catch (error) {
        throw new QuotaUnavailableError()
    }
}

/** کد قفل‌شده‌ی `failureCode` برای سناریوی release failure (سند §13 فاز ۱). */
export const RELEASE_FAILED_CODE = "RELEASE_FAILED"

/**
 * markReleaseFailed — Release failure را روی همان event قابل تشخیص می‌کند (سند §13).
 *
 * سناریو: reserve موفق → provider failure → release DB failure.
 * قرارداد §13: reservation باقی می‌ماند و event در RESERVED باقی می‌ماند، ولی
 * `failureCode = "RELEASE_FAILED"` ثبت می‌شود تا reconciliation آینده
 * (RESERVED + timeout + requestId، سند §14) این حالت را از crash یا provider در حال اجرا
 * تفکیک کند. provider دوباره صدا زده نمی‌شود و وضعیت event تغییر نمی‌کند.
 *
 * Best-effort است و **هرگز throw نمی‌کند**: شکست این نوشتن نباید مسیر fail-closed موجود
 * (503 QUOTA_UNAVAILABLE) را تغییر دهد. فقط eventهای هنوز RESERVED علامت می‌خورند.
 * @returns true اگر علامت‌گذاری انجام شد؛ در غیر این صورت (نبود/غیر-RESERVED/خطای DB) false.
 */
export async function markReleaseFailed(
    prisma: PrismaClientLike,
    requestId: string,
): Promise<boolean> {
    try {
        const result = await prisma.aiUsageEvent.updateMany({
            where: { requestId, status: "RESERVED" },
            data: { failureCode: RELEASE_FAILED_CODE },
        })
        return result.count > 0
    } catch {
        // best-effort: خطای علامت‌گذاری هرگز مسیر fail-closed را نمی‌شکند (سند §13)
        return false
    }
}

/**
 * resolve وضعیت فعلی و اعتبارسنجی transition برای complete/release.
 * در aiQuota.service برای تشخیص idempotent-no-op و conflict استفاده می‌شود.
 */
export function assertTransitionAllowed(
    current: AiUsageEventStatus,
    target: "CONSUMED" | "RELEASED",
): "allowed" | "idempotent" | "conflict" {
    if (current === "RESERVED") return "allowed"
    if (current === target) return "idempotent"
    return "conflict" // CONSUMED→release یا RELEASED→complete
}

export { AiUsageConflictError, IdempotencyConflictError, QuotaUnavailableError }
