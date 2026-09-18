// فاز ۱ — Policy پلن کاربر (سند §5)
// مسئولیت: resolve plan → allowedUnits ماهانه.
// هیچ route نباید عدد ۱۵ یا ۳۰۰ را hard-code کند — همه از همین سرویس می‌خوانند.
// این سرویس: quota row را تغییر نمی‌دهد، AI را صدا نمی‌زند، payment را مدیریت نمی‌کند،
// HTTP response نمی‌سازد و منطق خاص route ندارد.

import type { UserPlan } from "@prisma/client"

export interface PlanPolicy {
    plan: UserPlan
    /** سهمیه‌ی ماهانه‌ی AI (unit per logical AI operation) */
    allowedUnits: number
    /** نوع پریود کووتا — فاز ۱ فقط ماهانه */
    periodType: "MONTHLY"
}

const PLAN_LIMITS: Record<UserPlan, number> = {
    FREE: 15,
    PRO: 300,
}

/**
 * resolve plan کاربر → policy کووتا.
 * FREE (و هر مقدار نامعتبر/null/undefined) → 15 unit؛ PRO → 300 unit.
 */
export function resolvePlanPolicy(user: { plan?: string | null }): PlanPolicy {
    const plan: UserPlan = user.plan === "PRO" ? "PRO" : "FREE"
    return {
        plan,
        allowedUnits: PLAN_LIMITS[plan],
        periodType: "MONTHLY",
    }
}

export interface MonthlyPeriod {
    /** شروع ماه جاری — 00:00:00.000 در timezone کاربر، به شکل instant پایدار UTC */
    periodStart: Date
    /** شروع ماه بعد — مرز rollover؛ ماه جدید AiUsage row مستقل خودش را می‌گیرد */
    nextPeriodStart: Date
}

/** timezone معتبر (IANA) است؟ — بدون fallback پنهان در محاسبه */
function isValidTimezone(timezone: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone })
        return true
    } catch {
        return false
    }
}

/** اختلاف timezone با UTC در لحظه‌ی داده‌شده، بر حسب میلی‌ثانیه */
function timeZoneOffsetMs(date: Date, timezone: string): number {
    const parts = new Intl.DateTimeFormat("en", {
        timeZone: timezone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).formatToParts(date)

    const pick = (type: string): number => {
        const part = parts.find((p) => p.type === type)
        if (!part) throw new Error(`Intl did not return "${type}" part`)
        return Number(part.value)
    }

    const asUtc = Date.UTC(
        pick("year"),
        pick("month") - 1,
        pick("day"),
        pick("hour"),
        pick("minute"),
        pick("second"),
    )

    return asUtc - date.getTime()
}

/** سال/ماه تقویمی محلی در timezone داده‌شده */
function localYearMonth(date: Date, timezone: string): { year: number; month: number } {
    const parts = new Intl.DateTimeFormat("en", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
    }).formatToParts(date)

    const pick = (type: string): number => {
        const part = parts.find((p) => p.type === type)
        if (!part) throw new Error(`Intl did not return "${type}" part`)
        return Number(part.value)
    }

    return { year: pick("year"), month: pick("month") }
}

/**
 * instant UTC متناظر با 00:00:00 روز اول یک ماه محلی (`local month start`).
 * دو پاس برای درستی در مرزهای DST (مثل Europe/Berlin) — همان الگوی getLocalMidnight.
 */
function localMonthStartUtc(year: number, month: number, timezone: string): Date {
    const wallUtc = Date.UTC(year, month - 1, 1, 0, 0, 0, 0)
    let ts = wallUtc - timeZoneOffsetMs(new Date(wallUtc), timezone)
    ts = wallUtc - timeZoneOffsetMs(new Date(ts), timezone)
    return new Date(ts)
}

/**
 * بازه‌ی ماهانه‌ی تقویمی محلیِ timezone کاربر شامل لحظه‌ی now (سند §۶):
 *   local month start → timezone user → UTC instant → periodStart
 *
 * - پیش‌فرض `"UTC"` است تا فراخوان‌های بدون timezone و همه‌ی تست‌های قبلی دقیقاً رفتار قبل را
 *   حفظ کنند (backward compatible).
 * - timezone نامعتبر/خالی → fallback صریح به UTC (fail-safe؛ بدون پرتاب خطا در مسیر quota).
 */
export function getMonthlyPeriod(now: Date, timezone: string = "UTC"): MonthlyPeriod {
    const tz = timezone && isValidTimezone(timezone) ? timezone : "UTC"
    const { year, month } = localYearMonth(now, tz)

    // rollover سالانهٔ دسامبر → ژانویه
    const nextYear = month === 12 ? year + 1 : year
    const nextMonth = month === 12 ? 1 : month + 1

    return {
        periodStart: localMonthStartUtc(year, month, tz),
        nextPeriodStart: localMonthStartUtc(nextYear, nextMonth, tz),
    }
}
