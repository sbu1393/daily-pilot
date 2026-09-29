// AI Quota v2 — مرز گذار legacy ⇄ جدید (Phase 2)
//
// ── قاعده‌ی قطعی (تنها مرجع تصمیم) ────────────────────────────────────────────
//
//   firstNewPeriodStart(cutoverAt, tz) = اولین شروعِ دوره‌ی ماهانه‌ی محلی که
//                                         >= cutoverAt باشد
//
//   quotaMode = NEW    ⟺  periodStart >= firstNewPeriodStart(cutoverAt, tz)
//   quotaMode = LEGACY ⟺  periodStart <  firstNewPeriodStart(cutoverAt, tz)
//
// چرا این فرمول و نه «periodStart < nextPeriodStartOf(cutoverAt)»:
// آن فرمول در مرز دقیق (cutoverAt === periodStart) دوره را LEGACY می‌کرد، در حالی
// که قرارداد محصول می‌گوید همان دوره باید NEW باشد. اینجا مرز بسته به سمت راست
// است: «شروعِ دوره >= cutoverAt» ⇒ NEW. نتیجه:
//   • cutoverAt وسطِ یک دوره  → آن دوره (که شروعش < cutoverAt است) LEGACY، دوره‌ی بعد NEW
//   • cutoverAt === periodStart → همان دوره NEW (نه یک دوره دیرتر)
//
// مقایسه همیشه روی instant انجام می‌شود و timezone خودِ کاربر را می‌گیرد، پس
// کاربران non-UTC (مثل Asia/Tehran) دقیقاً در مرز *خودشان* گذر می‌کنند.
//
// این ماژول خالص است (بدون I/O) تا هم در مسیر runtime و هم در تست قابل استفاده باشد.
// خواندن/به‌روزرسانی ردیف `AiQuotaCutover` از Prisma در همین فایل است، چون تصمیم
// و مرز باید در یک جا بمانند.

import { getMonthlyPeriod, type MonthlyPeriod } from "./planPolicy.service"
import { QuotaUnavailableError, ServiceError } from "./errors"
import type { PrismaClientLike } from "./aiUsage.service"

export type QuotaMode = "LEGACY" | "NEW"

/** 400 — تلاش برای عقب‌بردن مرز گذار (هرگز مجاز نیست). */
export class CutoverBackwardsError extends ServiceError {
    constructor() {
        super(
            409,
            "CUTOVER_BACKWARDS",
            "مرز گذار سهمیه را نمی‌توان به گذشته برد",
            undefined,
            "CONFLICT",
            "WARNING",
        )
    }
}

/**
 * اولین شروعِ دوره‌ی ماهانه‌ی محلی که **>= `cutoverAt`** است.
 *
 * دو حالت مهم:
 *   • `cutoverAt` دقیقاً روی مرز است → همان مرز، اولین دوره‌ی NEW است.
 *   • `cutoverAt` وسطِ یک دوره است → شروعِ دوره‌ی بعد.
 *
 * برای مرزهای DST از همان محاسبه‌ی دو-پاسی `localMonthStartUtc` در planPolicy
 * استفاده می‌شود، پس شروعِ ماه در timezoneهایی مثل Europe/Berlin همیشه یک
 * instant معتبر است.
 */
export function firstNewPeriodStart(cutoverAt: Date, timezone: string = "UTC"): Date {
    const period: MonthlyPeriod = getMonthlyPeriod(cutoverAt, timezone)

    // روی مرز یا بعد از آن ⇒ شروعِ همین دوره اولین دوره‌ی NEW است.
    if (period.periodStart.getTime() >= cutoverAt.getTime()) {
        return period.periodStart
    }

    // وسطِ یک دوره ⇒ شروعِ دوره‌ی بعد.
    return period.nextPeriodStart
}

/**
 * تصمیم قطعی legacy/جدید برای یک دوره‌ی مشخص.
 *
 * @param periodStart شروعِ دوره‌ای که قضاوت می‌شود (همان `AiUsage.periodStart` /
 *                    `AiQuotaBucket.periodStart` — یک instant، نه رشته)
 */
export function resolveQuotaMode(
    periodStart: Date,
    cutoverAt: Date,
    timezone: string = "UTC",
): QuotaMode {
    return periodStart.getTime() >= firstNewPeriodStart(cutoverAt, timezone).getTime()
        ? "NEW"
        : "LEGACY"
}

/** میان‌بر: حالتِ دوره‌ای که همین الان (برای همین کاربر) در جریان است. */
export function resolveCurrentQuotaMode(
    now: Date,
    cutoverAt: Date,
    timezone: string = "UTC",
): QuotaMode {
    return resolveQuotaMode(getMonthlyPeriod(now, timezone).periodStart, cutoverAt, timezone)
}

/* ──────────────────────────────────────────────────────────────────────────── */
/* دسترسی به مرز گذار (تنها ردیف جدول)                                          */
/* ──────────────────────────────────────────────────────────────────────────── */

/** `cutoverAt` ذخیره‌شده در `AiQuotaCutover` (id = 1). خطای DB → fail-closed. */
export async function readCutoverAt(prisma: PrismaClientLike): Promise<Date> {
    try {
        const row = await prisma.aiQuotaCutover.findUnique({
            where: { id: 1 },
            select: { cutoverAt: true },
        })
        if (!row?.cutoverAt) throw new QuotaUnavailableError()
        return row.cutoverAt
    } catch (error) {
        if (error instanceof QuotaUnavailableError) throw error
        throw new QuotaUnavailableError()
    }
}

/**
 * قاعده‌ی فعال‌سازی: اگر لحظه‌ی فعال‌سازی از مرز فعلی گذشته باشد، مرز **جلو** برده
 * می‌شود تا آخرین دوره‌ی legacy همان دوره‌ی فعال‌سازی باشد.
 *
 * هرگز به عقب برده نمی‌شود: عقب‌بردن، دوره‌هایی را که قبلاً NEW بوده‌اند LEGACY
 * می‌کند و داده‌ی `AiQuotaBucket` آن‌ها نامرئی/بی‌اثر می‌شود (بازگشت بی‌صدا از
 * سیستم جدید به قدیمی، که بدترین حالت ممکن است).
 *
 * @returns مقدارِ پیشنهادی؛ اگر `current` در آینده باشد **بدون تغییر** برمی‌گردد.
 */
export function resolveActivationCutover(current: Date, activationAt: Date): Date {
    return activationAt.getTime() > current.getTime() ? activationAt : current
}

/**
 * نوشتن مرز گذار با guard سخت: عقب‌بردن ممنوع.
 *
 * @throws CutoverBackwardsError اگر `next` < مقدار فعلی باشد.
 */
export async function setCutoverAt(
    prisma: PrismaClientLike,
    next: Date,
    note?: string,
): Promise<Date> {
    const current = await readCutoverAt(prisma)
    if (next.getTime() < current.getTime()) {
        throw new CutoverBackwardsError()
    }
    try {
        await prisma.aiQuotaCutover.update({
            where: { id: 1 },
            data: { cutoverAt: next, ...(note ? { note } : {}) },
        })
        return next
    } catch {
        throw new QuotaUnavailableError()
    }
}
