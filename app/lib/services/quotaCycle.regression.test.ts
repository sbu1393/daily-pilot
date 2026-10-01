// مسیر A — regression سناریوهای لنگر (بند ۵ برنامهٔ اجرا).
//
// این فایل «کاشف» است: هر سناریویی که مدل لنجربراست باید در آن درست باشد، اینجا از
// سرِ سرویس‌های واقعی (`auth` → `entitlement` → `quotaWindow` → `aiQuotaV2`) عبور
// می‌کند، نه از یک تابع خالص. بنابراین یک باگ در wiring هم اینجا لو می‌رود.
//
// ستون فقرات همهٔ تست‌ها: **هیچ مسیر quota نباید به تقویم برگردد.** هر ادعای
// «۳۰/۶۰/۹۰ روزه = ۱/۲/۳ دوره» باید مستقل از اینکه خرید در کدام روز ماه بوده
// برقرار بماند.

import { describe, expect, it } from "vitest"

import { activate, renew } from "./entitlement.service"
import { readQuotaBuckets, reserveBucketQuota } from "./aiQuotaV2.service"
import { quotaWindowFor, resolveQuotaWindowFor, MS_PER_DAY } from "./quotaWindow"

const DAY = MS_PER_DAY
/** ۳۱ شهریور — بدترین روز ممکن برای یک مدل تقویمی. */
const LAST_DAY = new Date("2026-09-22T12:00:00.000Z")
const USER = 7

const POLICY = {
    "FREE:ANALYZE": 15,
    "FREE:PLAN": 2,
    "PRO:ANALYZE": 270,
    "PRO:PLAN": 50,
}

/**
 * کلاینت کوچک که فقط چیزهای مورد نیاز این مسیر را می‌دهد:
 * `entitlement` (لنگر PRO)، `user` (لنگر FREE)، `aiQuotaBucket` و `aiQuotaPolicy`.
 */
function makeClient(seed: {
    entitlement?: Record<string, unknown> | null
    freeAnchor?: Date | null
    timezone?: string
} = {}) {
    const policy = new Map(Object.entries(POLICY))
    const buckets = new Map<string, any>()
    const events = new Map<string, any>()
    let nextId = 1
    const key = (w: any) =>
        `${w.userId}|${w.feature}|${w.source}|${w.periodType}|${w.periodStart.toISOString()}`

    const client: any = {
        entitlement: {
            findUnique: async () => seed.entitlement ?? null,
            create: async () => {
                throw new Error("create not expected in these tests")
            },
            updateMany: async () => ({ count: 0 }),
        },
        user: {
            updateMany: async () => ({ count: 1 }),
            findUnique: async () => ({
                id: USER,
                timezone: seed.timezone ?? "Asia/Tehran",
                quotaAnchorAt: seed.freeAnchor ?? null,
            }),
        },
        aiQuotaPolicy: {
            findUnique: async ({ where }: any) => ({
                allowedUnits: policy.get(`${where.plan_feature.plan}:${where.plan_feature.feature}`) ?? 0,
            }),
        },
        aiUsageEvent: {
            findUnique: async ({ where }: any) => {
                const e = events.get(where.requestId)
                return e ? { status: e.status } : null
            },
            create: async ({ data }: any) => {
                if (events.has(data.requestId)) {
                    const err: any = new Error("unique")
                    err.code = "P2002"
                    throw err
                }
                const row = { id: nextId++, status: "RESERVED", bucketId: null, ...data }
                events.set(data.requestId, row)
                return row
            },
            updateMany: async ({ where, data }: any) => {
                let count = 0
                for (const [id, e] of events) {
                    if (where.requestId !== undefined && id !== where.requestId) continue
                    Object.assign(e, data)
                    count++
                }
                return { count }
            },
        },
        aiQuotaBucket: {
            findUnique: async ({ where }: any) => {
                for (const row of buckets.values()) {
                    if (key(where.userId_feature_source_periodType_periodStart) === key(row))
                        return { ...row }
                }
                return null
            },
            create: async ({ data }: any) => {
                const k = key(data)
                for (const row of buckets.values()) {
                    if (key(row) === k) {
                        const err: any = new Error("unique")
                        err.code = "P2002"
                        throw err
                    }
                }
                const row = {
                    id: nextId++,
                    reservedUnits: 0,
                    consumedUnits: 0,
                    ...data,
                }
                buckets.set(k, row)
                return { ...row }
            },
            updateMany: async ({ where, data }: any) => {
                for (const row of buckets.values()) {
                    if (row.id !== where.id) continue
                    if (where.capacityUnits === null && row.capacityUnits !== null) continue
                    if (typeof where.reservedUnits === "number" && where.reservedUnits !== row.reservedUnits)
                        continue
                    if (typeof where.consumedUnits === "number" && where.consumedUnits !== row.consumedUnits)
                        continue
                    if (data.reservedUnits?.increment) row.reservedUnits += data.reservedUnits.increment
                    if (data.capacityUnits !== undefined) row.capacityUnits = data.capacityUnits
                    return { count: 1 }
                }
                return { count: 0 }
            },
        },
        $transaction: async (fn: (tx: any) => Promise<any>) => fn(client),
    }

    return {
        client,
        buckets,
        baseRows: () =>
            [...buckets.values()].filter((r) => r.source === "BASE").map((r) => ({ ...r })),
        promoRows: () =>
            [...buckets.values()].filter((r) => r.source === "PROMO").map((r) => ({ ...r })),
    }
}

let seq = 0
const reserve = (client: any, now: Date, plan = "PRO") =>
    reserveBucketQuota(client, {
        userId: USER,
        requestId: `r-${++seq}`,
        feature: "ANALYZE",
        units: 1,
        plan,
        timezone: "Asia/Tehran",
        now,
    } as any)

// ────────────────────────────────────────────────────────────────────────────
describe("لنگر کاربر", () => {
    it("FREE جدید ⇒ anchor از زمان signup می‌آید، نه از تقویم", async () => {
        const signup = new Date("2026-09-22T12:00:00.000Z")
        const env = makeClient({ freeAnchor: signup })

        const win = await resolveQuotaWindowFor(env.client, {
            userId: USER,
            now: new Date("2026-10-05T00:00:00.000Z"), // وسط ماه تقویمی
            timezone: "Asia/Tehran",
        })

        expect(win.anchorKind).toBe("FREE_ANCHOR")
        expect(win.anchor).toEqual(signup)
        expect(win.periodIndex).toBe(0)
        expect(win.periodStart).toEqual(signup)
    })

    it("FREE قدیمی (backfill‌شده) ⇒ همان لنگرِ backfill مبناست", async () => {
        const backfilled = new Date("2026-08-31T20:30:00.000Z")
        const env = makeClient({ freeAnchor: backfilled })

        const win = await resolveQuotaWindowFor(env.client, {
            userId: USER,
            now: new Date("2026-10-05T00:00:00.000Z"),
            timezone: "Asia/Tehran",
        })

        expect(win.anchor).toEqual(backfilled)
        // ۳۵ روز بعد ⇒ دورهٔ دوم
        expect(win.periodIndex).toBe(1)
        expect(win.periodStart.toISOString()).toBe("2026-09-30T20:30:00.000Z")
    })

    it("PRO فعال ⇒ anchor از شروع entitlement، نه از signup", async () => {
        const purchase = LAST_DAY
        const env = makeClient({
            freeAnchor: new Date("2026-01-01T00:00:00.000Z"),
            entitlement: {
                userId: USER,
                status: "ACTIVE",
                currentPeriodStart: purchase,
                currentPeriodEnd: new Date(purchase.getTime() + 90 * DAY),
            },
        })

        const win = await resolveQuotaWindowFor(env.client, {
            userId: USER,
            now: new Date("2026-10-05T00:00:00.000Z"),
            timezone: "Asia/Tehran",
        })

        expect(win.anchorKind).toBe("ENTITLEMENT")
        expect(win.anchor).toEqual(purchase)
        expect(win.periodIndex).toBe(0)
    })

    it("PRO منقضی ⇒ entitlement لنگر نمی‌شود (سقوط به لنگر FREE)", async () => {
        const env = makeClient({
            freeAnchor: new Date("2026-09-10T00:00:00.000Z"),
            entitlement: {
                userId: USER,
                status: "ACTIVE",
                currentPeriodStart: new Date(0), // sentinl ۱۹۷۰
                currentPeriodEnd: new Date(30 * DAY),
            },
        })

        const win = await resolveQuotaWindowFor(env.client, {
            userId: USER,
            now: new Date("2026-10-05T00:00:00.000Z"),
            timezone: "Asia/Tehran",
        })

        expect(win.anchorKind).toBe("FREE_ANCHOR")
        expect(win.anchor).toEqual(new Date("2026-09-10T00:00:00.000Z"))
        expect(win.periodStart.getTime()).toBeGreaterThan(0)
    })
})

// ────────────────────────────────────────────────────────────────────────────
describe("تعداد دوره برای هر مدت اشتراک", () => {
    const cases = [
        { days: 30, cycles: 1 },
        { days: 60, cycles: 2 },
        { days: 90, cycles: 3 },
    ]

    it.each(cases)("اشتراک $days روزه از آخرین روز ماه ⇒ $cycles دوره", async ({ days, cycles }) => {
        const env = makeClient({
            entitlement: {
                userId: USER,
                status: "ACTIVE",
                currentPeriodStart: LAST_DAY,
                currentPeriodEnd: new Date(LAST_DAY.getTime() + days * DAY),
            },
        })

        // کل بازهٔ اشتراک را روزبه‌روز «مصرف» می‌کنیم و تعداد دوره‌های ساخته‌شده را می‌شماریم.
        for (let d = 0; d < days; d++) {
            await reserve(env.client, new Date(LAST_DAY.getTime() + d * DAY))
        }

        const rows = env.baseRows()
        expect(rows).toHaveLength(cycles)
        // هر دوره دقیقاً لنگر + k×۳۰ روز است
        rows.forEach((row, index) => {
            expect(row.periodStart.getTime()).toBe(LAST_DAY.getTime() + index * 30 * DAY)
            expect(row.capacityUnits).toBe(270)
        })
    })

    it("مجموع سقف یک اشتراک ۹۰ روزه = ۸۱۰ تحلیل، حتی با عبور از دو مرز تقویمی", async () => {
        const env = makeClient({
            entitlement: {
                userId: USER,
                status: "ACTIVE",
                currentPeriodStart: LAST_DAY,
                currentPeriodEnd: new Date(LAST_DAY.getTime() + 90 * DAY),
            },
        })
        for (let d = 0; d < 90; d++) {
            await reserve(env.client, new Date(LAST_DAY.getTime() + d * DAY))
        }
        const total = env.baseRows().reduce((sum, r) => sum + (r.capacityUnits ?? 0), 0)
        expect(total).toBe(810)
    })
})

// ────────────────────────────────────────────────────────────────────────────
describe("تمدید", () => {
    function entDb(initial: Record<string, unknown>) {
        let row: Record<string, unknown> | null = initial
        return {
            entitlement: {
                findUnique: async () => row,
                create: async ({ data }: any) => {
                    row = { id: "e1", userId: USER, ...data }
                    return row
                },
                updateMany: async ({ data }: any) => {
                    if (row === null) return { count: 0 }
                    row = { ...row, ...data }
                    return { count: 1 }
                },
            },
            user: { updateMany: async () => ({ count: 1 }) },
            row: () => row,
        }
    }

    it("تمدید قبل از expiry ⇒ anchor قبلی حفظ و فقط end تمدید می‌شود", async () => {
        const purchase = LAST_DAY
        const db = entDb({
            id: "e1",
            userId: USER,
            provider: "ZARINPAL",
            status: "ACTIVE",
            planCode: "PRO",
            currentPeriodStart: purchase,
            currentPeriodEnd: new Date(purchase.getTime() + 30 * DAY),
        })
        const mid = new Date(purchase.getTime() + 20 * DAY)

        await renew(db as never, { userId: USER, provider: "ZARINPAL", entitlementDays: 30 }, mid)

        const after = db.row()!
        expect(new Date(after.currentPeriodStart as Date).getTime()).toBe(purchase.getTime())
        expect(new Date(after.currentPeriodEnd as Date).getTime()).toBe(
            purchase.getTime() + 60 * DAY,
        )
        // یعنی ۶۰ روز از همان لنگر ⇒ دو دورهٔ ۳۰روزه، نه سه.
        expect(
            quotaWindowFor({
                now: new Date(purchase.getTime() + 59 * DAY),
                entitlement: {
                    status: "ACTIVE",
                    currentPeriodStart: after.currentPeriodStart as Date,
                    currentPeriodEnd: after.currentPeriodEnd as Date,
                },
            }).periodIndex,
        ).toBe(1)
    })

    it("تمدید بعد از expiry ⇒ لنگر جدید از لحظهٔ خرید", async () => {
        const purchase = LAST_DAY
        const db = entDb({
            id: "e1",
            userId: USER,
            provider: "ZARINPAL",
            status: "EXPIRED",
            planCode: "PRO",
            currentPeriodStart: purchase,
            currentPeriodEnd: new Date(purchase.getTime() + 30 * DAY),
        })
        const later = new Date(purchase.getTime() + 45 * DAY)

        await renew(db as never, { userId: USER, provider: "ZARINPAL", entitlementDays: 90 }, later)

        const after = db.row()!
        expect(new Date(after.currentPeriodStart as Date).getTime()).toBe(later.getTime())
        expect(new Date(after.currentPeriodEnd as Date).getTime()).toBe(later.getTime() + 90 * DAY)
    })

    it("خرید اول ⇒ لنگر از زمان خرید و دورهٔ صفر", async () => {
        const db = entDb({} as Record<string, unknown>)
        ;(db.entitlement.findUnique as any) = async () => null

        const result = await activate(
            db as never,
            { userId: USER, provider: "ZARINPAL", entitlementDays: 60 },
            LAST_DAY,
        )

        expect(new Date(result.currentPeriodStart).getTime()).toBe(LAST_DAY.getTime())
        expect(
            quotaWindowFor({
                now: new Date(LAST_DAY.getTime() + 45 * DAY),
                entitlement: {
                    status: "ACTIVE",
                    currentPeriodStart: result.currentPeriodStart,
                    currentPeriodEnd: result.currentPeriodEnd,
                },
            }).periodIndex,
        ).toBe(1)
    })
})

// ────────────────────────────────────────────────────────────────────────────
describe("PROMO — فقط در cycle جاری، بدون carry-over", () => {
    it("بونوسِ دورهٔ قبلی در دورهٔ بعد دیده نمی‌شود", async () => {
        const env = makeClient({
            entitlement: {
                userId: USER,
                status: "ACTIVE",
                currentPeriodStart: LAST_DAY,
                currentPeriodEnd: new Date(LAST_DAY.getTime() + 90 * DAY),
            },
        })

        // شبیه‌سازی redeem در دورهٔ صفر: یک bucket PROMO همان periodStart
        const promoPeriod = LAST_DAY
        await env.client.aiQuotaBucket.create({
            data: {
                userId: USER,
                feature: "ANALYZE",
                source: "PROMO",
                periodType: "MONTHLY",
                periodStart: promoPeriod,
                grantedUnits: 3,
                capacityUnits: null,
            },
        })

        const inFirstCycle = await readQuotaBuckets(env.client, {
            userId: USER,
            plan: "PRO",
            timezone: "Asia/Tehran",
            now: new Date(LAST_DAY.getTime() + 10 * DAY),
        })
        expect(inFirstCycle.find((v) => v.source === "PROMO")!.capacity).toBe(3)

        // دورهٔ دوم (لنگر + ۳۰ روز) ⇒ هیچ اثری از بونوس دورهٔ قبل نیست
        const inSecondCycle = await readQuotaBuckets(env.client, {
            userId: USER,
            plan: "PRO",
            timezone: "Asia/Tehran",
            now: new Date(LAST_DAY.getTime() + 40 * DAY),
        })
        expect(inSecondCycle.find((v) => v.source === "PROMO")!.capacity).toBe(0)
        expect(env.promoRows()).toHaveLength(1)
    })
})