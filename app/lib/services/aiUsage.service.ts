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

import type { AiCallTelemetry } from "@/app/lib/ai/aiDuration"

import {
    AiUsageConflictError,
    IdempotencyConflictError,
    QuotaUnavailableError,
} from "./errors"

/**
 * instrumentation اختیاری (مرحلهٔ ۴.۲) — فقط دو ستونِ از قبل موجود در مدل
 * `AiUsageEvent` نوشته می‌شوند:
 *
 *   durationMs — مدت واقعی logical AI operation (شامل همهٔ تلاش‌ها و backoffها)
 *   attempts   — تعداد واقعی provider callها؛ پیش از این مرحله همیشه ۱ بود
 *
 * هیچ migration و هیچ تغییر schema در کار نیست. اگر telemetry نبود یا نامعتبر
 * بود، شیء خالی برمی‌گردد و update دقیقاً مثل قبل اجرا می‌شود.
 */
function toTelemetryData(telemetry: AiCallTelemetry | undefined): {
    durationMs?: number
    attempts?: number
} {
    if (telemetry === undefined || telemetry === null) return {}
    const data: { durationMs?: number; attempts?: number } = {}
    if (Number.isFinite(telemetry.durationMs) && telemetry.durationMs >= 0) {
        data.durationMs = Math.round(telemetry.durationMs)
    }
    if (
        telemetry.attempts !== undefined &&
        Number.isFinite(telemetry.attempts) &&
        telemetry.attempts >= 1
    ) {
        data.attempts = Math.round(telemetry.attempts)
    }
    return data
}

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
    /** نام فیچر مصرف‌کننده (مثلاً "analyze" یا "plan") — هرگز شامل داده‌ی کاربر نیست */
    feature: string
    units: number
    /** نام مدل provider — اختیاری و فقط متادیتای امن */
    model?: string
    /**
     * ── فیلدهای audit نسخهٔ ۲ (تصمیم D5/D6) ──────────────────────────────────
     * همه اختیاری‌اند تا مسیر legacy دقیقاً مثل قبل کار کند.
     *
     * `quotaSource` + `bucketId` با هم می‌آیند/می‌روند (DB CHECK این را تضمین
     * می‌کند) و می‌گویند مصرف از کدام ledger (BASE یا PROMO) آمده.
     *
     * `policyAllowedUnits` snapshot ظرفیت مؤثر در **لحظهٔ رزرو** است. بدون آن،
     * تغییر ادمینِ سقف وسطِ ماه (مثلاً ۱۵ → ۵) رکوردهای قبلی را غیرقابل‌تفسیر
     * می‌کرد؛ با آن، audit می‌تواند بگوید هر عملیات زیر چه ظرفیتی مجاز بوده.
     */
    quotaSource?: "BASE" | "PROMO" | null
    policyAllowedUnits?: number | null
    bucketId?: number | null
}

/** متادیتای واقعی provider که **بعد** از اجرای AI معلوم می‌شود (تصمیم D6). */
export interface ProviderOutcome {
    /** شناسه‌ی provider واقعاً استفاده‌شده — هرگز hard-code (مثلاً "1xai") */
    provider: string
    model?: string | null
    fallbackUsed?: boolean | null
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
                quotaSource: input.quotaSource ?? null,
                policyAllowedUnits: input.policyAllowedUnits ?? null,
                bucketId: input.bucketId ?? null,
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
 * ثبت provider/model/fallback **واقعی** روی همان رویداد (تصمیم D6).
 *
 * چرا جدا از reserve: در لحظهٔ رزرو هنوز provider صدا زده نشده و معلوم نیست
 * fallback رخ می‌دهد یا نه. پس نتیجهٔ واقعی provider client بعداً روی همان
 * `requestId` نوشته می‌شود. `null` باقی ماندن یعنی «provider نهایی ثبت نشد» که
 * برای عملیات‌های mock/بدون AI قابل استناد است.
 *
 * best-effort: هیچ‌وقت throw نمی‌کند و نتیجهٔ AI را خراب نمی‌کند.
 */
export async function recordProviderOutcome(
    prisma: PrismaClientLike,
    requestId: string,
    outcome: ProviderOutcome,
): Promise<boolean> {
    try {
        const result = await prisma.aiUsageEvent.updateMany({
            where: { requestId },
            data: {
                provider: outcome.provider,
                model: outcome.model ?? null,
                fallbackUsed: outcome.fallbackUsed ?? null,
            },
        })
        return result.count > 0
    } catch {
        return false
    }
}

/**
 * ثبت ledger واقعیِ مصرف روی رویدادِ **از قبل RESERVED**.
 *
 * چرا جدا از `createReservedEvent` است: در لحظهٔ ساخت رویداد معلوم نیست مصرف از
 * کدام منبع تأمین می‌شود (در `NEW` اول PROMO امتحان می‌شود، در `LEGACY` اول BASE).
 * پس ledger بعد از تصمیمِ رزرو روی **همان** ردیف نوشته می‌شود.
 *
 * چرا اینجا و نه در `aiQuota.service`: طبق §18 مالکیت `AiUsageEvent` با همین ماژول
 * است؛ سرویس سهمیه فقط orchestration و mutation ردیف quota را انجام می‌دهد.
 * همین مرز باعث می‌شود `complete`/`release` بتوانند به `bucketId` تکیه کنند بدون
 * آنکه `aiQuota` خودش به جدول رویداد دست بزند.
 *
 * برخلاف `recordProviderOutcome` این **best-effort نیست**: اگر ثبت ledger شکست
 * بخورد، `complete`/`release` نمی‌توانند تشخیص دهند رزرو روی کدام ledger بوده، پس
 * خطا باید fail-closed (503) باشد تا transaction رزرو rollback شود.
 *
 * @returns `true` اگر رویداد به‌روز شد؛ `false` اگر رویداد نبود/پیدا نشد.
 */
export async function recordReservationLedger(
    client: PrismaClientLike,
    input: { requestId: string; quotaSource: "BASE" | "PROMO"; bucketId: number | null },
): Promise<boolean> {
    try {
        const result = await client.aiUsageEvent.updateMany({
            where: { requestId: input.requestId, status: "RESERVED" },
            data: { quotaSource: input.quotaSource, bucketId: input.bucketId },
        })
        return result.count > 0
    } catch {
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
 * @returns `{ units, userId, bucketId }` اگر transition انجام شد؛ `null` اگر event نبود یا دیگر RESERVED نبود
 *          (تشخیص idempotent/conflict در لایه‌ی aiQuota است). `bucketId` برای ledger نسخهٔ ۲
 *          (BASE/PROMO) لازم است و در مسیر legacy `null` می‌ماند.
 * @throws QuotaUnavailableError در خطای DB (fail-closed) — بدون افشای خطای خام
 */
export async function transitionEventToConsumed(
    client: PrismaClientLike,
    requestId: string,
    telemetry?: AiCallTelemetry,
): Promise<{ units: number; userId: number; bucketId: number | null } | null> {
    try {
        const event = await client.aiUsageEvent.findUnique({
            where: { requestId },
            select: { units: true, userId: true, bucketId: true },
        })
        if (!event) return null

        // conditional update: فقط اگر هنوز RESERVED باشد — اتمیک، دوباره‌transition ناممکن (سند §11)
        const updated = await client.aiUsageEvent.updateMany({
            where: { requestId, status: "RESERVED" },
            data: { status: "CONSUMED", ...toTelemetryData(telemetry) },
        })
        if (updated.count === 0) return null

        return { units: event.units, userId: event.userId, bucketId: event.bucketId }
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
 * @returns `{ units, userId, bucketId }` اگر transition انجام شد؛ `null` اگر event نبود یا دیگر RESERVED نبود
 * @throws QuotaUnavailableError در خطای DB (fail-closed) — بدون افشای خطای خام
 */
export async function transitionEventToReleased(
    client: PrismaClientLike,
    requestId: string,
    failureCode?: string,
    telemetry?: AiCallTelemetry,
): Promise<{ units: number; userId: number; bucketId: number | null } | null> {
    try {
        const event = await client.aiUsageEvent.findUnique({
            where: { requestId },
            select: { units: true, userId: true, bucketId: true },
        })
        if (!event) return null

        const updated = await client.aiUsageEvent.updateMany({
            where: { requestId, status: "RESERVED" },
            data: {
                status: "RELEASED",
                // failureCode فقط وقتی ارائه شده باشد نوشته می‌شود (بدون تغییر رفتار قبلی)
                ...(failureCode ? { failureCode } : {}),
                ...toTelemetryData(telemetry),
            },
        })
        if (updated.count === 0) return null

        return { units: event.units, userId: event.userId, bucketId: event.bucketId }
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
