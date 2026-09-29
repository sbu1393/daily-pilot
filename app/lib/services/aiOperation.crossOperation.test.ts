import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* Phase 4 — تست‌های cross-operation.                                   */
/*                                                                      */
/* هدف: ثابت کردن اینکه دو بُعد سهمیه **کاملاً مستقل** هستند و هر       */
/* operation دقیقاً یک واحد مصرف می‌کند. این‌ها با fake حالت‌دار اجرا     */
/* می‌شوند تا توالی واقعی رزرو/مصرف دیده شود (نه فقط «چندبار صدا زدن»).   */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    readCutoverAt: vi.fn(),
}))

vi.mock("@/app/lib/services/aiQuotaCutover.service", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/services/aiQuotaCutover.service")>()),
    readCutoverAt: mocks.readCutoverAt,
}))

import { completeBucketQuota, readQuotaBuckets, reserveBucketQuota } from "./aiQuotaV2.service"
import {
    AI_FEATURE_SPECS,
    MultiUnitNotAllowedError,
    assertQuotaUnitsAllowed,
    resolveQuotaFeature,
} from "./quotaPolicy.service"
import { runAiOperation } from "./aiOperation.service"
import { QuotaExceededError, QuotaUnavailableError } from "./errors"

const NOW = new Date("2026-09-15T12:00:00.000Z")
const PERIOD = new Date("2026-09-01T00:00:00.000Z")

interface Bucket {
    id: number
    userId: number
    feature: string
    source: string
    periodType: string
    periodStart: Date
    grantedUnits: number | null
    reservedUnits: number
    consumedUnits: number
}

/**
 * fake حالت‌دار ledger با CAS واقعی — همان الگوی `aiQuotaV2.service.test.ts`،
 * چون فقط آن fake است که «توالی» را واقعاً نشان می‌دهد.
 */
function makeLedger(policy: Record<string, number>) {
    const buckets = new Map<number, Bucket>()
    const events = new Map<string, any>()
    let nextId = 1

    /** کلید یکتای یک bucket — همان ترکیبی که unique key دیتابیس enforce می‌کند. */
    const keyOf = (o: { userId: number; feature: string; source: string; periodType: string; periodStart: Date }) =>
        `${o.userId}|${o.feature}|${o.source}|${o.periodType}|${new Date(o.periodStart).toISOString()}`

    const applyDelta = (row: Bucket, data: any) => {
        if (data.reservedUnits?.increment) row.reservedUnits += data.reservedUnits.increment
        if (data.consumedUnits?.increment) row.consumedUnits += data.consumedUnits.increment
        if (data.reservedUnits?.decrement) row.reservedUnits -= data.reservedUnits.decrement
        if (data.consumedUnits?.decrement) row.consumedUnits -= data.consumedUnits.decrement
    }

    const prisma: any = {
        aiQuotaPolicy: {
            findUnique: async ({ where }: any) => {
                const v = policy[`${where.plan_feature.plan}:${where.plan_feature.feature}`]
                return v === undefined ? null : { allowedUnits: v }
            },
        },
        aiUsageEvent: {
            findUnique: async ({ where, select }: any) => {
                const e = events.get(where.requestId)
                if (!e) return null
                if (!select) return { status: e.status }
                // فقط فیلدهای خواسته‌شده — مثل Prisma واقعی
                const out: Record<string, unknown> = {}
                for (const [k, v] of Object.entries(select)) if (v) out[k] = e[k]
                return out
            },
            create: async ({ data }: any) => {
                if (events.has(data.requestId)) {
                    const err: any = new Error("unique")
                    err.code = "P2002"
                    throw err
                }
                const row = { ...data, status: "RESERVED", __full: true, bucketId: null, quotaSource: null }
                events.set(data.requestId, row)
                return { ...row }
            },
            updateMany: async ({ where, data }: any) => {
                const e = events.get(where.requestId)
                if (!e) return { count: 0 }
                // guard شرطی: transition فقط وقتی مجاز است که هنوز RESERVED باشد
                if (where.status !== undefined && e.status !== where.status) return { count: 0 }
                Object.assign(e, data)
                return { count: 1 }
            },
        },
        aiQuotaBucket: {
            findUnique: async ({ where }: any) => {
                const k = where.userId_feature_source_periodType_periodStart ?? where
                const wanted = keyOf(k)
                for (const row of buckets.values()) {
                    // ردیف‌های این fake باید همان کلید را نگه دارند تا lookup کار کند
                    if (keyOf(row) === wanted) return { ...row }
                }
                return null
            },
            create: async ({ data }: any) => {
                const row: Bucket = {
                    id: nextId++,
                    userId: data.userId,
                    feature: data.feature,
                    source: data.source,
                    periodType: data.periodType,
                    periodStart: new Date(data.periodStart),
                    grantedUnits: data.grantedUnits ?? null,
                    reservedUnits: 0,
                    consumedUnits: 0,
                }
                buckets.set(row.id, row)
                return { ...row }
            },
            updateMany: async ({ where, data }: any) => {
                const row = buckets.get(where.id)
                if (!row) return { count: 0 }
                // guardهای CAS: مقدار دقیق (رزرو) و gte (complete/release)
                for (const field of ["reservedUnits", "consumedUnits"] as const) {
                    const cond = where[field]
                    if (cond === undefined) continue
                    if (typeof cond === "object") {
                        if (cond.gte !== undefined && row[field] < cond.gte) return { count: 0 }
                        if (cond.lte !== undefined && row[field] > cond.lte) return { count: 0 }
                    } else if (row[field] !== cond) {
                        return { count: 0 }
                    }
                }
                applyDelta(row, data)
                return { count: 1 }
            },
        },
        $transaction: async (fn: (tx: any) => Promise<any>) => fn(prisma),
    }

    return {
        prisma,
        buckets,
        events,
        bucket: (feature: string, source = "BASE") => {
            for (const row of buckets.values()) {
                if (row.feature === feature && row.source === source) return { ...row }
            }
            return undefined
        },
    }
}

const PRODUCT_POLICY = {
    "FREE:ANALYZE": 15,
    "FREE:PLAN": 2,
    "PRO:ANALYZE": 270,
    "PRO:PLAN": 50,
}

function reserve(
    ledger: ReturnType<typeof makeLedger>,
    feature: "ANALYZE" | "PLAN",
    i: number,
    plan = "FREE",
) {
    return reserveBucketQuota(ledger.prisma, {
        userId: 1,
        requestId: `x-${feature}-${i}`,
        feature,
        units: 1,
        plan,
        timezone: "UTC",
        now: NOW,
    })
}

beforeEach(() => {
    vi.clearAllMocks()
    // cutover در گذشته ⇒ مسیر V2 (این تست دربارهٔ ledger جدید است)
    mocks.readCutoverAt.mockResolvedValue(new Date("2026-01-01T00:00:00.000Z"))
})

describe("cross-operation — استقلال دو بُعد", () => {
    it("مصرف ANALYZE هیچ اثری روی PLAN ندارد", async () => {
        const ledger = makeLedger(PRODUCT_POLICY)

        // کل سهمیهٔ PLAN (FREE = ۲) را مصرف کن
        await reserve(ledger, "PLAN", 1)
        await reserve(ledger, "PLAN", 2)
        await expect(reserve(ledger, "PLAN", 3)).rejects.toBeInstanceOf(QuotaExceededError)

        // حالا ANALYZE باید کاملاً آزاد باشد
        await expect(reserve(ledger, "ANALYZE", 1)).resolves.toMatchObject({
            quotaSource: "BASE",
        })
        expect(ledger.bucket("ANALYZE", "BASE")!.consumedUnits).toBe(0)
        expect(ledger.bucket("ANALYZE", "BASE")!.reservedUnits).toBe(1)
        expect(ledger.bucket("PLAN", "BASE")!.reservedUnits).toBe(2)
    })

    it("مصرف PLAN هیچ اثری روی ANALYZE ندارد", async () => {
        const ledger = makeLedger(PRODUCT_POLICY)

        // ۱۵ واحد از ۱۵ ظرفیت ANALYZE را مصرف کن
        for (let i = 0; i < 15; i++) await reserve(ledger, "ANALYZE", i)
        await expect(reserve(ledger, "ANALYZE", 99)).rejects.toBeInstanceOf(QuotaExceededError)

        // PLAN هنوز کاملاً آزاد است
        await expect(reserve(ledger, "PLAN", 1)).resolves.toMatchObject({ quotaSource: "BASE" })
    })

    it("ظرفیت‌ها مستقل‌اند: ۱۵ در برابر ۲", async () => {
        const ledger = makeLedger(PRODUCT_POLICY)

        for (let i = 0; i < 15; i++) await reserve(ledger, "ANALYZE", i)
        await reserve(ledger, "PLAN", 1)
        await reserve(ledger, "PLAN", 2)

        const views = await readQuotaBuckets(ledger.prisma, {
            userId: 1,
            plan: "FREE",
            timezone: "UTC",
            now: NOW,
        })
        const analyze = views.find((v) => v.feature === "ANALYZE" && v.source === "BASE")!
        const plan = views.find((v) => v.feature === "PLAN" && v.source === "BASE")!

        expect(analyze.capacity).toBe(15)
        expect(analyze.remaining).toBe(0)
        expect(plan.capacity).toBe(2)
        expect(plan.remaining).toBe(0)
    })

    it("سقف PRO با FREE اشتباه نمی‌شود", async () => {
        const ledger = makeLedger(PRODUCT_POLICY)

        // کاربر FREE در PLAN سقف ۲ دارد
        await reserve(ledger, "PLAN", 1, "FREE")
        await reserve(ledger, "PLAN", 2, "FREE")
        await expect(reserve(ledger, "PLAN", 3, "FREE")).rejects.toBeInstanceOf(QuotaExceededError)

        // همان کاربر اگر PRO بود، ۵۰ واحد داشت — جدول از DB می‌آید
        await expect(reserve(ledger, "PLAN", 4, "PRO")).resolves.toMatchObject({
            policyAllowedUnits: 50,
        })
    })

    it("پلن PRO هم ۵۰ ظرفیت دارد (نه ۲)", async () => {
        const ledger = makeLedger(PRODUCT_POLICY)
        for (let i = 0; i < 50; i++) await reserve(ledger, "PLAN", i, "PRO")
        await expect(reserve(ledger, "PLAN", 999, "PRO")).rejects.toBeInstanceOf(QuotaExceededError)
        expect(ledger.bucket("PLAN", "BASE")!.reservedUnits).toBe(50)
    })
})

describe("cross-operation — نگاشت فیچر و واحد", () => {
    it("جدول فیچرها دقیقاً analyze و plan است", () => {
        expect(Object.keys(AI_FEATURE_SPECS).sort()).toEqual(["analyze", "plan"])
    })

    it("analyze → بُعد ANALYZE و plan → بُعد PLAN", () => {
        expect(resolveQuotaFeature("analyze").dimension).toBe("ANALYZE")
        expect(resolveQuotaFeature("plan").dimension).toBe("PLAN")
    })

    it("هر دو فیچر دقیقاً یک واحد هستند و multiUnit ندارند", () => {
        expect(resolveQuotaFeature("analyze").units).toBe(1)
        expect(resolveQuotaFeature("plan").units).toBe(1)
        expect(resolveQuotaFeature("analyze").multiUnit).toBe(false)
        expect(resolveQuotaFeature("plan").multiUnit).toBe(false)
    })

    it("هیچ feature سومی وجود ندارد (ai-test سهمیه نمی‌گیرد)", () => {
        expect(() => resolveQuotaFeature("ai-test")).toThrow()
    })
})

describe("cross-operation — units همیشه ۱ در مسیر مرکزی", () => {
    it("۳ رزرو ANALYZE و ۳ رزرو PLAN = ۳ واحد در هر بُعد، نه ۹", async () => {
        // PRO تا هر دو بُعد ظرفیت کافی برای ۳ رزرو داشته باشند
        // (FREE: ANALYZE=15 ولی PLAN=2)
        const ledger = makeLedger(PRODUCT_POLICY)

        const calls: string[] = []
        const user = { id: 1, plan: "PRO" as const, timezone: "UTC" }
        for (let i = 0; i < 3; i++) {
            await runAiOperation({
                prisma: ledger.prisma,
                user,
                feature: "analyze",
                requestId: `ao-analyze-${i}`,
                execute: async () => {
                    calls.push("analyze")
                    // چند provider call در یک عملیات منطقی
                    return { result: "ok", telemetry: { durationMs: 100, attempts: 3 } }
                },
            })
            await runAiOperation({
                prisma: ledger.prisma,
                user,
                feature: "plan",
                requestId: `ao-plan-${i}`,
                execute: async () => {
                    calls.push("plan")
                    return { result: "ok", telemetry: { durationMs: 100, attempts: 2 } }
                },
            })
        }
        expect(calls).toHaveLength(6)
        // هر بُعد دقیقاً ۳ واحد: ۳ operation × ۱ واحد، با وجود ۳ provider call هرکدام
        expect(ledger.bucket("ANALYZE", "BASE")!.consumedUnits).toBe(3)
        expect(ledger.bucket("PLAN", "BASE")!.consumedUnits).toBe(3)
        // ظرفیت PRO استفاده شده، نه FREE
        expect(ledger.bucket("PLAN", "BASE")!.reservedUnits).toBe(0)
    })

    it("attempts در telemetry ثبت می‌شود ولی واحد quota را زیاد نمی‌کند", async () => {
        const ledger = makeLedger(PRODUCT_POLICY)
        const user = { id: 1, plan: "FREE" as const, timezone: "UTC" }

        for (let i = 0; i < 3; i++) {
            await runAiOperation({
                prisma: ledger.prisma,
                user,
                feature: "analyze",
                requestId: `attempts-${i}`,
                execute: async () => ({
                    result: "ok",
                    // ۹ provider call در یک عملیات منطقی
                    telemetry: { durationMs: 9000, attempts: 9 },
                }),
            })
        }

        expect(ledger.bucket("ANALYZE", "BASE")!.consumedUnits).toBe(3)
        // و شمارندهٔ واقعی تلاش‌ها روی هر رویداد ثبت شده
        for (let i = 0; i < 3; i++) {
            expect(ledger.events.get(`attempts-${i}`).attempts).toBe(9)
        }
    })

    it("شکست یک operation روی بُعد دیگر اثری ندارد", async () => {
        const ledger = makeLedger(PRODUCT_POLICY)
        const user = { id: 1, plan: "FREE" as const, timezone: "UTC" }

        await expect(
            runAiOperation({
                prisma: ledger.prisma,
                user,
                feature: "plan",
                requestId: "fail-plan",
                execute: async () => {
                    throw new Error("ai down")
                },
            }),
        ).rejects.toThrow("ai down")

        // PLAN آزاد شد، ANALYZE دست‌نخورده و آماده
        expect(ledger.bucket("PLAN", "BASE")!.reservedUnits).toBe(0)
        expect(ledger.bucket("PLAN", "BASE")!.consumedUnits).toBe(0)
        expect(ledger.bucket("ANALYZE", "BASE")).toBeUndefined()
        await expect(
            runAiOperation({
                prisma: ledger.prisma,
                user,
                feature: "analyze",
                requestId: "after-fail",
                execute: async () => ({ result: "ok" }),
            }),
        ).resolves.toMatchObject({ quotaSource: "BASE", quotaMode: "NEW" })
    })

    it("M2: مسیر مرکزی هرگز units>1 تولید نمی‌کند (جدول بسته آن را تضمین می‌کند)", async () => {
        const ledger = makeLedger(PRODUCT_POLICY)
        const user = { id: 1, plan: "FREE" as const, timezone: "UTC" }

        await runAiOperation({
            prisma: ledger.prisma,
            user,
            feature: "analyze",
            requestId: "m2-check",
            execute: async () => ({ result: "ok" }),
        })

        const event = ledger.events.get("m2-check")
        expect(event.units).toBe(1)

        // و اگر روزی spec خراب شود، گارد واقعی fail-fast است — نه یک رزرو
        // چندواحدیِ خاموش. گارد واقعی صدا زده می‌شود، نه بازآفرینیِ منطق آن.
        expect(() => assertQuotaUnitsAllowed("analyze", 3)).toThrow(MultiUnitNotAllowedError)
        // مسیر V2 هم جداگانه گارد دارد (deny-by-default)
        await expect(
            reserveBucketQuota(ledger.prisma, {
                userId: 1,
                requestId: "m2-reject",
                feature: "ANALYZE",
                units: 2,
                plan: "FREE",
                timezone: "UTC",
                now: NOW,
            }),
        ).rejects.toBeInstanceOf(MultiUnitNotAllowedError)
        expect(ledger.buckets.size).toBe(1) // فقط همان bucket یک‌واحدی قبلی
    })

    it("fail-closed: خطای policy ⇒ ۵۰۳، نه رزرو ساختگی", async () => {
        // policy خالی یعنی ردیف‌ها وجود ندارند ⇒ readQuotaPolicy fail-closed
        const ledger = makeLedger({})
        const user = { id: 1, plan: "FREE" as const, timezone: "UTC" }

        await expect(
            runAiOperation({
                prisma: ledger.prisma,
                user,
                feature: "analyze",
                requestId: "no-policy",
                execute: async () => ({ result: "never" }),
            }),
        ).rejects.toBeInstanceOf(QuotaUnavailableError)

        // execute هرگز اجرا نشد و هیچ واحدی ساخته/مصرف نشد
        expect(ledger.buckets.size).toBe(0)
    })
})

describe("cross-operation — complete روی همان بُعدی که رزرو شد", () => {
    it("complete بُعد درست را کم می‌کند و بُعد دیگر را دست‌نخورده می‌گذارد", async () => {
        const ledger = makeLedger(PRODUCT_POLICY)
        const user = { id: 1, plan: "FREE" as const, timezone: "UTC" }

        // رزرو هر دو بُعد، هر کدام جدا
        await runAiOperation({
            prisma: ledger.prisma,
            user,
            feature: "analyze",
            requestId: "cross-analyze",
            execute: async () => ({ result: "ok" }),
        })
        await reserveBucketQuota(ledger.prisma, {
            userId: 1,
            requestId: "cross-plan",
            feature: "PLAN",
            units: 1,
            plan: "FREE",
            timezone: "UTC",
            now: NOW,
        })

        expect(ledger.bucket("ANALYZE", "BASE")!.consumedUnits).toBe(1)
        // رزرو PLAN هنوز فقط «رزرو» است
        expect(ledger.bucket("PLAN", "BASE")!.reservedUnits).toBe(1)
        expect(ledger.bucket("PLAN", "BASE")!.consumedUnits).toBe(0)

        // complete رویداد ANALYZE (که `runAiOperation` انجام داده) بی‌اثر است
        // چون وضعیتش CONSUMED شده — idempotent، نه مصرف دوباره.
        await expect(
            completeBucketQuota(ledger.prisma, "cross-analyze", { periodStart: PERIOD }),
        ).resolves.toBe(false)
        expect(ledger.bucket("ANALYZE", "BASE")!.consumedUnits).toBe(1)

        // مهم‌تر: آن complete هرگز به bucket برنامه دست نزده است
        expect(ledger.bucket("PLAN", "BASE")!.reservedUnits).toBe(1)
        expect(ledger.bucket("PLAN", "BASE")!.consumedUnits).toBe(0)

        // و release همان رزروِ PLAN هم روی bucket خودش می‌نشیند
        await expect(
            completeBucketQuota(ledger.prisma, "cross-plan", { periodStart: PERIOD }),
        ).resolves.toBe(true)
        expect(ledger.bucket("PLAN", "BASE")!.reservedUnits).toBe(0)
        expect(ledger.bucket("PLAN", "BASE")!.consumedUnits).toBe(1)
        expect(ledger.bucket("ANALYZE", "BASE")!.consumedUnits).toBe(1)
    })

    it("requestId ناشناخته ⇒ no-op برگردانده می‌شود، نه مصرف جعلی", async () => {
        const ledger = makeLedger(PRODUCT_POLICY)

        // رفتار واقعی سرویس: رویدادی وجود ندارد ⇒ transition بی‌اثر (idempotent)
        await expect(
            completeBucketQuota(ledger.prisma, "no-such-request", { periodStart: PERIOD }),
        ).resolves.toBe(false)
        expect(ledger.buckets.size).toBe(0)
    })

    it("دو operation هم‌زمان، هر کدام یک رزرو مستقل می‌سازند", async () => {
        const ledger = makeLedger(PRODUCT_POLICY)
        const user = { id: 1, plan: "FREE" as const, timezone: "UTC" }

        await Promise.all([
            runAiOperation({
                prisma: ledger.prisma,
                user,
                feature: "analyze",
                requestId: "par-analyze",
                execute: async () => ({ result: "a" }),
            }),
            runAiOperation({
                prisma: ledger.prisma,
                user,
                feature: "plan",
                requestId: "par-plan",
                execute: async () => ({ result: "p" }),
            }),
        ])

        expect(ledger.bucket("ANALYZE", "BASE")!.consumedUnits).toBe(1)
        expect(ledger.bucket("PLAN", "BASE")!.consumedUnits).toBe(1)
    })
})
