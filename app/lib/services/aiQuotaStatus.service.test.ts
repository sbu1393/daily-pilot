// AI Quota status — تست‌های read-model نمایش سهمیه
//
// این تست‌ها عمداً روی تصمیمِ **واقعی** cutover می‌نشینند (`readCutoverAt` و
// `resolveQuotaMode` mock نشده‌اند) تا ثابت کنند مسیر نمایش، همان تصمیمی را می‌گیرد
// که `runAiOperation` می‌گیرد.
//
// fake مثل بقیهٔ تست‌های ledger **حالت‌دار** است، نه mock فراخوانی: policy و bucket
// واقعاً در Map نگه داشته می‌شوند تا «سقف عوض شود، UI بدون تغییر کد عدد جدید را
// نشان دهد» واقعاً آزموده شود.

import { describe, expect, it } from "vitest"

import { readAiQuotaStatus } from "./aiQuotaStatus.service"
import { QuotaUnavailableError } from "./errors"

const NOW = new Date("2026-09-15T12:00:00.000Z")
const PERIOD = "2026-09-01T00:00:00.000Z"

// مرزهایی که `firstNewPeriodStart` را در دو حالت مختلف می‌گذارند (UTC period = 2026-09-01)
const CUTOVER_NEW = new Date("2026-09-01T00:00:00.000Z") // ← روی مرز ⇒ NEW
const CUTOVER_LEGACY = new Date("2026-10-01T00:00:00.000Z") // بعد از شروع دوره ⇒ LEGACY

interface Bucket {
    id: number
    userId: number
    feature: string
    source: string
    periodStart: string
    grantedUnits: number | null
    reservedUnits: number
    consumedUnits: number
}

interface Options {
    cutoverAt?: Date
    policy?: Record<string, number>
    buckets?: Partial<Bucket>[]
    usage?: { reservedUnits: number; consumedUnits: number } | null
    /** خراب کردن خواندن policy برای تست fail-closed */
    policyThrows?: boolean
}

function makeFakePrisma(opts: Options = {}) {
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

    let nextId = 1
    const buckets = new Map<number, Bucket>(
        (opts.buckets ?? []).map((b) => {
            const row: Bucket = {
                id: nextId++,
                userId: 7,
                feature: "ANALYZE",
                source: "BASE",
                periodStart: PERIOD,
                grantedUnits: null,
                reservedUnits: 0,
                consumedUnits: 0,
                ...b,
            }
            return [row.id, row]
        }),
    )

    const usage = opts.usage === undefined ? { reservedUnits: 0, consumedUnits: 0 } : opts.usage

    const prisma: any = {
        aiQuotaCutover: {
            findUnique: async () => ({ cutoverAt: opts.cutoverAt ?? CUTOVER_NEW }),
        },
        aiQuotaPolicy: {
            findUnique: async ({ where }: any) => {
                if (opts.policyThrows) throw new Error("db down")
                const v = policy.get(
                    `${where.plan_feature.plan}:${where.plan_feature.feature}`,
                )
                return v === undefined ? null : { allowedUnits: v }
            },
        },
        aiQuotaBucket: {
            findUnique: async ({ where }: any) => {
                const k = where.userId_feature_source_periodType_periodStart
                for (const row of buckets.values()) {
                    if (
                        row.userId === k.userId &&
                        row.feature === k.feature &&
                        row.source === k.source &&
                        row.periodStart === k.periodStart.toISOString()
                    ) {
                        return row
                    }
                }
                return null
            },
        },
        aiUsage: {
            findUnique: async ({ where }: any) => {
                const k = where.userId_periodType_periodStart
                if (k.userId !== 7 || k.periodStart.toISOString() !== PERIOD) return null
                return usage ? { ...usage } : null
            },
        },
    }

    return { prisma, buckets }
}

const base = { userId: 7, plan: "FREE", timezone: "UTC", now: NOW } as const

describe("readAiQuotaStatus — دورهٔ V2", () => {
    it("BASE بدون مصرف ⇒ remaining برابر سقفِ زندهٔ policy", async () => {
        const { prisma } = makeFakePrisma({ cutoverAt: CUTOVER_NEW })
        const s = await readAiQuotaStatus(prisma, base)

        expect(s.mode).toBe("NEW")
        expect(s.analyze).toMatchObject({ remaining: 15, granted: 15, consumed: 0, promoRemaining: 0 })
        expect(s.plan).toMatchObject({ remaining: 2, granted: 2, consumed: 0, promoRemaining: 0 })
    })

    it("مصرف، remaining را کم می‌کند و consumed را بالا می‌برد", async () => {
        const { prisma } = makeFakePrisma({
            cutoverAt: CUTOVER_NEW,
            buckets: [{ feature: "ANALYZE", source: "BASE", consumedUnits: 6 }],
        })
        const s = await readAiQuotaStatus(prisma, base)

        expect(s.analyze.remaining).toBe(9)
        expect(s.analyze.consumed).toBe(6)
    })

    it("PROMO در remaining قابل‌استفاده لحاظ می‌شود", async () => {
        const { prisma } = makeFakePrisma({
            cutoverAt: CUTOVER_NEW,
            buckets: [
                { feature: "ANALYZE", source: "PROMO", grantedUnits: 2 },
                { feature: "ANALYZE", source: "BASE", consumedUnits: 14 },
            ],
        })
        const s = await readAiQuotaStatus(prisma, base)

        // BASE تمام شده (15-14=1) ولی ۲ واحد هدیه هست ⇒ کاربر ۳ تا می‌تواند مصرف کند.
        expect(s.analyze.remaining).toBe(3)
        expect(s.analyze.promoRemaining).toBe(2)
        // granted شامل هدیه است تا عدد «۳ از ۱۷» گمراه‌کننده نشود.
        expect(s.analyze.granted).toBe(17)
    })

    it("رزروِ فعال از remaining کم می‌شود (remaining ≠ granted - consumed)", async () => {
        const { prisma } = makeFakePrisma({
            cutoverAt: CUTOVER_NEW,
            buckets: [
                // ۱ واحد رزروِ باز + ۶ مصرف‌شده ⇒ فقط ۸ تا قابل استفاده است
                { feature: "ANALYZE", source: "BASE", consumedUnits: 6, reservedUnits: 1 },
            ],
        })
        const s = await readAiQuotaStatus(prisma, base)

        expect(s.analyze.remaining).toBe(8) // نه ۹
        expect(s.analyze.granted - s.analyze.consumed).toBe(9)
    })

    it("رزرو PROMO هم به‌درستی کم می‌شود", async () => {
        const { prisma } = makeFakePrisma({
            cutoverAt: CUTOVER_NEW,
            buckets: [
                { feature: "ANALYZE", source: "PROMO", grantedUnits: 3, reservedUnits: 1 },
            ],
        })
        const s = await readAiQuotaStatus(prisma, base)

        expect(s.analyze.promoRemaining).toBe(2)
        expect(s.analyze.remaining).toBe(2 + 15)
    })

    it("PRO تازه‌ی policy را بدون تغییر کد می‌گیرد (بدون hardcode)", async () => {
        const { prisma } = makeFakePrisma({
            cutoverAt: CUTOVER_NEW,
            policy: {
                "FREE:ANALYZE": 15,
                "FREE:PLAN": 2,
                "PRO:ANALYZE": 270,
                "PRO:PLAN": 50,
            },
        })
        const s = await readAiQuotaStatus(prisma, { ...base, plan: "PRO" })

        expect(s.analyze.remaining).toBe(270)
        expect(s.plan.remaining).toBe(50)
    })

    it("تغییر policy توسط ادمین بلافاصله در نمایش اثر می‌کند", async () => {
        const { prisma } = makeFakePrisma({
            cutoverAt: CUTOVER_NEW,
            policy: {
                "FREE:ANALYZE": 40,
                "FREE:PLAN": 2,
                "PRO:ANALYZE": 270,
                "PRO:PLAN": 50,
            },
            buckets: [{ feature: "ANALYZE", source: "BASE", consumedUnits: 6 }],
        })
        const s = await readAiQuotaStatus(prisma, base)

        expect(s.analyze.remaining).toBe(34)
    })

    it("پایین آوردن سقف وسط ماه، remaining را صفر می‌کند ولی شمارنده‌ها را نمی‌شکند", async () => {
        const { prisma } = makeFakePrisma({
            cutoverAt: CUTOVER_NEW,
            policy: {
                "FREE:ANALYZE": 5,
                "FREE:PLAN": 2,
                "PRO:ANALYZE": 270,
                "PRO:PLAN": 50,
            },
            buckets: [{ feature: "ANALYZE", source: "BASE", consumedUnits: 12 }],
        })
        const s = await readAiQuotaStatus(prisma, base)

        expect(s.analyze.remaining).toBe(0)
        expect(s.analyze.consumed).toBe(12) // مصرف واقعی دست‌نخورده
    })

    it("کاربرِ دیگر دیده نمی‌شود: هر کاربر فقط bucketهای خودش را می‌بیند", async () => {
        const { prisma } = makeFakePrisma({
            cutoverAt: CUTOVER_NEW,
            buckets: [
                { userId: 7, feature: "ANALYZE", source: "BASE", consumedUnits: 3 },
                // متعلق به کاربر دیگر — نباید هیچ اثری روی userId=7 بگذارد
                { userId: 999, feature: "ANALYZE", source: "BASE", consumedUnits: 15 },
                { userId: 999, feature: "ANALYZE", source: "PROMO", grantedUnits: 50 },
            ],
        })
        const s = await readAiQuotaStatus(prisma, base)

        expect(s.analyze.remaining).toBe(12)
        expect(s.analyze.promoRemaining).toBe(0)
    })
})

describe("readAiQuotaStatus — دورهٔ LEGACY", () => {
    it("در بازهٔ legacy از جدول AiUsage و سقف legacy استفاده می‌شود", async () => {
        const { prisma } = makeFakePrisma({
            cutoverAt: CUTOVER_LEGACY,
            usage: { reservedUnits: 0, consumedUnits: 15 },
        })
        const s = await readAiQuotaStatus(prisma, base)

        expect(s.mode).toBe("LEGACY")
        // سقف legacy برای FREE برابر ۱۵ است (یک استخر مشترک، نه ۱۵ و ۲)
        expect(s.analyze.remaining).toBe(0)
        expect(s.plan.remaining).toBe(0)
        expect(s.analyze.consumed).toBe(15)
    })

    it("در legacy هر دو بُعد یک استخر مشترک‌اند (عمداً یکسان)", async () => {
        const { prisma } = makeFakePrisma({
            cutoverAt: CUTOVER_LEGACY,
            usage: { reservedUnits: 1, consumedUnits: 4 },
        })
        const s = await readAiQuotaStatus(prisma, base)

        expect(s.analyze).toEqual(s.plan)
        expect(s.analyze.remaining).toBe(15 - 1 - 4)
        expect(s.analyze.promoRemaining).toBe(0) // بدون کد هدیه، PROMO وجود ندارد
    })

    it("در legacy سقفِ V2 policy استفاده نمی‌شود", async () => {
        // حتی اگر policy بگوید PLAN=2، مسیر legacy برای plan هم ۱۵ می‌دهد چون
        // reserve واقعیِ legacy روی همان استخر مشترک انجام می‌شود.
        const { prisma } = makeFakePrisma({
            cutoverAt: CUTOVER_LEGACY,
            usage: { reservedUnits: 0, consumedUnits: 0 },
        })
        const s = await readAiQuotaStatus(prisma, base)

        expect(s.plan.remaining).toBe(15)
    })

    it("در legacy نبودِ ردیف AiUsage ⇒ remaining برابر سقف کامل", async () => {
        const { prisma } = makeFakePrisma({ cutoverAt: CUTOVER_LEGACY, usage: null })
        const s = await readAiQuotaStatus(prisma, base)

        expect(s.analyze.remaining).toBe(15)
        expect(s.analyze.consumed).toBe(0)
    })

    it("PRO در legacy سقف legacy را می‌گیرد، نه ۳۰۰", async () => {
        const { prisma } = makeFakePrisma({
            cutoverAt: CUTOVER_LEGACY,
            usage: { reservedUnits: 0, consumedUnits: 0 },
        })
        const s = await readAiQuotaStatus(prisma, { ...base, plan: "PRO" })

        expect(s.analyze.remaining).toBe(300)
    })
})

// ── سهمیهٔ هدیه (PROMO) در دورهٔ legacy ───────────────────────────────────────
// این دسته دقیقاً باگ گزارش‌شده را قفل می‌کند: بونوس در DB ثبت شده بود ولی در
// مسیر legacy اصلاً خوانده نمی‌شد، پس Dashboard «تمام شده» می‌گفت و enforcement هم
// QUOTA_EXCEEDED می‌داد. قرارداد: `remaining = base_remaining + promo_remaining` و
// بونوسِ هر بُعد فقط به همان بُعد اضافه می‌شود.
describe("readAiQuotaStatus — دورهٔ LEGACY با PROMO", () => {
    const promo = (feature: string, grantedUnits: number, extra: Partial<Bucket> = {}) => ({
        feature,
        source: "PROMO",
        periodStart: PERIOD,
        grantedUnits,
        ...extra,
    })

    it("بدون PROMO ⇒ دقیقاً رفتار قبلی (بدون هیچ تغییری)", async () => {
        const { prisma } = makeFakePrisma({
            cutoverAt: CUTOVER_LEGACY,
            usage: { reservedUnits: 1, consumedUnits: 4 },
        })
        const s = await readAiQuotaStatus(prisma, base)

        expect(s.analyze.remaining).toBe(15 - 1 - 4)
        expect(s.analyze.promoRemaining).toBe(0)
        expect(s.analyze.granted).toBe(15)
    })

    it("BASE تمام + PROMO موجود ⇒ remaining مثبت و promoRemaining درست", async () => {
        const { prisma } = makeFakePrisma({
            cutoverAt: CUTOVER_LEGACY,
            usage: { reservedUnits: 0, consumedUnits: 15 },
            buckets: [promo("ANALYZE", 5)],
        })
        const s = await readAiQuotaStatus(prisma, base)

        expect(s.analyze.remaining).toBe(5)
        expect(s.analyze.promoRemaining).toBe(5)
        // جمع است، جایگزینی نیست
        expect(s.analyze.granted).toBe(20)
        expect(s.analyze.consumed).toBe(15)
    })

    it("PROMO مصرف‌شده از remaining خودش کم می‌شود و به consumed اضافه می‌گردد", async () => {
        const { prisma } = makeFakePrisma({
            cutoverAt: CUTOVER_LEGACY,
            usage: { reservedUnits: 0, consumedUnits: 15 },
            buckets: [promo("ANALYZE", 5, { consumedUnits: 2 })],
        })
        const s = await readAiQuotaStatus(prisma, base)

        expect(s.analyze.promoRemaining).toBe(3)
        expect(s.analyze.remaining).toBe(3)
        expect(s.analyze.consumed).toBe(17)
    })

    it("رزرو فعالِ PROMO هم از remaining کم می‌شود (remaining ≠ granted - consumed)", async () => {
        const { prisma } = makeFakePrisma({
            cutoverAt: CUTOVER_LEGACY,
            usage: { reservedUnits: 0, consumedUnits: 15 },
            buckets: [promo("ANALYZE", 5, { reservedUnits: 2 })],
        })
        const s = await readAiQuotaStatus(prisma, base)

        expect(s.analyze.promoRemaining).toBe(3)
        expect(s.analyze.remaining).toBe(3)
    })

    it("PROMO ناکافی ⇒ remaining صفر و عملاً exhausted (عدمِ overspend نمایشی)", async () => {
        const { prisma } = makeFakePrisma({
            cutoverAt: CUTOVER_LEGACY,
            usage: { reservedUnits: 0, consumedUnits: 15 },
            buckets: [promo("ANALYZE", 1, { consumedUnits: 1 })],
        })
        const s = await readAiQuotaStatus(prisma, base)

        expect(s.analyze.promoRemaining).toBe(0)
        expect(s.analyze.remaining).toBe(0)
    })

    it("PROMO مربوط به دورهٔ قبل مصرف نمی‌شود", async () => {
        const { prisma } = makeFakePrisma({
            cutoverAt: CUTOVER_LEGACY,
            usage: { reservedUnits: 0, consumedUnits: 15 },
            buckets: [
                {
                    feature: "ANALYZE",
                    source: "PROMO",
                    // دورهٔ قبل: کلید خواندن `periodStart` جاری است، پس نادیده می‌ماند
                    periodStart: "2026-08-01T00:00:00.000Z",
                    grantedUnits: 99,
                },
            ],
        })
        const s = await readAiQuotaStatus(prisma, base)

        expect(s.analyze.remaining).toBe(0)
        expect(s.analyze.promoRemaining).toBe(0)
    })

    it("ANALYZE و PLAN مستقل‌اند: بونوسِ یکی به دیگری نشت نمی‌کند", async () => {
        const { prisma } = makeFakePrisma({
            cutoverAt: CUTOVER_LEGACY,
            usage: { reservedUnits: 0, consumedUnits: 15 },
            buckets: [promo("PLAN", 3)],
        })
        const s = await readAiQuotaStatus(prisma, base)

        expect(s.plan.remaining).toBe(3)
        expect(s.analyze.remaining).toBe(0)
        expect(s.analyze.promoRemaining).toBe(0)
    })

    it("PROMO دوبار شمرده نمی‌شود: base از AiUsage می‌آید، promo فقط از bucket", async () => {
        const { prisma, buckets } = makeFakePrisma({
            cutoverAt: CUTOVER_LEGACY,
            usage: { reservedUnits: 0, consumedUnits: 15 },
            buckets: [promo("ANALYZE", 5)],
        })
        const s = await readAiQuotaStatus(prisma, base)

        // اگر PROMO دوبار جمع می‌شد، remaining می‌شد ۱۰
        expect(s.analyze.remaining).toBe(5)
        // و اگر از روی `AiUsage` دوباره خوانده می‌شد، مصرفِ BASE را دوباره می‌کشت
        expect(s.analyze.consumed).toBe(15)
        // تنها منبعِ عددِ promo همان یک ردیف است
        expect([...buckets.values()].filter((b) => b.source === "PROMO")).toHaveLength(1)
    })

    it("BASE هنوز جا دارد ⇒ PROMO دست‌نخورده می‌ماند و remaining همان سقف است", async () => {
        const { prisma } = makeFakePrisma({
            cutoverAt: CUTOVER_LEGACY,
            usage: { reservedUnits: 0, consumedUnits: 0 },
            buckets: [promo("ANALYZE", 5)],
        })
        const s = await readAiQuotaStatus(prisma, base)

        expect(s.analyze.remaining).toBe(20)
        expect(s.analyze.promoRemaining).toBe(5)
    })
})

describe("readAiQuotaStatus — cutover و timezone", () => {
    it("مرز بسته به راست است: cutoverAt دقیقاً روی periodStart ⇒ NEW", async () => {
        const { prisma } = makeFakePrisma({ cutoverAt: CUTOVER_NEW })
        const s = await readAiQuotaStatus(prisma, base)
        expect(s.mode).toBe("NEW")
    })

    it("دورهٔ تهران در سپتامبر هنوز LEGACY است و اکتبر NEW", async () => {
        // 2026-10-01 00:00 تهران = 2026-09-30T20:30Z
        const tehran = { ...base, timezone: "Asia/Tehran" }

        const legacy = await readAiQuotaStatus(
            makeFakePrisma({ cutoverAt: new Date("2026-09-30T20:30:00.000Z") }).prisma,
            tehran,
        )
        expect(legacy.mode).toBe("LEGACY")

        const fresh = await readAiQuotaStatus(
            makeFakePrisma({
                cutoverAt: new Date("2026-09-30T20:30:00.000Z"),
                policy: {
                    "FREE:ANALYZE": 15,
                    "FREE:PLAN": 2,
                    "PRO:ANALYZE": 270,
                    "PRO:PLAN": 50,
                },
            }).prisma,
            { ...tehran, now: new Date("2026-10-15T10:00:00.000Z") },
        )
        expect(fresh.mode).toBe("NEW")
    })

    it("periodStart برگشتی، شروع دورهٔ محلی کاربر است", async () => {
        const { prisma } = makeFakePrisma({
            cutoverAt: CUTOVER_NEW,
            buckets: [{ periodStart: "2026-09-01T00:00:00.000Z" }],
        })
        const s = await readAiQuotaStatus(prisma, base)

        expect(s.periodStart).toBe("2026-09-01T00:00:00.000Z")
    })
})

describe("readAiQuotaStatus — fail-closed", () => {
    it("خطای DB ⇒ QuotaUnavailableError (نه عددِ ساختگی)", async () => {
        const { prisma } = makeFakePrisma({ cutoverAt: CUTOVER_NEW, policyThrows: true })
        await expect(readAiQuotaStatus(prisma, base)).rejects.toBeInstanceOf(QuotaUnavailableError)
    })

    it("رزروِ در جریان گم می‌شود ولی پس از release شماره به حالت اول برمی‌گردد (بدون مصرفِ جعلی)", async () => {
        const { prisma, buckets } = makeFakePrisma({
            cutoverAt: CUTOVER_NEW,
            buckets: [{ feature: "ANALYZE", source: "BASE" }],
        })

        // ۱) عملیات در حال اجرا ⇒ یک واحد رزرو شده و هنوز قطعی نیست
        buckets.get(1)!.reservedUnits = 1
        const during = await readAiQuotaStatus(prisma, base)
        expect(during.analyze.remaining).toBe(14)

        // ۲) عملیات شکست خورد و release شد ⇒ نه مصرفی، نه رزروی
        buckets.get(1)!.reservedUnits = 0
        buckets.get(1)!.consumedUnits = 0
        const after = await readAiQuotaStatus(prisma, base)
        expect(after.analyze.remaining).toBe(15)
        expect(after.analyze.consumed).toBe(0)
    })

    it("رزروِ در جریان و پس از complete واقعاً مصرف‌شده حساب می‌شود", async () => {
        const { prisma, buckets } = makeFakePrisma({
            cutoverAt: CUTOVER_NEW,
            buckets: [{ feature: "ANALYZE", source: "BASE" }],
        })

        buckets.get(1)!.reservedUnits = 1
        expect((await readAiQuotaStatus(prisma, base)).analyze.remaining).toBe(14)

        // complete ⇒ رزرو به مصرف تبدیل می‌شود (remaining همچنان ۱۴، consumed ۱)
        buckets.get(1)!.reservedUnits = 0
        buckets.get(1)!.consumedUnits = 1
        const done = await readAiQuotaStatus(prisma, base)
        expect(done.analyze.remaining).toBe(14)
        expect(done.analyze.consumed).toBe(1)
    })
})

describe("readAiQuotaStatus — read-only", () => {
    it("هیچ متد نوشتنی صدا زده نمی‌شود", async () => {
        const writes: string[] = []
        const { prisma } = makeFakePrisma({ cutoverAt: CUTOVER_NEW })
        // هر delegate روی مدل‌ها را می‌پیچیم تا هر نوشتنی لو برود.
        const guard = (model: string, real: any) =>
            new Proxy(real, {
                get(target, prop: string) {
                    if (/^(create|update|updateMany|upsert|delete|deleteMany|createMany|updateManyAndReturn)$/.test(prop)) {
                        return (...args: any[]) => {
                            writes.push(`${model}.${prop}`)
                            return (target as any)[prop](...args)
                        }
                    }
                    return (target as any)[prop]
                },
            })

        const guarded: any = {
            aiQuotaCutover: guard("aiQuotaCutover", prisma.aiQuotaCutover),
            aiQuotaPolicy: guard("aiQuotaPolicy", prisma.aiQuotaPolicy),
            aiQuotaBucket: guard("aiQuotaBucket", prisma.aiQuotaBucket),
            aiUsage: guard("aiUsage", prisma.aiUsage),
        }

        await readAiQuotaStatus(guarded, base)

        expect(writes).toEqual([])
    })
})
