// AI Quota — تست regression برای باگ واقعی کاربر
//
// سناریویی که گزارش شد:
//   کاربر سهمیه‌اش را تمام کرده ⇒ ادمین کد هدیه می‌دهد ⇒ کاربر کد را با موفقیت
//   redeem می‌کند ⇒ ولی Dashboard هنوز «سهمیه تمام شد» نشان می‌دهد و عملیات AI هم
//   QUOTA_EXCEEDED می‌گیرد.
//
// علت ریشه‌ای: تا لحظهٔ `cutover`، دوره در حالت **LEGACY** است و نه
// `readAiQuotaStatus` و نه `reserveQuota` به bucket PROMO نگاه نمی‌کردند. یعنی
// بونوس در DB ثبت می‌شد ولی هیچ‌جا خوانده یا مصرف نمی‌شد.
//
// این تست عمداً روی **همان لحظهٔ واقعی** (۳۰ سپتامبر ۲۰۲۶، تهران) می‌نشیند و
// تصمیمِ `resolveQuotaMode` mock نمی‌شود، تا ثابت کند مسیر نمایش و مسیر enforcement
// هر دو LEGACY را می‌بینند و هر دو PROMO را حساب می‌کنند.
//
// چرا fake حالت‌دار و نه mock فراخوانی: قراردادِ این باگ «دو عددِ متفاوت از دو
// مسیر» است (UI یک چیز، enforcement چیز دیگر). با fake حالت‌دار، رزرو واقعاً روی
// همان شمارنده‌هایی می‌نشیند که status از آن‌ها می‌خواند، پس واگرایی قابل پنهان‌شدن
// نیست — دقیقاً مثل همان توصیه‌ای که خودِ تست‌های `aiQuotaStatus` دارند.

import { describe, expect, it } from "vitest"

import { completeQuota, releaseQuota, reserveQuota } from "./aiQuota.service"
import { readAiQuotaStatus } from "./aiQuotaStatus.service"
import { getMonthlyPeriod } from "./planPolicy.service"
import { describeQuotaDimension } from "@/app/dashboard/aiQuotaView"

const TZ = "Asia/Tehran"
/** همان لحظه‌ای که باگ گزارش شد: قبل از cutover، پس دوره در حالت LEGACY است. */
const NOW = new Date("2026-09-30T08:45:00.000Z")
/** مرز seed‌شده در migration ⇒ مهرِ تهران اولین دورهٔ NEW است، پس سپتامبر LEGACY. */
const CUTOVER_AT = new Date("2026-10-01T00:00:00.000Z")
/** سقف legacy پلن FREE (از `resolvePlanPolicy` — عدد در تست تکرار نشده، فقط خوانده می‌شود). */
const FREE_ALLOWED_UNITS = 15
const USER_ID = 7

const PERIOD_START = getMonthlyPeriod(NOW, TZ).periodStart

interface UsageRow {
    id: number
    userId: number
    periodType: "MONTHLY"
    periodStart: Date
    reservedUnits: number
    consumedUnits: number
}

interface BucketRow {
    id: number
    userId: number
    feature: "ANALYZE" | "PLAN"
    source: "BASE" | "PROMO"
    periodType: "MONTHLY"
    periodStart: Date
    grantedUnits: number | null
    reservedUnits: number
    consumedUnits: number
}

interface EventRow {
    requestId: string
    userId: number
    feature: string
    model: string | null
    units: number
    status: "RESERVED" | "CONSUMED" | "RELEASED"
    quotaSource: "BASE" | "PROMO" | null
    policyAllowedUnits: number | null
    bucketId: number | null
}

interface Fake {
    prisma: any
    usage: UsageRow
    buckets: BucketRow[]
    events: Map<string, EventRow>
    promo: (feature: "ANALYZE" | "PLAN") => BucketRow
}

/**
 * fake کوچک ولی واقع‌گرا: CAS، شرط `reservedUnits >= delta` و UNIQUE رزروها را
 * واقعاً اعمال می‌کند تا تست نتواند با mock سهل‌انگارانه سبز شود.
 */
function makeFake(opts: { promoAnalyze?: number; promoPlan?: number; baseConsumed?: number } = {}): Fake {
    const usage: UsageRow = {
        id: 1,
        userId: USER_ID,
        periodType: "MONTHLY",
        periodStart: PERIOD_START,
        reservedUnits: 0,
        consumedUnits: opts.baseConsumed ?? 0,
    }

    const buckets: BucketRow[] = []
    let nextBucketId = 10
    if (opts.promoAnalyze) {
        buckets.push({
            id: nextBucketId++,
            userId: USER_ID,
            feature: "ANALYZE",
            source: "PROMO",
            periodType: "MONTHLY",
            periodStart: PERIOD_START,
            grantedUnits: opts.promoAnalyze,
            reservedUnits: 0,
            consumedUnits: 0,
        })
    }
    if (opts.promoPlan) {
        buckets.push({
            id: nextBucketId++,
            userId: USER_ID,
            feature: "PLAN",
            source: "PROMO",
            periodType: "MONTHLY",
            periodStart: PERIOD_START,
            grantedUnits: opts.promoPlan,
            reservedUnits: 0,
            consumedUnits: 0,
        })
    }

    const events = new Map<string, EventRow>()

    const matchesBucket = (row: BucketRow, k: any) =>
        row.userId === k.userId &&
        row.feature === k.feature &&
        row.source === k.source &&
        row.periodType === k.periodType &&
        row.periodStart.getTime() === k.periodStart.getTime()

    const applyCounterData = (row: { reservedUnits: number; consumedUnits: number }, data: any) => {
        if (data.reservedUnits?.increment) row.reservedUnits += data.reservedUnits.increment
        if (data.reservedUnits?.decrement) row.reservedUnits -= data.reservedUnits.decrement
        if (data.consumedUnits?.increment) row.consumedUnits += data.consumedUnits.increment
        if (data.consumedUnits?.decrement) row.consumedUnits -= data.consumedUnits.decrement
    }

    const prisma: any = {
        aiQuotaCutover: {
            findUnique: async () => ({ cutoverAt: CUTOVER_AT }),
        },

        aiUsage: {
            upsert: async ({ where }: any) => {
                const k = where.userId_periodType_periodStart
                usage.userId = k.userId
                usage.periodType = k.periodType
                usage.periodStart = k.periodStart
                return { id: usage.id }
            },
            findUnique: async ({ where }: any) => {
                const k = where.userId_periodType_periodStart ?? where
                if (where.id !== undefined) {
                    return where.id === usage.id
                        ? { reservedUnits: usage.reservedUnits, consumedUnits: usage.consumedUnits }
                        : null
                }
                if (
                    k.userId !== usage.userId ||
                    k.periodType !== usage.periodType ||
                    k.periodStart.getTime() !== usage.periodStart.getTime()
                ) {
                    return null
                }
                return { reservedUnits: usage.reservedUnits, consumedUnits: usage.consumedUnits }
            },
            updateMany: async ({ where, data }: any) => {
                // CAS: شرط روی شمارنده‌های تازه خوانده‌شده
                if (
                    where.id !== usage.id ||
                    where.reservedUnits !== usage.reservedUnits ||
                    where.consumedUnits !== usage.consumedUnits
                ) {
                    return { count: 0 }
                }
                if (where.reservedUnits?.gte !== undefined && usage.reservedUnits < where.reservedUnits.gte) {
                    return { count: 0 }
                }
                applyCounterData(usage, data)
                return { count: 1 }
            },
        },

        aiQuotaBucket: {
            findUnique: async ({ where }: any) => {
                const k = where.userId_feature_source_periodType_periodStart
                return buckets.find((row) => matchesBucket(row, k)) ?? null
            },
            updateMany: async ({ where, data }: any) => {
                const row = buckets.find((b) => b.id === where.id)
                if (!row) return { count: 0 }
                // CAS نسخهٔ ۲: قفل کردن شمارنده‌های خوانده‌شده
                if (where.reservedUnits !== undefined && typeof where.reservedUnits === "number") {
                    if (row.reservedUnits !== where.reservedUnits) return { count: 0 }
                }
                if (where.consumedUnits !== undefined && typeof where.consumedUnits === "number") {
                    if (row.consumedUnits !== where.consumedUnits) return { count: 0 }
                }
                // invariant عدم‌منفی‌شدن
                if (where.reservedUnits?.gte !== undefined && row.reservedUnits < where.reservedUnits.gte) {
                    return { count: 0 }
                }
                applyCounterData(row, data)
                return { count: 1 }
            },
        },

        aiUsageEvent: {
            findUnique: async ({ where }: any) => events.get(where.requestId) ?? null,
            create: async ({ data }: any) => {
                if (events.has(data.requestId)) {
                    throw Object.assign(new Error("unique"), { code: "P2002" })
                }
                const row: EventRow = {
                    requestId: data.requestId,
                    userId: data.userId,
                    feature: data.feature,
                    model: data.model ?? null,
                    units: data.units,
                    status: "RESERVED",
                    quotaSource: data.quotaSource ?? null,
                    policyAllowedUnits: data.policyAllowedUnits ?? null,
                    bucketId: data.bucketId ?? null,
                }
                events.set(data.requestId, row)
                return row
            },
            updateMany: async ({ where, data }: any) => {
                const row = events.get(where.requestId)
                if (!row) return { count: 0 }
                if (where.status !== undefined && row.status !== where.status) return { count: 0 }
                Object.assign(row, data)
                return { count: 1 }
            },
        },

        $transaction: async (fn: (tx: any) => Promise<any>) => fn(prisma),
    }

    return {
        prisma,
        usage,
        buckets,
        events,
        promo: (feature) => buckets.find((b) => b.feature === feature && b.source === "PROMO")!,
    }
}

const readInput = { userId: USER_ID, plan: "FREE", timezone: TZ, now: NOW } as const

function reserve(fake: Fake, requestId: string, feature: "ANALYZE" | "PLAN" = "ANALYZE") {
    return reserveQuota(fake.prisma, {
        userId: USER_ID,
        requestId,
        allowedUnits: FREE_ALLOWED_UNITS,
        units: 1,
        feature: feature === "ANALYZE" ? "analyze" : "plan",
        periodStart: PERIOD_START,
        dimension: feature,
    })
}

describe("regression: کد هدیه در دورهٔ LEGACY هم دیده می‌شود هم مصرف", () => {
    it("پیش‌شرط: همین لحظه واقعاً در حالت LEGACY است (وگرنه تست بی‌معنی است)", async () => {
        const fake = makeFake({ baseConsumed: FREE_ALLOWED_UNITS, promoAnalyze: 5 })
        const status = await readAiQuotaStatus(fake.prisma, readInput)

        expect(status.mode).toBe("LEGACY")
        expect(status.periodStart).toBe(PERIOD_START.toISOString())
    })

    it("BASE تمام + PROMO موجود ⇒ remaining مثبت و Dashboard دیگر exhausted نیست", async () => {
        const fake = makeFake({ baseConsumed: FREE_ALLOWED_UNITS, promoAnalyze: 5 })

        const status = await readAiQuotaStatus(fake.prisma, readInput)

        expect(status.analyze.remaining).toBe(5)
        expect(status.analyze.promoRemaining).toBe(5)
        // بونوس جمع می‌شود، جایگزین نمی‌شود
        expect(status.analyze.granted).toBe(FREE_ALLOWED_UNITS + 5)
        expect(status.analyze.consumed).toBe(FREE_ALLOWED_UNITS)

        // همان چیزی که کاربر روی Dashboard می‌بیند
        const view = describeQuotaDimension("analyze", status.analyze)
        expect(view.tone).not.toBe("exhausted")
        expect(view.text).not.toMatch(/تمام شده/)
        expect(view.promoHint).toBe("۵ مورد هدیه")
    })

    it("اجرای ANALYZE از PROMO موفق می‌شود و AiUsage دست‌نخورده می‌ماند", async () => {
        const fake = makeFake({ baseConsumed: FREE_ALLOWED_UNITS, promoAnalyze: 5 })

        const reservation = await reserve(fake, "req-1")

        expect(reservation).toEqual({ quotaSource: "PROMO", bucketId: fake.promo("ANALYZE").id })
        // مصرفِ هدیه نباید به استخرِ مشترکِ legacy نشت کند
        expect(fake.usage.reservedUnits).toBe(0)
        expect(fake.usage.consumedUnits).toBe(FREE_ALLOWED_UNITS)
        expect(fake.promo("ANALYZE").reservedUnits).toBe(1)
        // قابل ممیزی: ledger واقعی روی رویداد ثبت شده
        expect(fake.events.get("req-1")).toMatchObject({ quotaSource: "PROMO", bucketId: fake.promo("ANALYZE").id })
    })

    it("بعد از مصرف کامل PROMO دوباره QUOTA_EXCEEDED می‌گیرد (سهمیهٔ هدیه هم تمام است)", async () => {
        const fake = makeFake({ baseConsumed: FREE_ALLOWED_UNITS, promoAnalyze: 2 })

        await reserve(fake, "req-1")
        await completeQuota(fake.prisma, "req-1", undefined, { periodStart: PERIOD_START })
        await reserve(fake, "req-2")
        await completeQuota(fake.prisma, "req-2", undefined, { periodStart: PERIOD_START })

        const exhausted = await readAiQuotaStatus(fake.prisma, readInput)
        expect(exhausted.analyze.remaining).toBe(0)
        expect(describeQuotaDimension("analyze", exhausted.analyze).tone).toBe("exhausted")

        await expect(reserve(fake, "req-3")).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" })
        // ردِ سوم نباید چیزی را رزرو کرده باشد
        expect(fake.promo("ANALYZE").reservedUnits).toBe(0)
        expect(fake.usage.reservedUnits).toBe(0)
    })

    it("شکست عملیات ⇒ release دقیقاً همان واحدِ PROMO را برمی‌گرداند (بدون نشت)", async () => {
        const fake = makeFake({ baseConsumed: FREE_ALLOWED_UNITS, promoAnalyze: 5 })

        await reserve(fake, "req-1")
        await releaseQuota(fake.prisma, "req-1", undefined, { periodStart: PERIOD_START })

        expect(fake.promo("ANALYZE").reservedUnits).toBe(0)
        expect(fake.promo("ANALYZE").consumedUnits).toBe(0)
        expect(fake.usage.reservedUnits).toBe(0)
        expect(fake.events.get("req-1")?.status).toBe("RELEASED")

        const status = await readAiQuotaStatus(fake.prisma, readInput)
        expect(status.analyze.remaining).toBe(5)
    })

    it("ANALYZE و PLAN مستقل‌اند: بونوسِ PLAN به تحلیل نشت نمی‌کند", async () => {
        const fake = makeFake({ baseConsumed: FREE_ALLOWED_UNITS, promoPlan: 3 })

        const status = await readAiQuotaStatus(fake.prisma, readInput)

        expect(status.analyze.remaining).toBe(0)
        expect(status.plan.remaining).toBe(3)
        expect(status.analyze.promoRemaining).toBe(0)
        // و enforcement هم همان تفکیک را enforce می‌کند
        await expect(reserve(fake, "req-1", "ANALYZE")).rejects.toMatchObject({
            code: "QUOTA_EXCEEDED",
        })
        await expect(reserve(fake, "req-2", "PLAN")).resolves.toMatchObject({ quotaSource: "PROMO" })
    })
})
