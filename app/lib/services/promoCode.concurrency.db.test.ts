// AI Quota v2 — تست integration/concurrency واقعی Promo Code با PostgreSQL واقعی
//
// قواعد (عیناً مثل `aiQuota.concurrency.db.test.ts`):
// - PostgreSQL واقعی + Prisma واقعی — نه mock، نه fake، نه in-memory.
// - concurrency واقعی با Promiseهای همزمان (نه loop) روی connectionهای جدا.
// - هر تست کاربر/داده‌ی اختصاصی دارد؛ هیچ رکورد موجودی لمس نمی‌شود.
// - cleanup همیشه در finally؛ داده‌ی تستی هرگز با production قاطی نمی‌شود.
// - اگر DB تست در دسترس نباشد، suite **fail-closed** می‌شود (نه skip جعلی).
//
// سناریوهایی که فقط اینجا معنا دارند (mock آن‌ها را بی‌معنا می‌کند):
//   • ضدتکرار «هم‌زمان» — چند درخواستِ نزدیکاً-همزمانِ یک کاربر برای یک کد.
//   • سقف maxRedemptions زیر contention واقعی.
//   • جمع اتمیک grantedUnits وقتی چند promo متفاوت هم‌زمان redeem می‌شوند.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"

import {
    createPromoCode,
    PromoAlreadyRedeemedError,
    PromoCodeInvalidError,
    redeemPromoCode,
} from "./promoCode.service"
import { getMonthlyPeriod } from "./planPolicy.service"
import { assertTestDatabase, newTestRunId, testMarker } from "@/app/lib/testing/dbTestEnv"

const RUN_ID = testMarker("aiquota-v2-promo")
const MARKER_EMAIL = RUN_ID
const MARKER_USERNAME = "aiquota-v2-promo-concurrency-test"

/**
 * پسوند یکتای **هر اجرا** برای کدهای promo.
 *
 * چرا لازم است: `PromoCode.code` یکتای سراسری است. کدهای ثابتِ قبلی («SEQ-DUP»،
 * «CONC-CAP»، …) یعنی یک اجرای نیمه‌کاره (قطع پروسه، kill، خطای شبکه) ردیف‌های
 * یتیم می‌گذاشت و **اجرای بعدی را با P2002 می‌شکست** — برای همیشه، تا وقتی دستی
 * پاک می‌شد. با پسوند اجرا، اجرای بعدی کد کاملاً تازه می‌سازد و هیچ برخوردی رخ
 * نمی‌دهد؛ cleanup هم فقط ردیف‌های همین اجرا را هدف می‌گیرد.
 *
 * کد نرمال‌سازی می‌شود (trim + UPPER) و باید ۳ تا ۶۴ نویسه باشد، پس پسوند فقط
 * از حروف/اعداد ساخته می‌شود و کوتاه است.
 */
const CODE_RUN_SUFFIX = newTestRunId().replace(/[^a-zA-Z0-9]/g, "").slice(0, 10).toUpperCase()

/** کد یکتای این اجرا برای یک برچسب سناریو. */
function codeFor(label: string): string {
    return `${label}-${CODE_RUN_SUFFIX}`.toUpperCase()
}

const DB_REQUIRED =
    "REAL_POSTGRESQL_UNAVAILABLE: تست promo concurrency به PostgreSQL واقعیِ تست نیاز دارد؛ skip جعلی ممنوع است."

/** چند ثانیه: هر سناریو چندین round-trip واقعی و چند Promise هم‌زمان دارد. */
const DB_TEST_TIMEOUT_MS = 60_000

const NOW = new Date("2026-09-15T12:00:00.000Z")
const VALID_FROM = new Date("2026-09-01T00:00:00.000Z")
const EXPIRES_AT = new Date("2026-10-01T00:00:00.000Z")

let prisma: PrismaClient
let dbAvailable = false
let userId = 0
let otherUserId = 0
const createdPromoIds: string[] = []

function requireDb(): void {
    if (!dbAvailable) throw new Error(DB_REQUIRED)
}

function periodStart(): Date {
    return getMonthlyPeriod(NOW, "UTC").periodStart
}

async function makePromo(
    code: string,
    opts: { maxRedemptions?: number | null; analyze?: number; plan?: number; expiresAt?: Date } = {},
) {
    const promo = await createPromoCode(prisma, {
        code,
        validFrom: VALID_FROM,
        expiresAt: opts.expiresAt ?? EXPIRES_AT,
        maxRedemptions: opts.maxRedemptions ?? null,
        bonusAnalyzeUnits: opts.analyze ?? 0,
        bonusPlanUnits: opts.plan ?? 0,
        actorUserId: userId,
    })
    createdPromoIds.push(promo.id)
    return promo
}

async function promoBucket(feature: "ANALYZE" | "PLAN", forUser = userId) {
    return prisma.aiQuotaBucket.findUnique({
        where: {
            userId_feature_source_periodType_periodStart: {
                userId: forUser,
                feature,
                source: "PROMO",
                periodType: "MONTHLY",
                periodStart: periodStart(),
            },
        },
        select: { grantedUnits: true, reservedUnits: true, consumedUnits: true },
    })
}

/** نتیجهٔ چند redeem هم‌زمان، بدون اینکه خطای سرویس پرتاب شود. */
function settle(promises: Promise<unknown>[]) {
    return Promise.all(
        promises.map((p) => p.then(() => "ok" as const).catch((e: unknown) => e)),
    )
}

beforeAll(async () => {
    // 🔒 fail-closed: پیش از هر write. روی مقصد پروداکشن همین‌جا متوقف می‌شود.
    assertTestDatabase()

    prisma = new PrismaClient()
    try {
        await prisma.$queryRaw`SELECT 1`
        dbAvailable = true
    } catch {
        dbAvailable = false
    }
    if (!dbAvailable) return

    await prisma.user.deleteMany({
        where: { OR: [{ email: MARKER_EMAIL }, { username: MARKER_USERNAME }] },
    })

    const user = await prisma.user.create({
        data: {
            email: MARKER_EMAIL,
            username: MARKER_USERNAME,
            password: "not-a-real-login",
            timezone: "UTC",
            plan: "FREE",
        },
        select: { id: true },
    })
    userId = user.id

    // کاربر دوم: لازم است تا «سقف سراسری» با «یک‌بار-برای-هر-کاربر» اشتباه نشود
    const other = await prisma.user.create({
        data: {
            email: `${RUN_ID}-2`,
            username: `${MARKER_USERNAME}-2`,
            password: "not-a-real-login",
            timezone: "UTC",
            plan: "FREE",
        },
        select: { id: true },
    })
    otherUserId = other.id
})

afterAll(async () => {
    if (prisma && dbAvailable) {
        for (const id of createdPromoIds) {
            // PromoRedemption با onDelete: Restrict به PromoCode وصل است ⇒ اول آن‌ها
            await prisma.promoRedemption.deleteMany({ where: { promoCodeId: id } }).catch(() => {})
            await prisma.promoCode.deleteMany({ where: { id } }).catch(() => {})
        }
        for (const id of [userId, otherUserId]) {
            if (!id) continue
            await prisma.aiUsageEvent.deleteMany({ where: { userId: id } }).catch(() => {})
            await prisma.aiQuotaBucket.deleteMany({ where: { userId: id } }).catch(() => {})
            await prisma.user.deleteMany({ where: { id } }).catch(() => {})
        }
    }
    if (prisma) await prisma.$disconnect().catch(() => {})
})

beforeEach(async () => {
    if (!dbAvailable) return
    await prisma.promoRedemption.deleteMany({ where: { userId: { in: [userId, otherUserId] } } })
    await prisma.aiQuotaBucket.deleteMany({ where: { userId: { in: [userId, otherUserId] } } })
    await prisma.adminAuditLog.deleteMany({ where: { actorUserId: { in: [userId, otherUserId] } } })
})

describe("promoCode — real PostgreSQL integration/concurrency", () => {
    /* ------------------------------------------------------------------ */
    /* ضدتکرار                                                            */
    /* ------------------------------------------------------------------ */

    it("ریدیمپشن ترتیبی تکراری ⇒ فقط یک ریدیمپشن و یک grant", async () => {
        requireDb()
        const promo = await makePromo(codeFor("SEQ-DUP"), { analyze: 5 })

        await redeemPromoCode(prisma, { userId, code: codeFor("SEQ-DUP"), timezone: "UTC", now: NOW })
        await expect(
            redeemPromoCode(prisma, { userId, code: codeFor("SEQ-DUP"), timezone: "UTC", now: NOW }),
        ).rejects.toBeInstanceOf(PromoAlreadyRedeemedError)

        expect(await prisma.promoRedemption.count({ where: { userId, promoCodeId: promo.id } })).toBe(1)
        expect(await promoBucket("ANALYZE")).toMatchObject({ grantedUnits: 5 })
    })

    it("ریدیمپشن هم‌زمانِ همان کد توسط همان کاربر ⇒ دقیقاً یکی موفق", async () => {
        requireDb()
        const promo = await makePromo(codeFor("CONC-DUP"), { analyze: 5 })

        const results = await settle(
            Array.from({ length: 8 }, () =>
                redeemPromoCode(prisma, { userId, code: codeFor("CONC-DUP"), timezone: "UTC", now: NOW }),
            ),
        )

        const ok = results.filter((r) => r === "ok")
        expect(ok).toHaveLength(1)
        expect(
            results.filter((r) => r instanceof PromoAlreadyRedeemedError),
        ).toHaveLength(7)

        // اثر: نه شمارنده بالا رفته، نه بونوس دوباره اضافه شده
        expect(await prisma.promoCode.findUnique({ where: { id: promo.id }, select: { redeemedCount: true } })).toEqual({
            redeemedCount: 1,
        })
        expect(await prisma.promoRedemption.count({ where: { userId, promoCodeId: promo.id } })).toBe(1)
        expect(await promoBucket("ANALYZE")).toMatchObject({ grantedUnits: 5 })
    })

    /* ------------------------------------------------------------------ */
    /* سقف maxRedemptions                                                 */
    /* ------------------------------------------------------------------ */

    it("۵ کاربرِ مختلف هم‌زمان روی کدی با سقف ۳ ⇒ شمارنده هرگز از ۳ عبور نمی‌کند", async () => {
        requireDb()
        const promo = await makePromo(codeFor("CONC-CAP"), { maxRedemptions: 3, analyze: 4 })

        const users = await Promise.all(
            Array.from({ length: 5 }, async (_, i) => {
                const u = await prisma.user.create({
                    data: {
                        email: `${RUN_ID}-cap-${i}`,
                        username: `${MARKER_USERNAME}-cap-${i}`,
                        password: "x",
                        timezone: "UTC",
                        plan: "FREE",
                    },
                    select: { id: true },
                })
                return u.id
            }),
        )

        try {
            const results = await settle(
                users.map((uid) =>
                    redeemPromoCode(prisma, { userId: uid, code: codeFor("CONC-CAP"), timezone: "UTC", now: NOW }),
                ),
            )

            const ok = results.filter((r) => r === "ok").length
            // سقف تمام عمداً همان پاسخ عمومی «کد نامعتبر» را می‌گیرد (ضد-enumeration)،
            // پس ۲ باقی‌مانده خطای یکسان می‌بینند — نه یک کدِ افشاگرِ جدا.
            const generic = results.filter((r) => r instanceof PromoCodeInvalidError).length

            expect(ok).toBe(3)
            expect(generic).toBe(2)
            // و دلیل واقعی فقط سمت سرور ثبت شده است
            expect(
                await prisma.adminAuditLog.count({
                    where: {
                        action: "promo.redeem_rejected",
                        actorUserId: { in: users },
                        after: { path: ["reason"], equals: "EXHAUSTED" },
                    },
                }),
            ).toBe(2)
            expect(
                await prisma.promoCode.findUnique({ where: { id: promo.id }, select: { redeemedCount: true } }),
            ).toEqual({ redeemedCount: 3 })
            expect(await prisma.promoRedemption.count({ where: { promoCodeId: promo.id } })).toBe(3)
        } finally {
            await prisma.promoRedemption.deleteMany({ where: { userId: { in: users } } })
            await prisma.aiQuotaBucket.deleteMany({ where: { userId: { in: users } } })
            await prisma.user.deleteMany({ where: { id: { in: users } } })
        }
    })

    it("سقف نامحدود ⇒ شمارنده فقط به تعداد کاربران واقعی می‌رسد", async () => {
        requireDb()
        const promo = await makePromo(codeFor("CONC-NOCAP"), { maxRedemptions: null, analyze: 1 })

        await Promise.all([
            redeemPromoCode(prisma, { userId, code: codeFor("CONC-NOCAP"), timezone: "UTC", now: NOW }),
            redeemPromoCode(prisma, { userId: otherUserId, code: codeFor("CONC-NOCAP"), timezone: "UTC", now: NOW }),
        ])

        expect(
            await prisma.promoCode.findUnique({ where: { id: promo.id }, select: { redeemedCount: true } }),
        ).toEqual({ redeemedCount: 2 })
    })

    /* ------------------------------------------------------------------ */
    /* grant اتمیک روی چند promo مختلفِ هم‌زمانِ یک کاربر                 */
    /* ------------------------------------------------------------------ */

    it("سه promo متفاوتِ هم‌زمان ⇒ grantedUnits دقیقاً مجموع بونوس‌هاست (بدون lost update)", async () => {
        requireDb()
        await makePromo(codeFor("MULTI-A"), { analyze: 3 })
        await makePromo(codeFor("MULTI-B"), { analyze: 4 })
        await makePromo(codeFor("MULTI-C"), { analyze: 5 })

        const results = await settle(
            [codeFor("MULTI-A"), codeFor("MULTI-B"), codeFor("MULTI-C")].map((code) =>
                redeemPromoCode(prisma, { userId, code, timezone: "UTC", now: NOW }),
            ),
        )

        expect(results.filter((r) => r === "ok")).toHaveLength(3)
        // ۳ + ۴ + ۵ = ۱۲. اگر حتی یک lost update رخ داده باشد، عدد کمتر می‌شود.
        expect(await promoBucket("ANALYZE")).toMatchObject({ grantedUnits: 12 })
    })

    it("همان سه promo، هم‌زمان و تکراری ⇒ باز هم هر کد فقط یک‌بار اثر می‌گذارد", async () => {
        requireDb()
        await makePromo(codeFor("MULTI2-A"), { analyze: 2 })
        await makePromo(codeFor("MULTI2-B"), { analyze: 6 })

        const results = await settle([
            redeemPromoCode(prisma, { userId, code: codeFor("MULTI2-A"), timezone: "UTC", now: NOW }),
            redeemPromoCode(prisma, { userId, code: codeFor("MULTI2-A"), timezone: "UTC", now: NOW }),
            redeemPromoCode(prisma, { userId, code: codeFor("MULTI2-B"), timezone: "UTC", now: NOW }),
            redeemPromoCode(prisma, { userId, code: codeFor("MULTI2-B"), timezone: "UTC", now: NOW }),
        ])

        expect(results.filter((r) => r === "ok")).toHaveLength(2)
        expect(await promoBucket("ANALYZE")).toMatchObject({ grantedUnits: 8 })
    })

    /* ------------------------------------------------------------------ */
    /* استقلال per-feature و بقای بونوس بعد از انقضای کد                */
    /* ------------------------------------------------------------------ */

    it("بونوس ANALYZE و PLAN در bucketهای جدا و مستقل می‌نشینند", async () => {
        requireDb()
        await makePromo(codeFor("SPLIT-FEAT"), { analyze: 5, plan: 2 })

        await redeemPromoCode(prisma, { userId, code: codeFor("SPLIT-FEAT"), timezone: "UTC", now: NOW })

        expect(await promoBucket("ANALYZE")).toMatchObject({ grantedUnits: 5 })
        expect(await promoBucket("PLAN")).toMatchObject({ grantedUnits: 2 })
    })

    it("بونوسِ زمانِ redeem پس از انقضای کد هم در DB باقی می‌ماند", async () => {
        requireDb()
        // کدی که تا همین لحظه معتبر بوده و حالا منقضی شده است
        const promo = await makePromo(codeFor("EXPIRED-AFTER"), {
            analyze: 9,
            expiresAt: new Date("2026-09-10T00:00:00.000Z"),
        })
        // redeem در زمانی که هنوز داخل پنجره بوده
        await redeemPromoCode(prisma, {
            userId,
            code: codeFor("EXPIRED-AFTER"),
            timezone: "UTC",
            now: new Date("2026-09-09T00:00:00.000Z"),
        })

        // حالا کد منقضی شده و ریدیمپشن/بونوس باید سالم مانده باشند
        expect(
            await prisma.promoRedemption.findFirst({
                where: { userId, promoCodeId: promo.id },
                select: { bonusAnalyzeUnits: true, bonusPlanUnits: true },
            }),
        ).toEqual({ bonusAnalyzeUnits: 9, bonusPlanUnits: 0 })
        expect(await promoBucket("ANALYZE")).toMatchObject({ grantedUnits: 9 })

        // و ریدیمپشن دوباره‌ی همان کد ممکن نیست.
        //
        // نکتهٔ ضد-enumeration: چون کد حالا **منقضی** است، پاسخ عمومی
        // `PROMO_CODE_INVALID` می‌آید، نه `PROMO_ALREADY_REDEEMED`. گفتنِ
        // «قبلاً استفاده کرده‌اید» برای یک کدِ منقضی عملاً وجودِ کد را افشا
        // می‌کرد — دقیقاً همان چیزی که این تصمیم حذفش کرده. ترتیب بررسی‌ها
        // عمداً «پنجرهٔ اعتبار، قبل از ضدتکرار» است.
        await expect(
            redeemPromoCode(prisma, { userId, code: codeFor("EXPIRED-AFTER"), timezone: "UTC", now: NOW }),
        ).rejects.toBeInstanceOf(PromoCodeInvalidError)
    })

    it("تغییر بونوس کد پس از ریدیمپشن، snapshot ریدیمپشن و grant را عوض نمی‌کند", async () => {
        requireDb()
        const promo = await makePromo(codeFor("SNAPSHOT"), { analyze: 5 })

        await redeemPromoCode(prisma, { userId, code: codeFor("SNAPSHOT"), timezone: "UTC", now: NOW })

        // ادمین بونوس کد را عوض می‌کند
        await prisma.promoCode.update({
            where: { id: promo.id },
            data: { bonusAnalyzeUnits: 100 },
        })

        expect(
            await prisma.promoRedemption.findFirst({
                where: { userId, promoCodeId: promo.id },
                select: { bonusAnalyzeUnits: true },
            }),
        ).toEqual({ bonusAnalyzeUnits: 5 })
        expect(await promoBucket("ANALYZE")).toMatchObject({ grantedUnits: 5 })
    })

    /* ------------------------------------------------------------------ */
    /* rollback                                                           */
    /* ------------------------------------------------------------------ */

    it("شکست grant ⇒ PostgreSQL واقعاً rollback می‌کند (هیچ رد پا نمی‌ماند)", async () => {
        requireDb()
        const promo = await makePromo(codeFor("ROLLBACK"), { analyze: 3 })

        // همه‌ی کارها واقعی‌اند؛ فقط عملیات grant را در همان transaction عمداً
        // می‌شکنیم. استثنا از callback عبور می‌کند ⇒ Prisma ROLLBACK واقعی می‌فرستد،
        // پس اگر rollback خراب بود، `redeemedCount` بالا رفته و ریدیمپشن مانده بود.
        const original = prisma.$transaction.bind(prisma)
        ;(prisma as any).$transaction = async (fn: (tx: unknown) => Promise<unknown>) =>
            original(async (tx: any) => {
                const poisoned = new Proxy(tx, {
                    get(target, prop) {
                        if (prop === "aiQuotaBucket") {
                            return {
                                ...(target as any).aiQuotaBucket,
                                upsert: async () => {
                                    throw new Error("simulated grant failure")
                                },
                            }
                        }
                        return (target as any)[prop]
                    },
                })
                return fn(poisoned)
            })

        try {
            await expect(
                redeemPromoCode(prisma, { userId, code: codeFor("ROLLBACK"), timezone: "UTC", now: NOW }),
            ).rejects.toBeTruthy()
        } finally {
            ;(prisma as any).$transaction = original
        }

        // هیچ‌چیز نباید مانده باشد
        expect(
            await prisma.promoCode.findUnique({ where: { id: promo.id }, select: { redeemedCount: true } }),
        ).toEqual({ redeemedCount: 0 })
        expect(await prisma.promoRedemption.count({ where: { userId, promoCodeId: promo.id } })).toBe(0)
        expect(await promoBucket("ANALYZE")).toBeNull()
    })

    it("grant روی bucket از قبل موجود کار می‌کند و ریدیمپشن دوباره ساخته نمی‌شود", async () => {
        requireDb()
        const promo = await makePromo(codeFor("EXISTING-BUCKET"), { analyze: 3 })

        await prisma.aiQuotaBucket.create({
            data: {
                userId,
                feature: "ANALYZE",
                source: "PROMO",
                periodType: "MONTHLY",
                periodStart: periodStart(),
                grantedUnits: 0,
            },
        })

        await expect(
            redeemPromoCode(prisma, { userId, code: codeFor("EXISTING-BUCKET"), timezone: "UTC", now: NOW }),
        ).resolves.toBeTruthy()

        expect(
            await prisma.promoCode.findUnique({ where: { id: promo.id }, select: { redeemedCount: true } }),
        ).toEqual({ redeemedCount: 1 })
        expect(await prisma.promoRedemption.count({ where: { userId, promoCodeId: promo.id } })).toBe(1)
        expect(await promoBucket("ANALYZE")).toMatchObject({ grantedUnits: 3 })
    })
})
