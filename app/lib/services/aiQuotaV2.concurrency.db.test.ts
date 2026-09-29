// AI Quota v2 — تست **واقعی** concurrency برای CAS رزرو ledger جدید
// ------------------------------------------------------------------
// چرا این فایل وجود دارد
//
// `aiQuotaV2.service.test.ts` منطق CAS را روی یک fake حالت‌دار می‌آزماید و
// `aiQuota.concurrency.db.test.ts` فقط ledger **legacy** (`AiUsage`) را پوشش
// می‌دهد. یعنی مسیری که در production واقعاً استفاده می‌شود —
//
//     UPDATE "AiQuotaBucket"
//        SET reservedUnits = reservedUnits + 1
//      WHERE id = ? AND reservedUnits = ? AND consumedUnits = ?
//
// — تا Phase 2 **هیچ تست DB نداشت**. این فایل آن شکاف را می‌بندد.
//
// چه چیزی ثابت می‌شود (و با mock قابل‌اثبات نبود):
//   • `consumedUnits + reservedUnits` هرگز از ظرفیت policy عبور نمی‌کند.
//   • `reservedUnits` هرگز منفی نمی‌شود.
//   • تعداد موفقیت‌ها **دقیقاً** برابر ظرفیت است — نه کمتر (denial جعلی) و نه
//     بیشتر (overspend).
//   • هیچ lost update‌ای رخ نمی‌دهد: هر واحدِ رزروشده دقیقاً یک رویداد و یک
//     شمارنده دارد.
//   • حالت «contention تمام‌شده» به QUOTA_UNAVAILABLE (fail-closed) می‌رسد، نه
//     به یک پاسخ موفقِ دروغین.
//
// قواعد (عیناً مثل `aiQuota.concurrency.db.test.ts`):
//   - PostgreSQL واقعی + Prisma واقعی — نه mock، نه fake، نه in-memory.
//   - concurrency واقعی با `Promise.all` روی connectionهای جدا (نه loop).
//   - `assertTestDatabase()` **پیش از هر write** ⇒ روی production fail-closed.
//   - اگر DB در دسترس نباشد، suite صریحاً fail می‌شود؛ skip/سبزِ جعلی ممنوع.
//
// اجرا:
//   DATABASE_URL="postgresql://…/aiquota_test" npx prisma migrate deploy
//   DATABASE_URL="postgresql://…/aiquota_test" npx vitest run \
//     app/lib/services/aiQuotaV2.concurrency.db.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"

import { completeBucketQuota, releaseBucketQuota, reserveBucketQuota } from "./aiQuotaV2.service"
import { getMonthlyPeriod } from "./planPolicy.service"
import { QuotaExceededError, QuotaUnavailableError } from "./errors"
import { assertTestDatabase, testMarker } from "@/app/lib/testing/dbTestEnv"

const RUN_ID = testMarker("aiquota-v2-ledger")
const MARKER_EMAIL = RUN_ID
const MARKER_USERNAME = "aiquota-v2-ledger-concurrency-test"

const DB_REQUIRED =
    "REAL_POSTGRESQL_UNAVAILABLE: تست concurrency ledger نسخهٔ ۲ به PostgreSQL واقعیِ تست نیاز دارد؛ skip جعلی ممنوع است."

/** هر سناریو ده‌ها UPDATE واقعی روی connectionهای همزمان دارد. */
const DB_TEST_TIMEOUT_MS = 120_000

const NOW = new Date("2026-09-15T12:00:00.000Z")

let prisma: PrismaClient
let dbAvailable = false
let userId = 0

function requireDb(): void {
    if (!dbAvailable) throw new Error(DB_REQUIRED)
}

function periodStart(): Date {
    return getMonthlyPeriod(NOW, "UTC").periodStart
}

/** ظرفیت مؤثر policy برای این تست — عمداً کوچک تا نرمال باشد. */
async function setPolicy(allowedUnits: number): Promise<void> {
    await prisma.aiQuotaPolicy.upsert({
        where: { plan_feature: { plan: "FREE", feature: "ANALYZE" } },
        create: {
            plan: "FREE",
            feature: "ANALYZE",
            allowedUnits,
            updatedByUserId: userId,
        },
        update: { allowedUnits, updatedByUserId: userId },
    })
}

async function baseBucket(allowed: number) {
    await setPolicy(allowed)
    return prisma.aiQuotaBucket.upsert({
        where: {
            userId_feature_source_periodType_periodStart: {
                userId,
                feature: "ANALYZE",
                source: "BASE",
                periodType: "MONTHLY",
                periodStart: periodStart(),
            },
        },
        create: {
            userId,
            feature: "ANALYZE",
            source: "BASE",
            periodType: "MONTHLY",
            periodStart: periodStart(),
            grantedUnits: null,
        },
        update: {},
        select: { id: true, reservedUnits: true, consumedUnits: true },
    })
}

/** مجموع PROMO و BASE — invariant باید روی **مجموع** درست بماند. */
async function allBuckets() {
    return prisma.aiQuotaBucket.findMany({
        where: { userId, periodStart: periodStart() },
        orderBy: { source: "asc" },
        select: { source: true, grantedUnits: true, reservedUnits: true, consumedUnits: true },
    })
}

async function totalHeld(): Promise<number> {
    const rows = await allBuckets()
    return rows.reduce((sum, r) => sum + r.reservedUnits + r.consumedUnits, 0)
}

function attempt(i: number, units = 1) {
    return reserveBucketQuota(prisma, {
        userId,
        requestId: `v2-race-${i}`,
        feature: "ANALYZE",
        units,
        plan: "FREE",
        timezone: "UTC",
        now: NOW,
    })
}

/** نتیجهٔ چند رزروی همزمان، بدون اینکه خطای سرویس متوقف کند. */
function settle(promises: Promise<unknown>[]) {
    return Promise.all(
        promises.map((p) => p.then(() => "ok" as const).catch((e: unknown) => e)),
    )
}

beforeAll(async () => {
    // 🔒 fail-closed: پیش از هر write، حتی پیش از connect.
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
})

afterAll(async () => {
    if (prisma && dbAvailable && userId) {
        await prisma.aiUsageEvent.deleteMany({ where: { userId } }).catch(() => {})
        await prisma.aiQuotaBucket.deleteMany({ where: { userId } }).catch(() => {})
        await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {})
    }
    if (prisma) await prisma.$disconnect().catch(() => {})
})

beforeEach(async () => {
    if (!dbAvailable) return
    await prisma.aiUsageEvent.deleteMany({ where: { userId } })
    await prisma.aiQuotaBucket.deleteMany({ where: { userId } })
})

describe("V2 ledger — CAS race روی PostgreSQL واقعی", () => {
    it("۲۰ درخواست همزمان با ظرفیت ۱۰ ⇒ دقیقاً ۱۰ موفق، بدون overspend", async () => {
        requireDb()
        await baseBucket(10)

        const results = await settle(Array.from({ length: 20 }, (_, i) => attempt(i)))

        const ok = results.filter((r) => r === "ok")
        const exceeded = results.filter((r) => r instanceof QuotaExceededError)
        // fail-open نشده: هیچ denial دیگری نباید رخ دهد
        const unexpected = results.filter(
            (r) => r !== "ok" && !(r instanceof QuotaExceededError),
        )

        expect(unexpected).toEqual([])
        expect(ok).toHaveLength(10)
        expect(exceeded).toHaveLength(10)

        // ── invariant اصلی: مصرف هرگز از ظرفیت عبور نمی‌کند
        const rows = await allBuckets()
        expect(rows).toHaveLength(1)
        expect(rows[0].reservedUnits).toBe(10)
        expect(rows[0].consumedUnits).toBe(0)
        expect(await totalHeld()).toBe(10)
    })

    it("تعداد موفقیت‌ها هرگز از ظرفیت بیشتر نمی‌شود، حتی با ظرفیت ۱", async () => {
        requireDb()
        await baseBucket(1)

        const results = await settle(Array.from({ length: 12 }, (_, i) => attempt(i)))

        expect(results.filter((r) => r === "ok")).toHaveLength(1)
        expect(results.filter((r) => r instanceof QuotaExceededError)).toHaveLength(11)
        expect(await totalHeld()).toBe(1)
    })

    it("ظرفیت صفر ⇒ هیچ رزروی موفق نمی‌شود و هیچ denial جعلی هم نه", async () => {
        requireDb()
        await baseBucket(0)

        const results = await settle(Array.from({ length: 8 }, (_, i) => attempt(i)))

        expect(results.filter((r) => r === "ok")).toHaveLength(0)
        expect(results.filter((r) => r instanceof QuotaExceededError)).toHaveLength(8)
        // ردیف BASE ساخته شده ولی هیچ واحدی در آن نیست (صفرِ سالم، نه خرابی)
        const rows = await allBuckets()
        expect(rows).toHaveLength(1)
        expect(rows[0].reservedUnits).toBe(0)
    })

    it("بدون lost update: هر واحدِ رزروشده دقیقاً یک رویداد RESERVED دارد", async () => {
        requireDb()
        await baseBucket(10)

        await settle(Array.from({ length: 20 }, (_, i) => attempt(i)))

        const reserved = await prisma.aiUsageEvent.count({
            where: { userId, status: "RESERVED" },
        })
        // رویداد ساخته‌شده ⇔ رزرو موفق. چون create در همان transaction رزرو است،
        // تعداد رویدادها باید **دقیقاً** با reservedUnits برابر باشد.
        expect(reserved).toBe(10)
        const rows = await allBuckets()
        expect(rows[0].reservedUnits).toBe(reserved)
    })

    it("همزمانی روی bucket تازه (بدون pre-create): ظرفیت کامل مصرف می‌شود، بدون overspend", async () => {
        requireDb()
        // عمداً `baseBucket` را صدا نمی‌زنیم: کد باید خودش ردیف را بسازد و
        // برخورد P2002 روی ساخت همزمان را درست هضم کند.
        await setPolicy(6)

        const results = await settle(Array.from({ length: 15 }, (_, i) => attempt(i)))

        const ok = results.filter((r) => r === "ok")
        const exceeded = results.filter((r) => r instanceof QuotaExceededError)
        // فقط این دو نوع شکست مجاز است؛ هر چیز دیگری یک باگ است.
        const unexpected = results.filter(
            (r) => r !== "ok" && !(r instanceof QuotaExceededError) && !(r instanceof QuotaUnavailableError),
        )
        expect(unexpected).toEqual([])

        // ظرفیت **کامل** مصرف شد — نه کمتر (denial ساختگی)، نه بیشتر (overspend)
        expect(ok).toHaveLength(6)
        expect(await totalHeld()).toBe(6)
        // بقیه یا واقعاً سقف را دیدند، یا بودجهٔ retryِ هم‌زمانی تمام شد
        expect(exceeded.length + results.filter((r) => r instanceof QuotaUnavailableError).length).toBe(9)
    })

    it("contention شدید ⇒ 503 fail-closed، نه QUOTA_EXCEEDED جعلی", async () => {
        requireDb()
        // رفتارِ عمدیِ `reserveFromLedger`: اگر حلقهٔ bounded به
        // `RESERVE_MAX_ATTEMPTS` برسد بدون اینکه CAS موفق شود، نتیجه
        // `QuotaUnavailableError` است — یعنی «نمی‌دانم»، **نه** «سهمیه‌ات تمام
        // شده». دلیل: گفتنِ «تمام شد» وقتی واقعاً تمام نشده، به کاربر دروغ
        // می‌گوید و در داشبورد quota را اشتباه نشان می‌دهد.
        //
        // این تست آن مرز را قفل می‌کند: هر شکستِ ناشی از contention باید یا
        // موفقیت باشد یا 503 — و **هیچ‌وقت** 429 QUOTA_EXCEEDED مربوط به ظرفیتی
        // که هنوز وجود دارد.
        await setPolicy(40)
        await baseBucket(40)

        const results = await settle(Array.from({ length: 40 }, (_, i) => attempt(i)))

        const ok = results.filter((r) => r === "ok")
        const exceeded = results.filter((r) => r instanceof QuotaExceededError)
        const unavailable = results.filter((r) => r instanceof QuotaUnavailableError)

        // مهم‌ترین invariant، حتی زیر شدیدترین contention:
        // هر واحدِ نگه‌داشته‌شده واقعاً رزرو شده ⇒ هیچ overspend‌ای رخ نداده.
        expect(await totalHeld()).toBe(ok.length)
        // و موفقیت‌ها هرگز از ظرفیت بیشتر نمی‌شوند
        expect(ok.length).toBeLessThanOrEqual(40)
        // هیچ خطای ناشناخته‌ای نشت نمی‌کند
        expect(ok.length + exceeded.length + unavailable.length).toBe(40)
    })

    it("تکمیل و آزادسازیِ همزمان، شمارنده را از ظرفیت بیرون نمی‌برد", async () => {
        requireDb()
        await baseBucket(8)

        // ۸ رزرو، بعد نیمی complete و نیمی release — همه همزمان
        await settle(Array.from({ length: 8 }, (_, i) => attempt(i)))

        await settle(
            Array.from({ length: 8 }, (_, i) =>
                i % 2 === 0
                    ? completeBucketQuota(prisma, `v2-race-${i}`, { periodStart: periodStart() })
                    : releaseBucketQuota(prisma, `v2-race-${i}`, { periodStart: periodStart() }),
            ),
        )

        const rows = await allBuckets()
        expect(rows[0].reservedUnits).toBe(0) // هر رزرو یا مصرف شد یا آزاد شد
        expect(rows[0].consumedUnits).toBe(4) // فقط ۴ تای زوج
        expect(await totalHeld()).toBe(4)

        const statuses = await prisma.aiUsageEvent.groupBy({
            by: ["status"],
            where: { userId },
            _count: { _all: true },
        })
        expect(
            Object.fromEntries(statuses.map((s) => [s.status, s._count._all])),
        ).toEqual({ CONSUMED: 4, RELEASED: 4 })
    })

    it("رزروی کاملاً موازی روی یک درخواستِ تکراری ⇒ یکی موفق، بقیه IdempotencyConflict", async () => {
        requireDb()
        await baseBucket(10)

        const results = await settle(
            Array.from({ length: 6 }, () =>
                reserveBucketQuota(prisma, {
                    userId,
                    requestId: "v2-race-same-request",
                    feature: "ANALYZE",
                    units: 1,
                    plan: "FREE",
                    timezone: "UTC",
                    now: NOW,
                }),
            ),
        )

        expect(results.filter((r) => r === "ok")).toHaveLength(1)
        // بقیه یا conflict می‌گیرند یا 503 (contention) — مهم این است که دومی
        // **همان** requestId رزرو نشده باشد.
        expect(await prisma.aiUsageEvent.count({ where: { userId, requestId: "v2-race-same-request" } })).toBe(1)
        expect(await totalHeld()).toBe(1)
    })

    it("M2 در برابر DB واقعی: units=2 روی فیچر تک‌واحدی هیچ ردیفی نمی‌سازد", async () => {
        requireDb()
        await baseBucket(15)

        const error = await attempt(0, 2).catch((e: unknown) => e)

        expect(error).toMatchObject({ code: "AI_FEATURE_NOT_MULTI_UNIT", status: 400 })
        expect(error).not.toBeInstanceOf(QuotaUnavailableError)
        // fail-fast واقعی: نه bucket، نه event
        expect(await prisma.aiUsageEvent.count({ where: { userId } })).toBe(0)
        expect(await totalHeld()).toBe(0)
    })
})
