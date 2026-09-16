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
    /** شروع ماه جاری — 00:00:00.000 UTC */
    periodStart: Date
    /** شروع ماه بعد — مرز rollover؛ ماه جدید AiUsage row مستقل خودش را می‌گیرد */
    nextPeriodStart: Date
}

/**
 * بازه‌ی ماهانه‌ی تقویمی UTC شامل لحظه‌ی now.
 * (فاز ۱: پرود سند محاسبه‌ی monthStart بر اساس User.timezone را برای reserve/complete
 *  به لایه‌ی aiQuota می‌سپارد که با context کاربر فراخوانی می‌شود؛ این تابع مرز UTC تقویمی است.)
 */
export function getMonthlyPeriod(now: Date): MonthlyPeriod {
    const periodStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
    )
    const nextPeriodStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0),
    )
    return { periodStart, nextPeriodStart }
}
