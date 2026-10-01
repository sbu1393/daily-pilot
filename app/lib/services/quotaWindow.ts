// AI Quota — پنجرهٔ دورهٔ سهمیه بر پایهٔ چرخهٔ اشتراک (مسیر A).
//
// ── چرا این ماژول وجود دارد ─────────────────────────────────────────────────
// پنجرهٔ دورهٔ سهمیه قبلاً **تقویمی** بود: `getMonthlyPeriod(now, timezone)` اولِ ماهِ
// محلیِ کاربر را برمی‌گرداند. نتیجه این بود که مرز سهمیه با مرز اشتراک هیچ ربطی
// نداشت و دو باگ تجاری جدی می‌ساخت:
//
//   ۱) کاربری که ۳۱ شهریور اشتراک ۳۰روزه می‌خرید، در ۱ مهر یک دورهٔ **تازه** هم
//      می‌گرفت ⇒ عملاً دو برابر سهمیه، بدون پول بیشتر.
//   ۲) عددی که در کارت فروش وعده داده می‌شد (۳۰ روزه = ۲۷۰ تحلیل) تضمین‌شدنی نبود،
//      چون تقاطع ۳۰ روز با مرزهای ماه می‌توانست تا ۴ دورهٔ کامل بدهد.
//
// این ماژول تنها راه‌حل است: **لنگر** می‌گیرد و هر ۳۰ روز یک دوره می‌سازد. تمام محاسبه
// فقط timestamp است (`addDays`) — هیچ ماه تقویمی، هیچ timezone، هیچ I/O.
//
// ── قواعد LOCKED ───────────────────────────────────────────────────────────
// - **خالص (pure)**: بدون DB، بدون Date.now، بدون env. همه‌چیز از ورودی می‌آید تا
//   هم در runtime و هم در تست کاملاً deterministic باشد. خواندن entitlement از DB
//   در `resolveQuotaWindowFor` انجام می‌شود و نتیجهٔ خالص این فایل را می‌گیرد.
// - **لنگر فعال**: فقط `Entitlement` با `status = ACTIVE` و `now < currentPeriodEnd`
//   لنگر است. ردیف منقضی (یا ACTIVEِ گذشته = lazy-expired) **هرگز** لنگر نمی‌شود؛
//   وگرنه یک ردیف با تاریخ ۱۹۷۰ لنگری می‌ساخت که همیشه index=0 می‌داد.
// - **۳۰ روز = یک دوره**: `periodIndex = floor((now − anchor) / 30 روز)`. عبور از مرز ماه
//   تقویمی هیچ اثری ندارد.
// - **ظرفیت snapshot** (گزینهٔ ۱ محصول): هر دورهٔ کامل = سهمیهٔ کامل policy در لحظهٔ
//   ایجاد. **بدون prorate** برای دورهٔ ناقص آخر، چون محصولات فعلی فقط ۳۰/۶۰/۹۰ روزه‌اند.
// - سقف دورهٔ ناقص هم **هرگز از مقدار ماهانه بیشتر نمی‌شود** و هرگز منفی نمی‌شود.

import { getMonthlyPeriod } from "./planPolicy.service"
import type { PrismaClientLike } from "./aiUsage.service"

/** یک روز = دقیقاً ۲۴ ساعت — هم‌راستا با `entitlement.service` و بدون تقویم. */
export const MS_PER_DAY = 24 * 60 * 60 * 1000

/** طول هر دورهٔ سهمیه: دقیقاً یک ماه خریداری‌شده. */
export const QUOTA_PERIOD_DAYS = 30

/** جابه‌جایی timestamp — تنها واحد محاسبه در این فایل. */
export function addDays(base: Date, days: number): Date {
    return new Date(base.getTime() + days * MS_PER_DAY)
}

/** شکل حداقلی از ردیف `Entitlement` که این ماژول لازم دارد. */
export interface EntitlementWindowInput {
    status: string
    currentPeriodStart: Date
    currentPeriodEnd: Date
}

export type QuotaAnchorKind = "ENTITLEMENT" | "FREE_ANCHOR" | "CALENDAR"

export interface QuotaAnchor {
    kind: QuotaAnchorKind
    /** لنگر همیشه یک instant معتبر و «گذشته یا حال» است. */
    anchor: Date
}

export interface QuotaAnchorInput {
    now: Date
    entitlement?: EntitlementWindowInput | null
    /** `User.quotaAnchorAt` — برای کاربر FREE/بدون اشتراک. */
    freeAnchor?: Date | null
    /** فقط برای fallback تقویمی. */
    timezone?: string
}

/**
 * انتخاب لنگر دوره.
 *
 * اولویت: اشتراک فعال ← لنگر کاربر FREE ← اولِ ماه تقویمی (fallback قدیمی).
 *
 * fallback تقویمی عمداً نگه داشته شده: کاربری که هنوز `quotaAnchorAt` ندارد (مثلاً
 * قبل از backfill) نباید سهمیه‌اش از بین برود یا fail-closed شود؛ رفتارش دقیقاً مثل
 * قبل می‌ماند تا وقتی backfill اجرا شود.
 */
export function resolveQuotaAnchor(input: QuotaAnchorInput): QuotaAnchor {
    const nowMs = input.now.getTime()

    const entitlement = input.entitlement ?? null
    if (
        entitlement !== null &&
        entitlement.status === "ACTIVE" &&
        nowMs < entitlement.currentPeriodEnd.getTime() &&
        nowMs >= entitlement.currentPeriodStart.getTime()
    ) {
        return { kind: "ENTITLEMENT", anchor: new Date(entitlement.currentPeriodStart) }
    }

    const free = input.freeAnchor ?? null
    if (free !== null && Number.isFinite(free.getTime()) && free.getTime() > 0) {
        return { kind: "FREE_ANCHOR", anchor: free }
    }

    return {
        kind: "CALENDAR",
        anchor: calendarPeriodStart(input.now, input.timezone ?? "UTC"),
    }
}

/** اولِ ماه تقویمی محلی — تنها fallback این ماژول. */
export function calendarPeriodStart(now: Date, timezone: string): Date {
    return getMonthlyPeriod(now, timezone).periodStart
}

export interface QuotaWindowInput extends QuotaAnchorInput {}

export interface QuotaWindow {
    /** شروع دورهٔ جاری — همان چیزی که `AiQuotaBucket.periodStart` می‌شود. */
    periodStart: Date
    /** پایان انحصاری دورهٔ جاری. */
    periodEnd: Date
    /** شمارهٔ دوره از صفر، نسبت به لنگر. */
    periodIndex: number
    anchor: Date
    anchorKind: QuotaAnchorKind
}

/**
 * پنجرهٔ دورهٔ جاری.
 *
 * نکتهٔ منفی‌شدن: اگر somehow `now` قبل از لنگر باشد، `index` به ۰ کلیپ می‌شود تا
 * `periodStart` هرگز **بعد** از لنگر نیفتد (که ساخت bucket را غیرقابل‌بازگشت می‌کرد).
 */
export function quotaWindowFor(input: QuotaWindowInput): QuotaWindow {
    const { kind, anchor } = resolveQuotaAnchor(input)
    const elapsedDays = Math.floor((input.now.getTime() - anchor.getTime()) / MS_PER_DAY)
    const index = Math.max(0, Math.floor(elapsedDays / QUOTA_PERIOD_DAYS))
    const periodStart = addDays(anchor, index * QUOTA_PERIOD_DAYS)
    return {
        periodStart,
        periodEnd: addDays(periodStart, QUOTA_PERIOD_DAYS),
        periodIndex: index,
        anchor,
        anchorKind: kind,
    }
}

/** تعداد دوره‌های کاملی که یک اشتراک با این مدت می‌خرد — `floor(days / 30)`. */
export function entitlementPeriodCount(entitlementDays: number): number {
    if (!Number.isFinite(entitlementDays) || entitlementDays <= 0) return 0
    return Math.floor(entitlementDays / QUOTA_PERIOD_DAYS)
}

/** مدت باقی‌ماندهٔ اشتراک از لنگر تا `now` (میلی‌ثانیه)، یا `null` بدون اشتراک فعال. */
function remainingMs(
    input: QuotaWindowInput,
    now: Date,
): { start: Date; end: Date } | null {
    const entitlement = input.entitlement ?? null
    if (
        entitlement === null ||
        entitlement.status !== "ACTIVE" ||
        now.getTime() >= entitlement.currentPeriodEnd.getTime()
    ) {
        return null
    }
    return { start: entitlement.currentPeriodStart, end: entitlement.currentPeriodEnd }
}

export interface QuotaWindowTotals {
    /** تعداد دوره‌های ۳۰روزه‌ای که این اشتراک می‌خرد. */
    periods: number
    /** مجموع سقف تحلیل هوشمند در کل اشتراک. */
    analyze: number
    /** مجموع سقف برنامه‌ریزی هوشمند در کل اشتراک. */
    plan: number
}

/**
 * سقف تضمین‌شدهٔ محصول: ۳۰ روزه = ۲۷۰/۵۰ · ۶۰ روزه = ۵۴۰/۱۰۰ · ۹۰ روزه = ۸۱۰/۱۵۰.
 *
 * بدون اشتراک فعال، `periods` از **پنجرهٔ جاری** محاسبه می‌شود (کاربر رایگان: یک دوره).
 * با اشتراک فعال، `periods` از کل مدت خریداری‌شده می‌آید — یعنی همیشه همان عددی که
 * در کارت فروش به کاربر وعده داده شده، فارغ از اینکه چه روزی خریده است.
 */
export function quotaWindowTotals(input: QuotaWindowInput): QuotaWindowTotals {
    const entitlement = remainingMs(input, input.now)
    const periods =
        entitlement === null
            ? 1
            : entitlementPeriodCount(
                  Math.round((entitlement.end.getTime() - entitlement.start.getTime()) / MS_PER_DAY),
              )
    const safePeriods = Math.max(periods, 0)
    return {
        periods: safePeriods,
        analyze: safePeriods * 270,
        plan: safePeriods * 50,
    }
}

/**
 * ظرفیت دوره — گزینهٔ ۱ محصول: هر دورهٔ کامل = مقدار کامل policy، بدون prorate.
 *
 * `daysInPeriod` عمداً استفاده نمی‌شود جز برای اطمینان از اینکه خروجی هرگز از
 * `monthlyUnits` بیشتر و هرگز منفی نباشد. پارامتر نگه داشته شده تا امروز رفتار
 * «دورهٔ ناقص = کامل» صریح و قابل‌ردیابی بماند.
 */
export function periodCapacity(monthlyUnits: number, _daysInPeriod: number): number {
    if (!Number.isFinite(monthlyUnits) || monthlyUnits <= 0) return 0
    return Math.trunc(monthlyUnits)
}

/** نام مستعار خواناتر برای فراخوانی از لایهٔ DB. */
export function periodCapacityUnits(monthlyUnits: number, daysInPeriod: number): number {
    return periodCapacity(monthlyUnits, daysInPeriod)
}

// ────────────────────────────────────────────────────────────────────────────
// لایهٔ I/O — تنها نقطهٔ خواندن لنگر از دیتابیس
// ────────────────────────────────────────────────────────────────────────────

/**
 * `resolveQuotaWindowFor` — تنها دروازهٔ دورهٔ سهمیه برای همهٔ مسیرهای runtime.
 *
 * تنها یک `findUnique` روی `Entitlement(userId)` می‌زند (ایندکس یکتا) و همیشه
 * لنگرِ کاربر را در همان SELECT می‌خواند. هیچ cache و هیچ state نگه‌داشتنی ندارد،
 * پس یک تمدید هم‌زمان بلافاصله در درخواست بعدی دیده می‌شود.
 *
 * هیچ خطایی پرتاب نمی‌کند: خطای DB مثل «نبودِ لنگر» رفتار می‌کند (fallback تقویمی) تا
 * یک failover ساده، سهمیهٔ کاربر را از بین نبرد. Fail-closed در سطح ظرفیت انجام
 * می‌شود (سقف صفر ⇒ `QUOTA_EXCEEDED`)، نه در سطح خواندن.
 */
export async function resolveQuotaWindowFor(
    db: PrismaClientLike,
    input: {
        userId: number
        now?: Date
        timezone?: string
        /**
         * لنگر کاربرِ از قبل خوانده‌شده. callerهایی که همین حالا ردیف کاربر را دارند
         * (مثل صفحهٔ جزئیاتِ ادمین) این را پاس می‌دهند تا یک read اضافه روی همان ردیف
         * تکرار نشود.
         */
        knownFreeAnchor?: Date | null
    },
): Promise<QuotaWindow> {
    const now = input.now ?? new Date()
    let entitlement: EntitlementWindowInput | null = null
    let freeAnchor: Date | null = null

    try {
        const row = await db.entitlement.findUnique({
            where: { userId: input.userId },
            select: {
                status: true,
                currentPeriodStart: true,
                currentPeriodEnd: true,
            },
        })
        if (row) {
            entitlement = {
                status: row.status,
                currentPeriodStart: row.currentPeriodStart,
                currentPeriodEnd: row.currentPeriodEnd,
            }
        }
    } catch {
        entitlement = null
    }

    // لنگر کاربر جدا خوانده می‌شود تا یک خطای خواندن entitlement، لنگر رایگان را هم
    // از بین نبرد (fallback باید مستقل باشد). اگر caller لنگر را از قبل دارد، read
    // تکراری انجام نمی‌شود.
    if (input.knownFreeAnchor !== undefined) {
        freeAnchor = input.knownFreeAnchor
    } else {
        try {
            const userRow = await db.user.findUnique({
                where: { id: input.userId },
                select: { quotaAnchorAt: true, timezone: true },
            })
            freeAnchor = userRow?.quotaAnchorAt ?? null
            if (input.timezone === undefined && typeof userRow?.timezone === "string") {
                input = { ...input, timezone: userRow.timezone }
            }
        } catch {
            freeAnchor = null
        }
    }

    return quotaWindowFor({
        now,
        entitlement,
        freeAnchor,
        timezone: input.timezone ?? "UTC",
    })
}