// تست‌های RED مسیر A — «چرخهٔ سهمیه بر پایهٔ اشتراک».
//
// این فایل **قفل محصول** است: تضمین می‌کند یک اشتراک ۳۰/۶۰/۹۰ روزه هرگز بیشتر از
// ۱/۲/۳ دورهٔ ۳۰روزه سهمیه نمی‌گیرد، **مستقل از اینکه در کدام روز ماه تقویمی خریده شده**.
//
// محاسبه فقط timestamp است (`addDays(anchor, k * 30)`) — هیچ ماه تقویمی، هیچ
// `getMonthlyPeriod` در مسیر لنجربراست. اگر روزی کسی لنگر را به مرز ماه برگرداند، این
// تست‌ها باید قرمز شوند.

import { describe, expect, it } from "vitest"

import {
    MS_PER_DAY,
    QUOTA_PERIOD_DAYS,
    calendarPeriodStart,
    entitlementPeriodCount,
    periodCapacity,
    periodCapacityUnits,
    quotaWindowFor,
    quotaWindowTotals,
    resolveQuotaAnchor,
    type QuotaAnchorInput,
} from "./quotaWindow"

const DAY = MS_PER_DAY

/** ۳۱ شهریور ۱۴۰۵ ≈ 2026-09-22 (نزدیک انتهای ماه — بدترین حالت برای مدل تقویمی). */
const LAST_DAY_OF_SHABAN = new Date("2026-09-22T12:00:00.000Z")
/** اول ماه — بهترین حالت تصادفی برای مدل تقویمی. */
const FIRST_OF_MONTH = new Date("2026-09-01T08:00:00.000Z")

const MONTHLY_ANALYZE = 270
const MONTHLY_PLAN = 50

function active(start: Date, days: number) {
    return {
        status: "ACTIVE" as const,
        currentPeriodStart: start,
        currentPeriodEnd: new Date(start.getTime() + days * DAY),
    }
}

// ────────────────────────────────────────────────────────────────────────────
// resolveQuotaAnchor — انتخاب لنگر
// ────────────────────────────────────────────────────────────────────────────
describe("resolveQuotaAnchor", () => {
    const now = new Date("2026-09-25T00:00:00.000Z")

    it("uses the entitlement start for an active subscription", () => {
        const input: QuotaAnchorInput = {
            now,
            entitlement: active(FIRST_OF_MONTH, 90),
        }
        expect(resolveQuotaAnchor(input)).toEqual({
            kind: "ENTITLEMENT",
            anchor: FIRST_OF_MONTH,
        })
    })

    it("ignores an expired entitlement and falls back to the FREE anchor", () => {
        const free = new Date("2026-08-15T00:00:00.000Z")
        const input: QuotaAnchorInput = {
            now,
            entitlement: { ...active(new Date("2020-01-01T00:00:00.000Z"), 30), status: "EXPIRED" },
            freeAnchor: free,
        }
        expect(resolveQuotaAnchor(input)).toEqual({ kind: "FREE_ANCHOR", anchor: free })
    })

    it("treats an ACTIVE-but-past entitlement as expired (lazy expiration)", () => {
        const free = new Date("2026-08-15T00:00:00.000Z")
        const input: QuotaAnchorInput = {
            now,
            entitlement: active(new Date("2026-01-01T00:00:00.000Z"), 30), // پایانش گذشته
            freeAnchor: free,
        }
        expect(resolveQuotaAnchor(input)).toEqual({ kind: "FREE_ANCHOR", anchor: free })
    })

    it("refuses the 1970 sentinel row — a dead anchor is never used", () => {
        const input: QuotaAnchorInput = {
            now,
            entitlement: { ...active(new Date(0), 30), status: "EXPIRED" },
            freeAnchor: new Date("2026-08-15T00:00:00.000Z"),
        }
        const anchor = resolveQuotaAnchor(input)
        expect(anchor.anchor.getTime()).toBeGreaterThan(0)
    })

    it("falls back to the calendar when a FREE user has no anchor yet", () => {
        const input: QuotaAnchorInput = {
            now,
            entitlement: null,
            freeAnchor: null,
            timezone: "Asia/Tehran",
        }
        const anchor = resolveQuotaAnchor(input)
        expect(anchor.kind).toBe("CALENDAR")
        expect(anchor.anchor).toEqual(calendarPeriodStart(now, "Asia/Tehran"))
    })

    it("never picks an anchor in the future", () => {
        const input: QuotaAnchorInput = {
            now,
            entitlement: active(new Date("2027-01-01T00:00:00.000Z"), 30),
        }
        const anchor = resolveQuotaAnchor(input)
        expect(anchor.anchor.getTime()).toBeLessThanOrEqual(now.getTime())
    })
})

// ────────────────────────────────────────────────────────────────────────────
// دوره‌بندی — قلب تضمین محصول
// ────────────────────────────────────────────────────────────────────────────
describe("quotaWindowFor", () => {
    it("a 30-day plan yields exactly one period, whatever the purchase date", () => {
        for (const purchase of [LAST_DAY_OF_SHABAN, FIRST_OF_MONTH]) {
            for (const elapsedDays of [0, 1, 15, 29]) {
                const now = new Date(purchase.getTime() + elapsedDays * DAY)
                const win = quotaWindowFor({ now, entitlement: active(purchase, 30) })
                expect(win.periodIndex).toBe(0)
                expect(win.periodStart).toEqual(purchase)
            }
        }
    })

    it("a 90-day plan yields exactly three periods even across a month boundary", () => {
        // سناریوی کلیدی: خرید در ۳۱ شهریور ⇒ مرز ماه تقویمی وسط دوره می‌افتد.
        const purchase = LAST_DAY_OF_SHABAN
        // مدل تقویمیِ فعلی از روز ۲۸ به بعد چهارمین دوره را شروع می‌کند؛ این تست
        // نشان می‌دهد مدل لنجربراست این اتفاق **نمی‌افتد**.
        for (const elapsedDays of [28, 30, 31, 45, 60, 89]) {
            const now = new Date(purchase.getTime() + elapsedDays * DAY)
            const win = quotaWindowFor({ now, entitlement: active(purchase, 90) })
            expect(win.periodIndex).toBe(Math.floor(elapsedDays / QUOTA_PERIOD_DAYS))
            expect(win.periodIndex).toBeLessThanOrEqual(2)
        }
    })

    it("periods are contiguous 30-day spans from the anchor", () => {
        const purchase = LAST_DAY_OF_SHABAN
        const entitlement = active(purchase, 90)
        for (const index of [0, 1, 2]) {
            const now = new Date(purchase.getTime() + index * 30 * DAY + 5 * DAY)
            const win = quotaWindowFor({ now, entitlement })
            expect(win.periodStart.getTime()).toBe(purchase.getTime() + index * 30 * DAY)
            expect(win.periodEnd.getTime()).toBe(purchase.getTime() + (index + 1) * 30 * DAY)
        }
    })

    it("crossing a calendar month never changes the period boundary", () => {
        const purchase = new Date("2026-09-22T12:00:00.000Z") // ۳۱ شهریور
        const before = quotaWindowFor({
            now: new Date("2026-09-28T00:00:00.000Z"),
            entitlement: active(purchase, 90),
        })
        const after = quotaWindowFor({
            now: new Date("2026-10-05T00:00:00.000Z"), // ۱۴ مهر — وسط ماه تقویمی
            entitlement: active(purchase, 90),
        })
        // هر دو در دورهٔ صفر هستند؛ رول‌اوور در ۲۲ اکتبر است، نه ۱ اکتبر.
        expect(before.periodIndex).toBe(0)
        expect(after.periodIndex).toBe(0)
        expect(after.periodStart).toEqual(purchase)
    })

    it("a DST-observing timezone does not shift the boundary", () => {
        // Europe/Berlin: ۲۵ اکتبر ۲۰۲۶ آخرین یکشنبهٔ تابستان است (+02 → +01).
        const purchase = new Date("2026-10-20T09:00:00.000Z")
        const entitlement = active(purchase, 90)
        const start = quotaWindowFor({ now: purchase, entitlement })
        expect(start.periodStart.getTime()).toBe(purchase.getTime())
        // دقیقاً ۳۰ روز بعد، نه «اول ماه» و نه ۳۰ روزِ تقویمیِ متغیر.
        const after = quotaWindowFor({
            now: new Date("2026-10-26T00:00:00.000Z"),
            entitlement,
        })
        expect(after.periodStart.getTime()).toBe(purchase.getTime())
    })

    it("a 60-day plan yields exactly two periods", () => {
        const purchase = LAST_DAY_OF_SHABAN
        const entitlement = active(purchase, 60)
        expect(quotaWindowFor({ now: purchase, entitlement }).periodIndex).toBe(0)
        expect(
            quotaWindowFor({ now: new Date(purchase.getTime() + 30 * DAY), entitlement })
                .periodIndex,
        ).toBe(1)
        expect(
            quotaWindowFor({ now: new Date(purchase.getTime() + 59 * DAY), entitlement })
                .periodIndex,
        ).toBe(1)
    })

    it("a renewal before expiry keeps the original anchor", () => {
        // ۳۰ روزه خریده شده، ۲۰ روز بعد تمدید شده ⇒ ۶۰ روز کل، لنگرِ دست‌نخورده.
        const purchase = LAST_DAY_OF_SHABAN
        const renewed = active(purchase, 60) // currentPeriodStart دست‌نخورده
        expect(
            quotaWindowFor({ now: new Date(purchase.getTime() + 20 * DAY), entitlement: renewed })
                .periodIndex,
        ).toBe(0)
        expect(
            quotaWindowFor({ now: new Date(purchase.getTime() + 59 * DAY), entitlement: renewed })
                .periodIndex,
        ).toBe(1)
    })

    it("a purchase after expiry starts a fresh cycle at now", () => {
        const previous = active(new Date("2026-01-01T00:00:00.000Z"), 30)
        const freshStart = new Date("2026-09-25T00:00:00.000Z")
        const win = quotaWindowFor({ now: freshStart, entitlement: active(freshStart, 30) })
        expect(win.anchor).toEqual(freshStart)
        expect(previous.currentPeriodEnd.getTime()).toBeLessThan(freshStart.getTime())
    })
})

// ────────────────────────────────────────────────────────────────────────────
// سقف — تضمین ۸۱۰ / ۵۴۰ / ۲۷۰
// ────────────────────────────────────────────────────────────────────────────
describe("quotaWindowTotals — سقف تضمین‌شدهٔ محصول", () => {
    const SCENARIOS: { label: string; days: number; analyze: number; plan: number }[] = [
        { label: "۳۰ روزه", days: 30, analyze: 270, plan: 50 },
        { label: "۶۰ روزه", days: 60, analyze: 540, plan: 100 },
        { label: "۹۰ روزه", days: 90, analyze: 810, plan: 150 },
    ]

    it.each(SCENARIOS)("$label = $analyze تحلیل + $plan برنامه‌ریزی", ({ days, analyze, plan }) => {
        const purchase = LAST_DAY_OF_SHABAN
        const entitlement = active(purchase, days)
        const totals = quotaWindowTotals({ now: purchase, entitlement })
        expect(totals.periods).toBe(days / QUOTA_PERIOD_DAYS)
        expect(totals.analyze).toBe(analyze)
        expect(totals.plan).toBe(plan)
    })

    it.each(SCENARIOS)("$label از مرز ماه تقویمی بیشتر نمی‌شود", ({ days, analyze, plan }) => {
        // ترفند: خرید در آخرین روز ماه و عبور از چند مرز تقویمی. مدل تقویمیِ قدیمی
        // اینجا بیش از سقف می‌داد؛ لنجربراست نباید.
        const purchase = LAST_DAY_OF_SHABAN
        const entitlement = active(purchase, days)
        for (const elapsedDays of [1, 15, 28, 31, 45, days - 1]) {
            const now = new Date(purchase.getTime() + elapsedDays * DAY)
            const totals = quotaWindowTotals({ now, entitlement })
            expect(totals.analyze).toBeLessThanOrEqual(analyze)
            expect(totals.plan).toBeLessThanOrEqual(plan)
        }
    })

    it("never grants a fourth period to a 90-day plan", () => {
        const purchase = LAST_DAY_OF_SHABAN
        const entitlement = active(purchase, 90)
        const lastDay = new Date(purchase.getTime() + 89 * DAY)
        expect(quotaWindowFor({ now: lastDay, entitlement }).periodIndex).toBe(2)
        expect(quotaWindowTotals({ now: lastDay, entitlement }).periods).toBe(3)
    })

    it("entitlementPeriodCount is the plain floor of days / 30", () => {
        expect(entitlementPeriodCount(30)).toBe(1)
        expect(entitlementPeriodCount(60)).toBe(2)
        expect(entitlementPeriodCount(90)).toBe(3)
        expect(entitlementPeriodCount(45)).toBe(1)
        expect(entitlementPeriodCount(0)).toBe(0)
    })
})

// ────────────────────────────────────────────────────────────────────────────
// ظرفیت snapshot
// ────────────────────────────────────────────────────────────────────────────
describe("periodCapacity — گزینهٔ ۱ (بدون prorate)", () => {
    it("a full period gets the full policy value", () => {
        expect(periodCapacity(270, QUOTA_PERIOD_DAYS)).toBe(270)
        expect(periodCapacity(50, QUOTA_PERIOD_DAYS)).toBe(50)
    })

    it("a partial trailing period also gets the full policy (no proration by decision)", () => {
        expect(periodCapacity(270, 15)).toBe(270)
        expect(periodCapacity(270, 1)).toBe(270)
    })

    it("capacity never goes negative and never exceeds the monthly value", () => {
        for (const daysInPeriod of [-5, 0, 1, 15, 29, 30]) {
            const cap = periodCapacityUnits(270, daysInPeriod)
            expect(cap).toBeGreaterThanOrEqual(0)
            expect(cap).toBeLessThanOrEqual(270)
        }
    })

    it("a non-positive policy stays non-positive (fail-closed, no free quota)", () => {
        expect(periodCapacityUnits(0, 30)).toBe(0)
        expect(periodCapacityUnits(-1, 30)).toBe(0)
    })
})