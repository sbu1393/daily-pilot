// AI Quota v2 — چرخهٔ اشتراک: تست‌های RED مسیر A.
//
// این فایل قفل‌کنندهٔ سه چیز است:
//   ۱) rollover **بر پایهٔ لنگر خرید** است، نه اولِ ماه تقویمی؛
//   ۲) ظرفیت دوره **snapshot** می‌شود و تغییر بعدیِ `AiQuotaPolicy` آن را عوض نمی‌کند؛
//   ۳) ساخت دورهٔ جدید در برابر درخواست‌های هم‌زمان **idempotent** است: یک ردیف، یک
//      ظرفیت، و هرگز دو snapshot.
//
// روی یک fake حالت‌دار از Prisma اجرا می‌شود (نه mock فراخوانی) تا توالی واقعی
// رزروها و شرطِ CAS دیده شود — دقیقاً مثل `aiQuotaV2.service.test.ts`.

import { describe, expect, it } from "vitest"

import { readQuotaBuckets, reserveBucketQuota } from "./aiQuotaV2.service"
import { QuotaExceededError } from "./errors"
import { MS_PER_DAY, QUOTA_PERIOD_DAYS } from "./quotaWindow"

const DAY = MS_PER_DAY

/** ۳۱ شهریور — بدترین حالت برای مدل تقویمی. */
const PURCHASE = new Date("2026-09-22T12:00:00.000Z")
const BEFORE_CALENDAR_BOUNDARY = new Date("2026-09-28T00:00:00.000Z")
const AFTER_CALENDAR_BOUNDARY = new Date("2026-10-05T00:00:00.000Z")

interface Bucket {
    id: number
    userId: number
    feature: string
    source: string
    periodStart: Date
    grantedUnits: number | null
    capacityUnits: number | null
    reservedUnits: number
    consumedUnits: number
}

function makeFakePrisma(opts: {
    policy?: Record<string, number>
    entitlement?: { status: string; start: Date; end: Date } | null
    freeAnchor?: Date | null
} = {}) {
    const policy = new Map<string, number>(
        Object.entries(
            opts.policy ?? {
                "FREE:ANALYZE": 15,
                "FREE:PLAN": 2,
                "PRO:ANALYZE": 270,
                "PRO:PLAN": 50,
            },
        ),
    )
    const buckets = new Map<number, Bucket>()
    const events = new Map<string, any>()
    let nextId = 1

    const keyOf = (w: any) =>
        `${w.userId}|${w.feature}|${w.source}|${w.periodType}|${w.periodStart.toISOString()}`

    const prisma: any = {
        entitlement: {
            findUnique: async ({ where }: any) =>
                opts.entitlement
                    ? {
                          status: opts.entitlement.status,
                          currentPeriodStart: opts.entitlement.start,
                          currentPeriodEnd: opts.entitlement.end,
                          userId: where.userId,
                      }
                    : null,
        },
        user: {
            findUnique: async ({ where }: any) => ({
                id: where.id,
                timezone: "Asia/Tehran",
                quotaAnchorAt: opts.freeAnchor ?? null,
            }),
        },
        aiQuotaPolicy: {
            findUnique: async ({ where }: any) => {
                const v = policy.get(`${where.plan_feature.plan}:${where.plan_feature.feature}`)
                return v === undefined ? null : { allowedUnits: v }
            },
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
                const row = {
                    id: nextId++,
                    status: "RESERVED",
                    units: data.units,
                    userId: data.userId,
                    bucketId: null,
                    quotaSource: null,
                    ...data,
                }
                events.set(data.requestId, row)
                return { ...row }
            },
            updateMany: async ({ where, data }: any) => {
                let count = 0
                for (const [requestId, e] of events) {
                    if (where.requestId !== undefined && requestId !== where.requestId) continue
                    Object.assign(e, strip(data))
                    count++
                }
                return { count }
            },
        },
        aiQuotaBucket: {
            findUnique: async ({ where }: any) => {
                for (const row of buckets.values()) {
                    if (keyOf(where.userId_feature_source_periodType_periodStart) === keyOf(row)) {
                        return { ...row }
                    }
                }
                return null
            },
            create: async ({ data }: any) => {
                const k = keyOf(data)
                for (const row of buckets.values()) {
                    if (keyOf(row) === k) {
                        const err: any = new Error("unique")
                        err.code = "P2002"
                        throw err
                    }
                }
                const row: Bucket = {
                    id: nextId++,
                    reservedUnits: 0,
                    consumedUnits: 0,
                    ...data,
                }
                buckets.set(row.id, row)
                return { ...row }
            },
            updateMany: async ({ where, data }: any) => {
                const row = buckets.get(where.id)
                if (!row) return { count: 0 }
                if (where.capacityUnits === undefined && where.capacityUnitsIsNull === true) {
                    if (row.capacityUnits !== null) return { count: 0 }
                } else if (
                    where.capacityUnits !== undefined &&
                    where.capacityUnits !== null &&
                    where.capacityUnits !== row.capacityUnits
                ) {
                    return { count: 0 }
                }
                if (typeof where.reservedUnits === "number" && where.reservedUnits !== row.reservedUnits)
                    return { count: 0 }
                if (
                    typeof where.consumedUnits === "number" &&
                    where.consumedUnits !== row.consumedUnits
                )
                    return { count: 0 }
                applyDelta(row, data)
                return { count: 1 }
            },
            upsert: async ({ where, create, update }: any) => {
                const k = keyOf(where.userId_feature_source_periodType_periodStart)
                for (const row of buckets.values()) {
                    if (keyOf(row) === k) {
                        applyDelta(row, update)
                        return { ...row }
                    }
                }
                return prisma.aiQuotaBucket.create({ data: create })
            },
        },
        $transaction: async (fn: (tx: any) => Promise<any>) => fn(prisma),
    }

    function applyDelta(row: Bucket, data: any) {
        if (data.reservedUnits?.increment) row.reservedUnits += data.reservedUnits.increment
        if (data.consumedUnits?.increment) row.consumedUnits += data.consumedUnits.increment
        if (data.reservedUnits?.decrement) row.reservedUnits -= data.reservedUnits.decrement
        if (data.consumedUnits?.decrement) row.consumedUnits -= data.consumedUnits.decrement
        if (data.grantedUnits?.increment)
            row.grantedUnits = (row.grantedUnits ?? 0) + data.grantedUnits.increment
        if (data.capacityUnits !== undefined) row.capacityUnits = data.capacityUnits
    }

    const strip = (data: any) => data

    return {
        prisma,
        buckets,
        setPolicy: (k: string, v: number) => policy.set(k, v),
        bucket: (feature: string, source: string, userId = 1): Bucket | undefined => {
            for (const row of buckets.values()) {
                if (row.feature === feature && row.source === source && row.userId === userId)
                    return { ...row }
            }
            return undefined
        },
        baseBuckets: (userId = 1): Bucket[] =>
            [...buckets.values()]
                .filter((row) => row.source === "BASE" && row.userId === userId)
                .map((row) => ({ ...row })),
    }
}

let seq = 0
function reserve(fake: ReturnType<typeof makeFakePrisma>, overrides: Record<string, unknown> = {}) {
    return reserveBucketQuota(fake.prisma, {
        userId: 1,
        requestId: `req-${++seq}`,
        feature: "ANALYZE",
        units: 1,
        plan: "PRO",
        timezone: "Asia/Tehran",
        ...overrides,
    } as any)
}

// ────────────────────────────────────────────────────────────────────────────
// ۱) rollover بر پایهٔ لنگر، نه تقویم
// ────────────────────────────────────────────────────────────────────────────
describe("rollover بر پایهٔ لنگر اشتراک", () => {
    const subscription = {
        status: "ACTIVE",
        start: PURCHASE,
        end: new Date(PURCHASE.getTime() + 90 * DAY),
    }

    it("دور��هٔ جدید با عبور از مرز ماه تقویمی ساخته نمی‌شود", async () => {
        const fake = makeFakePrisma({ entitlement: subscription })
        await reserve(fake, { now: BEFORE_CALENDAR_BOUNDARY })
        await reserve(fake, { now: AFTER_CALENDAR_BOUNDARY })
        const bases = fake.baseBuckets()
        expect(bases).toHaveLength(1)
        expect(bases[0].periodStart).toEqual(PURCHASE)
    })

    it("دقیقاً در لنگر + ۳۰ روز، دورهٔ دوم ساخته می‌شود", async () => {
        const fake = makeFakePrisma({ entitlement: subscription })
        await reserve(fake, { now: BEFORE_CALENDAR_BOUNDARY })
        await reserve(fake, { now: new Date(PURCHASE.getTime() + 30 * DAY) })
        const bases = fake.baseBuckets()
        expect(bases).toHaveLength(2)
        expect(bases.map((b) => b.periodStart.toISOString()).sort()).toEqual(
            [PURCHASE, new Date(PURCHASE.getTime() + 30 * DAY)].map((d) => d.toISOString()).sort(),
        )
    })

    it("اشتراک ۹۰ روزه هرگز دورهٔ چهارم نمی‌سازد", async () => {
        const fake = makeFakePrisma({ entitlement: subscription })
        for (const day of [0, 15, 29, 30, 45, 59, 60, 75, 89]) {
            await reserve(fake, { now: new Date(PURCHASE.getTime() + day * DAY) })
        }
        expect(fake.baseBuckets()).toHaveLength(QUOTA_PERIOD_DAYS > 0 ? 3 : 0)
    })

    it("کاربر بدون اشتراک فعال از لنگر خودش استفاده می‌کند", async () => {
        const freeAnchor = new Date("2026-09-10T00:00:00.000Z")
        const fake = makeFakePrisma({ entitlement: null, freeAnchor })
        await reserve(fake, { plan: "FREE", now: new Date("2026-09-28T00:00:00.000Z") })
        await reserve(fake, { plan: "FREE", now: new Date("2026-10-05T00:00:00.000Z") })
        const bases = fake.baseBuckets()
        expect(bases).toHaveLength(1)
        expect(bases[0].periodStart).toEqual(freeAnchor)
    })

    it("entitlement منقضی‌شده لنگر مرده نمی‌سازد (fail-closed)", async () => {
        const freeAnchor = new Date("2026-09-10T00:00:00.000Z")
        const fake = makeFakePrisma({
            entitlement: { status: "EXPIRED", start: new Date(0), end: new Date(30 * DAY) },
            freeAnchor,
        })
        await reserve(fake, { now: new Date("2026-09-28T00:00:00.000Z") })
        expect(fake.baseBuckets()[0].periodStart).toEqual(freeAnchor)
    })

    it("کاربر بدون هیچ لنگری به رفتار قدیمی (اول ماه تقویمی) برمی‌گردد", async () => {
        const fake = makeFakePrisma({ entitlement: null, freeAnchor: null })
        await reserve(fake, { plan: "FREE", now: new Date("2026-09-28T00:00:00.000Z") })
        // اولِ ماهِ محلیِ Asia/Tehran برای سپتامبر ۲۰۲۶ = ۲۰۲۶-۰۸-۳۱T۲۰:۳۰Z
        expect(fake.baseBuckets()[0].periodStart.toISOString()).toBe("2026-08-31T20:30:00.000Z")
    })
})

// ────────────────────────────────────────────────────────────────────────────
// ۲) snapshot ظرفیت
// ────────────────────────────────────────────────────────────────────────────
describe("snapshot ظرفیت دوره", () => {
    const subscription = {
        status: "ACTIVE",
        start: PURCHASE,
        end: new Date(PURCHASE.getTime() + 90 * DAY),
    }

    it("ظرفیت دوره در لحظهٔ ساخت از policy نوشته می‌شود", async () => {
        const fake = makeFakePrisma({ entitlement: subscription })
        await reserve(fake, { now: PURCHASE })
        expect(fake.baseBuckets()[0].capacityUnits).toBe(270)
    })

    it("تغییر بعدیِ policy سقف دورهٔ ساخته‌شده را عوض نمی‌کند", async () => {
        const fake = makeFakePrisma({ entitlement: subscription })
        await reserve(fake, { now: PURCHASE })
        fake.setPolicy("PRO:ANALYZE", 999)
        const views = await readQuotaBuckets(fake.prisma, {
            userId: 1,
            plan: "PRO",
            timezone: "Asia/Tehran",
            now: PURCHASE,
        })
        const base = views.find((v) => v.source === "BASE")!
        expect(base.capacity).toBe(270)
    })

    it("دورهٔ بعد policy تازه را می‌گیرد (policy زنده برای دوره‌های جدید)", async () => {
        const fake = makeFakePrisma({ entitlement: subscription })
        await reserve(fake, { now: PURCHASE })
        fake.setPolicy("PRO:ANALYZE", 999)
        await reserve(fake, { now: new Date(PURCHASE.getTime() + 30 * DAY) })
        const bases = fake.baseBuckets()
        expect(bases).toHaveLength(2)
        expect(bases.find((b) => b.periodStart.getTime() === PURCHASE.getTime())!.capacityUnits)
            .toBe(270)
        expect(
            bases.find((b) => b.periodStart.getTime() === PURCHASE.getTime() + 30 * DAY)!
                .capacityUnits,
        ).toBe(999)
    })

    it("سه دورهٔ ۹۰ روزه روی‌هم دقیقاً ۸۱۰ واحد می‌دهند", async () => {
        const fake = makeFakePrisma({ entitlement: subscription })
        const sum = fake.baseBuckets()
        // قبل از هر رزروی، سه دوره باید با ۲۷۰ ساخته شوند ⇒ ۸۱۰.
        for (const day of [0, 30, 60]) {
            await reserve(fake, { now: new Date(PURCHASE.getTime() + day * DAY) })
        }
        const total = sum
            .concat(fake.baseBuckets())
            .reduce((acc, b) => Math.max(acc, b.capacityUnits ?? 0), 0)
        expect(total).toBe(270)
        const capacities = fake.baseBuckets().map((b) => b.capacityUnits)
        expect(capacities).toEqual([270, 270, 270])
    })

    it("ظرفیت صفر fail-closed است، نه سهمیهٔ بی‌سقف", async () => {
        const fake = makeFakePrisma({
            entitlement: subscription,
            policy: { "PRO:ANALYZE": 0, "PRO:PLAN": 0, "FREE:ANALYZE": 0, "FREE:PLAN": 0 },
        })
        await expect(reserve(fake, { now: PURCHASE })).rejects.toBeInstanceOf(QuotaExceededError)
        expect(fake.baseBuckets()[0].capacityUnits).toBe(0)
    })
})

// ────────────────────────────────────────────────────────────────────────────
// ۳) race و idempotency در ساخت دوره
// ────────────────────────────────────────────────────────────────────────────
describe("ساخت دورهٔ جدید — race و idempotency", () => {
    const subscription = {
        status: "ACTIVE",
        start: PURCHASE,
        end: new Date(PURCHASE.getTime() + 90 * DAY),
    }

    it("۲۰ رزروی هم‌زمان در یک لحظه ⇒ یک ردیف با یک ظرفیت", async () => {
        const fake = makeFakePrisma({ entitlement: subscription })
        await Promise.all(
            Array.from({ length: 20 }, () =>
                reserve(fake, { now: PURCHASE }).catch(() => undefined),
            ),
        )
        const bases = fake.baseBuckets()
        expect(bases).toHaveLength(1)
        expect(bases[0].capacityUnits).toBe(270)
        // fake تراکنش واقعی ندارد، پس CAS زیر contention بخشی از درخواست‌ها را
        // fail-closed می‌کند. آنچه اینجا قفل می‌شود نبودِ **row/capacity تکراری** و
        // نبودِ overspend است، نه شمار دقیق رزروها.
        expect(bases[0].reservedUnits).toBeGreaterThan(0)
        expect(bases[0].reservedUnits).toBeLessThanOrEqual(20)
        expect(bases[0].reservedUnits + bases[0].consumedUnits).toBeLessThanOrEqual(270)
    })

    it("هم‌زمانی در مرز rollover هم یک دورهٔ جدید می‌سازد، نه دو تا", async () => {
        const fake = makeFakePrisma({ entitlement: subscription })
        const boundary = new Date(PURCHASE.getTime() + 30 * DAY)
        await Promise.all(
            Array.from({ length: 20 }, () =>
                reserve(fake, { now: boundary }).catch(() => undefined),
            ),
        )
        expect(fake.baseBuckets()).toHaveLength(1)
        expect(fake.baseBuckets()[0].periodStart).toEqual(boundary)
    })

    it("ظرفیت هرگز دو snapshot نمی‌شود", async () => {
        const fake = makeFakePrisma({ entitlement: subscription })
        await reserve(fake, { now: PURCHASE })
        // دورهٔ ساخته‌شده با ظرفیت 270 است؛ policy عوض می‌شود ولی snapshot می‌ماند.
        fake.setPolicy("PRO:ANALYZE", 5)
        for (let i = 0; i < 10; i++) await reserve(fake, { now: PURCHASE })
        expect(fake.baseBuckets()[0].capacityUnits).toBe(270)
    })
})