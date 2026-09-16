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

export interface AiUsageEventWithStatus {
    event: AiUsageEvent
    status: AiUsageEventStatus
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
 * RESERVED → CONSUMED (سند §11).
 * Idempotent: CONSUMED → no-op. نامعتبر: RELEASED → AI_USAGE_CONFLICT.
 * @returns true اگر transition انجام شد؛ false اگر idempotent no-op بود.
 */
export async function markEventConsumed(
    prisma: PrismaClientLike,
    requestId: string,
): Promise<boolean> {
    try {
        // conditional update: فقط اگر هنوز RESERVED باشد — اتمیک و بدون read-then-write
        const result = await prisma.aiUsageEvent.updateMany({
            where: { requestId, status: "RESERVED" },
            data: { status: "CONSUMED" },
        })
        return result.count === 1
    } catch (error) {
        throw new QuotaUnavailableError()
    }
}

/**
 * RESERVED → RELEASED (سند §11).
 * Idempotent: RELEASED → no-op. نامعتبر: CONSUMED → AI_USAGE_CONFLICT.
 * @returns true اگر transition انجام شد؛ false اگر idempotent no-op بود.
 */
export async function markEventReleased(
    prisma: PrismaClientLike,
    requestId: string,
): Promise<boolean> {
    try {
        const result = await prisma.aiUsageEvent.updateMany({
            where: { requestId, status: "RESERVED" },
            data: { status: "RELEASED" },
        })
        return result.count === 1
    } catch (error) {
        throw new QuotaUnavailableError()
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
