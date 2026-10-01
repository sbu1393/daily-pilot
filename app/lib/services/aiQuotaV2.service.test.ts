// AI Quota v2 — تست‌های ledger جدید (bucket-based)
//
// این تست‌ها روی یک **fake حالت‌دار** از Prisma اجرا می‌شوند، نه mockهای فراخوانی.
// دلیل: قاعده‌ای که باید قفل شود «ترتیب مصرف» است — یعنی *توالی* چند رزرو پشت
// سر هم. با mock فراخوانی فقط می‌شد ثابت کرد «در فلان بار، فلان چیز صدا زده شد»؛
// با fake واقعاً دیده می‌شود که بعد از ۷ واحد، Promo مصرف‌شده ۷ و Base صفر است.
//
// fake دقیقاً CAS را شبیه‌سازی می‌کند: updateMany وقتی count=1 می‌دهد که مقادیر
// `where` دقیقاً با وضعیت فعلی ردیف یکی باشند. برای همین «تغییر هم‌زمان» و
// «دور بعد با مقادیر تازه» واقعاً تست می‌شوند، نه شبیه‌سازی‌شده.

import { describe, expect, it } from "vitest"

import {
    completeBucketQuota,
    readQuotaBuckets,
    releaseBucketQuota,
    reserveBucketQuota,
} from "./aiQuotaV2.service"
import { QuotaExceededError, QuotaUnavailableError } from "./errors"

const NOW = new Date("2026-09-15T12:00:00.000Z")
const PERIOD = new Date("2026-09-01T00:00:00.000Z")

interface Bucket {
    id: number
    userId: number
    feature: string
    source: string
    periodStart: Date
    grantedUnits: number | null
    reservedUnits: number
    consumedUnits: number
}

function makeFakePrisma(opts: { policy?: Record<string, number> } = {}) {
    const policy = new Map<string, number>(
        Object.entries(opts.policy ?? {
            "FREE:ANALYZE": 15,
            "FREE:PLAN": 2,
            "PRO:ANALYZE": 270,
            "PRO:PLAN": 50,
        }),
    )
    const buckets = new Map<number, Bucket>()
    const events = new Map<string, any>()
    let nextId = 1

    const keyOf = (w: any) =>
        `${w.userId}|${w.feature}|${w.source}|${w.periodType}|${w.periodStart.toISOString()}`

    const prisma: any = {
        aiQuotaPolicy: {
            findUnique: async ({ where }: any) => {
                const v = policy.get(`${where.plan_feature.plan}:${where.plan_feature.feature}`)
                return v === undefined ? null : { allowedUnits: v }
            },
        },
        aiUsageEvent: {
            findUnique: async ({ where }: any) => {
                const e = events.get(where.requestId)
                if (!e) return null
                return e.__full ? { ...e } : { status: e.status }
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
                    __full: true,
                }
                events.set(data.requestId, row)
                return { ...row }
            },
            updateMany: async ({ where, data }: any) => {
                let count = 0
                for (const [requestId, e] of events) {
                    if (where.requestId !== undefined && requestId !== where.requestId) continue
                    if (where.status !== undefined && e.status !== where.status) continue
                    Object.assign(e, stripInternal(data))
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
                for (const row of buckets.values()) if (keyOf(row) === k) {
                    const err: any = new Error("unique")
                    err.code = "P2002"
                    throw err
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
                // CAS با مقدار عددی: شرط باید دقیقاً با وضعیت فعلی بخواند
                if (
                    typeof where.reservedUnits === "number" &&
                    where.reservedUnits !== row.reservedUnits
                ) {
                    return { count: 0 }
                }
                if (
                    typeof where.consumedUnits === "number" &&
                    where.consumedUnits !== row.consumedUnits
                ) {
                    return { count: 0 }
                }
                // guard بازه‌ای (مثل reservedUnits >= delta در complete/release)
                if (where.reservedUnits?.gte !== undefined && row.reservedUnits < where.reservedUnits.gte)
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
        if (data.grantedUnits?.increment) row.grantedUnits = (row.grantedUnits ?? 0) + data.grantedUnits.increment
    }

    const stripInternal = (data: any) => {
        const { __full, ...rest } = data
        void __full
        return rest
    }

    return {
        prisma,
        buckets,
        events,
        setPolicy: (k: string, v: number) => policy.set(k, v),
        bucket: (feature: string, source: string, userId = 1): Bucket | undefined => {
            for (const row of buckets.values()) {
                if (row.feature === feature && row.source === source && row.userId === userId) return { ...row }
            }
            return undefined
        },
    }
}

function reserve(fake: ReturnType<typeof makeFakePrisma>, overrides: Record<string, unknown> = {}) {
    return reserveBucketQuota(fake.prisma, {
        userId: 1,
        requestId: `req-${Math.random().toString(36).slice(2)}`,
        feature: "ANALYZE",
        units: 1,
        plan: "FREE",
        timezone: "UTC",
        now: NOW,
        ...overrides,
    } as any)
}

/* ──────────────────────────────────────────────────────────────────────────── */

describe("مقادیر نهایی محصول — سقف زنده از policy", () => {
    it("FREE/ANALYZE اجازهٔ ۱۵ رزرو می‌دهد و ۱۶امی را رد می‌کند", async () => {
        const fake = makeFakePrisma()
        for (let i = 0; i < 15; i++) {
            await expect(reserve(fake, { requestId: `a-${i}` })).resolves.toMatchObject({
                policyAllowedUnits: 15,
                quotaSource: "BASE",
            })
        }
        await expect(reserve(fake, { requestId: "a-15" })).rejects.toBeInstanceOf(QuotaExceededError)
    })

    it("FREE/PLAN فقط ۲ واحد دارد", async () => {
        const fake = makeFakePrisma()
        await reserve(fake, { requestId: "p-1", feature: "PLAN" })
        await reserve(fake, { requestId: "p-2", feature: "PLAN" })
        await expect(reserve(fake, { requestId: "p-3", feature: "PLAN" })).rejects.toBeInstanceOf(
            QuotaExceededError,
        )
    })

    it("PLAN تمام‌شده، ANALYZE را تحت تأثیر قرار نمی‌دهد", async () => {
        const fake = makeFakePrisma()
        await reserve(fake, { requestId: "p-1", feature: "PLAN" })
        await reserve(fake, { requestId: "p-2", feature: "PLAN" })
        await expect(reserve(fake, { requestId: "p-3", feature: "PLAN" })).rejects.toBeInstanceOf(
            QuotaExceededError,
        )
        // ۱۵ رزرو ANALYZE باید کاملاً موفق باشد
        for (let i = 0; i < 15; i++) {
            await expect(reserve(fake, { requestId: `a-${i}` })).resolves.toBeTruthy()
        }
    })

    it("ANALYZE تمام‌شده، PLAN را تحت تأثیر قرار نمی‌دهد", async () => {
        const fake = makeFakePrisma()
        for (let i = 0; i < 15; i++) await reserve(fake, { requestId: `a-${i}` })
        await expect(reserve(fake, { requestId: "a-15" })).rejects.toBeInstanceOf(QuotaExceededError)
        await expect(reserve(fake, { requestId: "p-1", feature: "PLAN" })).resolves.toBeTruthy()
    })

    it("PRO/PLAN سقف ۵۰ دارد", async () => {
        const fake = makeFakePrisma()
        for (let i = 0; i < 50; i++) {
            await expect(reserve(fake, { requestId: `q-${i}`, feature: "PLAN", plan: "PRO" })).resolves.toMatchObject({
                policyAllowedUnits: 50,
            })
        }
        await expect(
            reserve(fake, { requestId: "q-50", feature: "PLAN", plan: "PRO" }),
        ).rejects.toBeInstanceOf(QuotaExceededError)
    })
})

/* ──────────────────────────────────────────────────────────────────────────── */

describe("ترتیب مصرف PROMO → BASE (تصمیم D2)", () => {
    it("Base=5 و Promo=10 ⇒ بعد از ۷ مصرف، Promo=7 و Base=0", async () => {
        const fake = makeFakePrisma()
        // یک کاربر که ۱۰ واحد PROMO دارد
        await fake.prisma.aiQuotaBucket.create({
            data: {
                userId: 1,
                feature: "ANALYZE",
                source: "PROMO",
                periodType: "MONTHLY",
                periodStart: PERIOD,
                grantedUnits: 10,
            },
        })

        for (let i = 0; i < 7; i++) {
            const res = await reserve(fake, { requestId: `r-${i}` })
            expect(res.quotaSource).toBe("PROMO")
            await completeBucketQuota(fake.prisma, `r-${i}`, { periodStart: PERIOD })
        }

        expect(fake.bucket("ANALYZE", "PROMO")).toMatchObject({
            grantedUnits: 10,
            reservedUnits: 0,
            consumedUnits: 7,
        })
        expect(fake.bucket("ANALYZE", "BASE")?.consumedUnits ?? 0).toBe(0)
    })

    it("بعد از تمام‌شدن PROMO، مصرف به BASE می‌رود", async () => {
        const fake = makeFakePrisma()
        await fake.prisma.aiQuotaBucket.create({
            data: {
                userId: 1,
                feature: "ANALYZE",
                source: "PROMO",
                periodType: "MONTHLY",
                periodStart: PERIOD,
                grantedUnits: 2,
            },
        })

        // هر دو واحد PROMO مصرف می‌شوند ⇒ ظرفیت پرومو خالی است
        await reserve(fake, { requestId: "m-1" })
        await completeBucketQuota(fake.prisma, "m-1", { periodStart: PERIOD })
        await reserve(fake, { requestId: "m-2" })
        await completeBucketQuota(fake.prisma, "m-2", { periodStart: PERIOD })
        expect(fake.bucket("ANALYZE", "PROMO")).toMatchObject({ grantedUnits: 2, consumedUnits: 2 })

        const third = await reserve(fake, { requestId: "m-3" })
        expect(third.quotaSource).toBe("BASE")
    })

    it("bucket پروموی وجودناشته ⇒ ظرفیت صفر، مصرف مستقیم از BASE", async () => {
        const fake = makeFakePrisma()
        const res = await reserve(fake, { requestId: "z-1" })
        expect(res.quotaSource).toBe("BASE")
        expect(fake.bucket("ANALYZE", "PROMO")).toBeUndefined()
    })

    it("PROMO جزئی کافی نیست ⇒ کلِ رزرو از BASE، بدون split (M1)", async () => {
        const fake = makeFakePrisma()
        await fake.prisma.aiQuotaBucket.create({
            data: {
                userId: 1,
                feature: "ANALYZE",
                source: "PROMO",
                periodType: "MONTHLY",
                periodStart: PERIOD,
                grantedUnits: 1,
            },
        })
        // PROMO=1 و units=2 ⇒ از PROMO **به‌تنهایی** جا نمی‌شود، پس کل رزرو از BASE
        // می‌رود. `multiUnit: true` لازم است، وگرنه گارد M2 قبل از هر چیز رد می‌کند.
        await expect(
            reserve(fake, { requestId: "b-1", units: 2, multiUnit: true, plan: "FREE" }),
        ).resolves.toMatchObject({
            quotaSource: "BASE",
        })
        // PROMO دست‌نخورده ماند: نه کم شد، نه رزرو شد
        expect(fake.bucket("ANALYZE", "PROMO")!.reservedUnits).toBe(0)
        expect(fake.bucket("ANALYZE", "BASE")!.reservedUnits).toBe(2)
    })
})

/* ──────────────────────────────────────────────────────────────────────────── */

describe("idempotency و all-or-nothing", () => {
    it("requestId تکراری ⇒ IdempotencyConflictError", async () => {
        const fake = makeFakePrisma()
        await reserve(fake, { requestId: "dup" })
        await expect(reserve(fake, { requestId: "dup" })).rejects.toMatchObject({
            code: "IDEMPOTENCY_CONFLICT",
        })
    })

    it("exceed شمارندهٔ bucket را دست نمی‌زند (rollback)", async () => {
        const fake = makeFakePrisma({ policy: { "FREE:ANALYZE": 1, "FREE:PLAN": 2, "PRO:ANALYZE": 1, "PRO:PLAN": 1 } })
        await reserve(fake, { requestId: "x-1" })
        await expect(reserve(fake, { requestId: "x-2" })).rejects.toBeInstanceOf(QuotaExceededError)
        expect(fake.bucket("ANALYZE", "BASE")).toMatchObject({ reservedUnits: 1, consumedUnits: 0 })
    })
})

/* ──────────────────────────────────────────────────────────────────────────── */

describe("complete / release روی همان bucket", () => {
    it("complete رزرو را به مصرف تبدیل می‌کند", async () => {
        const fake = makeFakePrisma()
        await reserve(fake, { requestId: "c-1" })
        expect(fake.bucket("ANALYZE", "BASE")).toMatchObject({ reservedUnits: 1, consumedUnits: 0 })

        await expect(completeBucketQuota(fake.prisma, "c-1", { periodStart: PERIOD })).resolves.toBe(true)
        expect(fake.bucket("ANALYZE", "BASE")).toMatchObject({ reservedUnits: 0, consumedUnits: 1 })
    })

    it("release رزرو را برمی‌گرداند و مصرف نمی‌کند", async () => {
        const fake = makeFakePrisma()
        await reserve(fake, { requestId: "c-2" })
        await expect(releaseBucketQuota(fake.prisma, "c-2", { periodStart: PERIOD })).resolves.toBe(true)
        expect(fake.bucket("ANALYZE", "BASE")).toMatchObject({ reservedUnits: 0, consumedUnits: 0 })
    })

    it("release دوباره no-op است (idempotent)", async () => {
        const fake = makeFakePrisma()
        await reserve(fake, { requestId: "c-3" })
        await releaseBucketQuota(fake.prisma, "c-3", { periodStart: PERIOD })
        await expect(releaseBucketQuota(fake.prisma, "c-3", { periodStart: PERIOD })).resolves.toBe(false)
    })

    it("complete بعد از release ⇒ conflict", async () => {
        const fake = makeFakePrisma()
        await reserve(fake, { requestId: "c-4" })
        await releaseBucketQuota(fake.prisma, "c-4", { periodStart: PERIOD })
        await expect(completeBucketQuota(fake.prisma, "c-4", { periodStart: PERIOD })).rejects.toMatchObject({
            code: "AI_USAGE_CONFLICT",
        })
    })

    it("periodStart اجباری است", async () => {
        const fake = makeFakePrisma()
        await reserve(fake, { requestId: "c-5" })
        await expect(
            completeBucketQuota(fake.prisma, "c-5", undefined as unknown as { periodStart: Date }),
        ).rejects.toBeInstanceOf(QuotaUnavailableError)
    })
})

/* ──────────────────────────────────────────────────────────────────────────── */

/**
 * از مسیر A، ظرفیت هر دوره **snapshot** می‌شود: تغییرِ بعدیِ `AiQuotaPolicy` نباید
 * سقفِ دوره‌ای را که کاربر در حالش مصرف می‌کند عوض کند (وگرنه تضمین محصول
 * «۹۰ روزه = ۸۱۰ تحلیل» می‌شکست). اثرِ تغییر policy از **دورهٔ بعد** شروع می‌شود.
 */
describe("تغییر policy توسط ادمین وسط دوره", () => {
    it("پایین آوردن سقف crash نمی‌کند و شمارنده‌ها سالم می‌مانند", async () => {
        const fake = makeFakePrisma()
        for (let i = 0; i < 10; i++) {
            await reserve(fake, { requestId: `s-${i}` })
            await completeBucketQuota(fake.prisma, `s-${i}`, { periodStart: PERIOD })
        }
        expect(fake.bucket("ANALYZE", "BASE")).toMatchObject({ consumedUnits: 10 })

        // ادمین سقف را از ۱۵ به ۵ می‌آورد
        fake.setPolicy("FREE:ANALYZE", 5)

        // نه crash، نه دادهٔ از‌دست‌رفته — و سقفِ همین دوره همان snapshot اولیه می‌ماند.
        const views = await readQuotaBuckets(fake.prisma, {
            userId: 1,
            plan: "FREE",
            timezone: "UTC",
            now: NOW,
        })
        const base = views.find((v) => v.feature === "ANALYZE" && v.source === "BASE")!
        expect(base.capacity).toBe(15)
        expect(base.consumed).toBe(10)
        expect(base.remaining).toBe(5)

        // رزروهای باقی‌ماندهٔ همین دوره مجازند (ظرفیت snapshot هنوز ۱۵ است).
        await expect(reserve(fake, { requestId: "s-after" })).resolves.toBeTruthy()
    })

    it("بالا بردن سقف روی دورهٔ در جریان اثر نمی‌کند، ولی از دورهٔ بعد اثر می‌کند", async () => {
        const fake = makeFakePrisma({ policy: { "FREE:ANALYZE": 1, "FREE:PLAN": 2, "PRO:ANALYZE": 1, "PRO:PLAN": 1 } })
        await reserve(fake, { requestId: "u-1" })
        await expect(reserve(fake, { requestId: "u-2" })).rejects.toBeInstanceOf(QuotaExceededError)

        fake.setPolicy("FREE:ANALYZE", 5)
        // دورهٔ جاری قفل است…
        await expect(reserve(fake, { requestId: "u-3" })).rejects.toBeInstanceOf(QuotaExceededError)

        // …ولی در دورهٔ بعد، سقف تازه snapshot می‌شود.
        const nextPeriod = new Date(PERIOD.getTime() + 30 * 24 * 60 * 60 * 1000)
        await expect(
            reserveBucketQuota(fake.prisma, {
                userId: 1,
                requestId: "u-4",
                feature: "ANALYZE",
                units: 1,
                plan: "FREE",
                timezone: "UTC",
                now: new Date(nextPeriod.getTime() + 60 * 1000),
            } as any),
        ).resolves.toBeTruthy()
    })
})

/* ──────────────────────────────────────────────────────────────────────────── */

describe("audit (تصمیم D5/D6)", () => {
    it("policyAllowedUnits در لحظهٔ رزرو snapshot می‌شود", async () => {
        const fake = makeFakePrisma()
        await reserve(fake, { requestId: "d-1" })

        const event: any = fake.events.get("d-1")
        expect(event.policyAllowedUnits).toBe(15)
        expect(event.quotaSource).toBe("BASE")
        expect(event.bucketId).toBe(fake.bucket("ANALYZE", "BASE")?.id)

        // تغییر بعدیِ policy رکورد قبلی را تغییر نمی‌دهد
        fake.setPolicy("FREE:ANALYZE", 5)
        expect(fake.events.get("d-1").policyAllowedUnits).toBe(15)
    })

    it("quotaSource و bucketId با هم ثبت می‌شوند (با CHECK دیتابیس سازگار)", async () => {
        const fake = makeFakePrisma()
        await reserve(fake, { requestId: "d-2" })
        const event: any = fake.events.get("d-2")
        const hasSource = event.quotaSource !== null
        const hasBucket = event.bucketId !== null
        expect(hasSource).toBe(hasBucket)
    })

    it("منبع PROMO در audit ثبت می‌شود", async () => {
        const fake = makeFakePrisma()
        await fake.prisma.aiQuotaBucket.create({
            data: {
                userId: 1,
                feature: "ANALYZE",
                source: "PROMO",
                periodType: "MONTHLY",
                periodStart: PERIOD,
                grantedUnits: 3,
            },
        })
        await reserve(fake, { requestId: "d-3" })
        expect(fake.events.get("d-3").quotaSource).toBe("PROMO")
    })
})

/* ────────────────────────────────────────────────────────────────────────── */
/* M1 + M2 — invariantهای رزرو                                                 */
/* ────────────────────────────────────────────────────────────────────────── */

describe("M1 — یک reservation هرگز بین PROMO و BASE split نمی‌شود", () => {
    it("ظرفیت PROMO کافی ⇒ فقط PROMO دست می‌خورد، BASE دست‌نخورده", async () => {
        const fake = makeFakePrisma()
        // ۲۰ واحد بونوس ANALYZE
        fake.prisma.aiQuotaBucket.create({
            data: {
                userId: 1,
                feature: "ANALYZE",
                source: "PROMO",
                periodType: "MONTHLY",
                periodStart: PERIOD,
                grantedUnits: 20,
            },
        })
        await fake.prisma.aiQuotaBucket.create({
            data: {
                userId: 1,
                feature: "ANALYZE",
                source: "BASE",
                periodType: "MONTHLY",
                periodStart: PERIOD,
                grantedUnits: null,
            },
        })

        const res = await reserve(fake)

        expect(res.quotaSource).toBe("PROMO")
        expect(fake.bucket("ANALYZE", "PROMO")!.reservedUnits).toBe(1)
        expect(fake.bucket("ANALYZE", "BASE")!.reservedUnits).toBe(0)
    })

    it("PROMO ناکافی ⇒ کل رزرو می‌رود BASE، بدون برداشتن جزئی از PROMO", async () => {
        const fake = makeFakePrisma()
        // بونوس PROMO تمام‌شده (ظرفیت صفر) ⇒ ظرفیت مؤثرش صفر است
        fake.prisma.aiQuotaBucket.create({
            data: {
                userId: 1,
                feature: "ANALYZE",
                source: "PROMO",
                periodType: "MONTHLY",
                periodStart: PERIOD,
                grantedUnits: 0,
            },
        })

        const res = await reserve(fake)

        expect(res.quotaSource).toBe("BASE")
        // نکتهٔ اصلی M1: PROMO نه کم شد، نه رزرو شد — یا کل، یا هیچ
        expect(fake.bucket("ANALYZE", "PROMO")!.reservedUnits).toBe(0)
        expect(fake.bucket("ANALYZE", "PROMO")!.consumedUnits).toBe(0)
        expect(fake.bucket("ANALYZE", "BASE")!.reservedUnits).toBe(1)
    })

    it("رویداد audit دقیقاً یک bucketId دارد (ساختار split را ناممکن می‌کند)", async () => {
        const fake = makeFakePrisma()
        fake.prisma.aiQuotaBucket.create({
            data: {
                userId: 1,
                feature: "ANALYZE",
                source: "PROMO",
                periodType: "MONTHLY",
                periodStart: PERIOD,
                grantedUnits: 1,
            },
        })

        const res = await reserve(fake, { requestId: "split-check" })
        const event = fake.events.get("split-check")

        expect(event.bucketId).toBe(res.bucketId)
        expect(event.quotaSource).toBe(res.quotaSource)
        // یک ستون، یک مقدار ⇒ هرگز «نیمی از این، نیمی از آن»
        expect(typeof event.bucketId).toBe("number")
    })
})

describe("M2 — units > 1 فقط با اعلام صریح multiUnit", () => {
    it("units = 2 بدون multiUnit ⇒ fail-fast پیش از هر نوشتنی", async () => {
        const fake = makeFakePrisma()

        await expect(reserve(fake, { units: 2 })).rejects.toMatchObject({
            code: "AI_FEATURE_NOT_MULTI_UNIT",
            status: 400,
        })

        // مهم‌تر از خود خطا: هیچ ردیفی ساخته نشده (fail-fast واقعی)
        expect(fake.buckets.size).toBe(0)
        expect(fake.events.size).toBe(0)
    })

    it("units = 500 هم رد می‌شود (سقف بالا هم مصون نیست)", async () => {
        const fake = makeFakePrisma()
        await expect(reserve(fake, { units: 500 })).rejects.toMatchObject({
            code: "AI_FEATURE_NOT_MULTI_UNIT",
        })
        expect(fake.buckets.size).toBe(0)
    })

    it("خطای M2 یک باگ برنامه‌نویسی است (۴۰۰)، نه خرابی زیرساخت (۵۰۳)", async () => {
        const fake = makeFakePrisma()
        const err = await reserve(fake, { units: 2 }).catch((e: unknown) => e)
        expect((err as { status: number }).status).toBe(400)
        expect(err).not.toBeInstanceOf(QuotaUnavailableError)
    })

    it("پیام خطا هزینهٔ اعلام‌نشده را می‌گوید تا رفع اشکال ممکن باشد", async () => {
        const fake = makeFakePrisma()
        const err = await reserve(fake, { units: 3 }).catch((e: unknown) => e)
        expect((err as Error).message).toContain("3")
    })

    it("multiUnit: true صریح ⇒ از گارد M2 عبور می‌کند و از یک سطل واحد تأمین می‌شود", async () => {
        const fake = makeFakePrisma()
        // PROMO = ۱ واحد ⇒ به‌تنهایی ۲ واحد را پوشش نمی‌دهد ⇒ کل رزرو از BASE.
        // این همان رفتار «redesign‌نشده» است که مستند شده: تک‌سطلی، نه split.
        fake.prisma.aiQuotaBucket.create({
            data: {
                userId: 1,
                feature: "ANALYZE",
                source: "PROMO",
                periodType: "MONTHLY",
                periodStart: PERIOD,
                grantedUnits: 1,
            },
        })

        const res = await reserve(fake, { units: 2, multiUnit: true })

        expect(res.quotaSource).toBe("BASE")
        expect(fake.bucket("ANALYZE", "BASE")!.reservedUnits).toBe(2)
        expect(fake.bucket("ANALYZE", "PROMO")!.reservedUnits).toBe(0)
    })

    it("multiUnit: true ولی هیچ سطلی جا ندارد ⇒ QUOTA_EXCEEDED (نه ۵۰۳)", async () => {
        const fake = makeFakePrisma({ policy: { "FREE:ANALYZE": 1 } })

        // PROMO نداریم ⇒ ظرفیتش صفر؛ BASE هم فقط ۱ واحد ⇒ ۲ واحد جا نمی‌شود
        await expect(reserve(fake, { units: 2, multiUnit: true })).rejects.toBeInstanceOf(QuotaExceededError)
        // نه denied جعلی، نه چیز نیمه‌کاره
        expect(fake.bucket("ANALYZE", "PROMO")).toBeUndefined()
        expect(fake.bucket("ANALYZE", "BASE")!.reservedUnits).toBe(0)
    })

    it("units = 1 (مسیر محصول واقعی) همچنان کاملاً عادی کار می‌کند", async () => {
        const fake = makeFakePrisma()
        const res = await reserve(fake, { units: 1 })
        expect(res.quotaSource).toBe("BASE")
        expect(res.policyAllowedUnits).toBe(15)
    })
})
