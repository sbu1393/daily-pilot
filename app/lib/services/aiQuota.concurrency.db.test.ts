// فاز ۱ — D5: تست integration/concurrency واقعی کووتا با PostgreSQL واقعی (سند §25/§32/§9)
//
// منبع الزام: Phase 1 §25 «Integration tests با PostgreSQL واقعی» + «Concurrency با mock کافی نیست»
// و §32 DoD «real PostgreSQL integration tests / concurrency».
//
// قواعد (عیناً مثل الگوی موجود `userActivity.concurrency.db.test.ts`):
// - PostgreSQL واقعی + Prisma واقعی — نه mock، نه fake، نه in-memory.
// - concurrency واقعی با Promiseهای همزمان (نه loop).
// - هر تست user/داده‌ی اختصاصی دارد؛ هیچ رکورد موجودی لمس نمی‌شود.
// - cleanup همیشه در finally؛ داده‌ی تستی با production قاطی نمی‌شود.
// - اگر DB در دسترس نباشد، تست با پیام صریح REAL_POSTGRESQL_UNAVAILABLE fail می‌شود.
//   skip جعلی / سبزِ جعلی / mock-به‌جای-DB ممنوع است (سند §25).
//
// نکته‌ی اجرا: این فایل بخشی از `npm test` است (vitest.config.ts → app/**/*.test.ts).
// پس `npm test` به PostgreSQL واقعی وابسته است و بدون آن این فایل عمداً fail می‌شود.
// اجرای صریح تکی: `npx vitest run app/lib/services/aiQuota.concurrency.db.test.ts`

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { PrismaClient } from "@prisma/client"

import {
    completeQuota,
    releaseQuota,
    reserveQuota,
} from "./aiQuota.service"
import { markReleaseFailed } from "./aiUsage.service"
import { getMonthlyPeriod } from "./planPolicy.service"
import {
    IdempotencyConflictError,
    QuotaExceededError,
    QuotaUnavailableError,
} from "./errors"

// --- route imports برای سناریوی production guard §16 باید mock شوند تا ماژول لود شود ---
// (در production guard هیچ‌کدام از این‌ها فراخوانی نمی‌شوند؛ صرفاً import-time safety)
vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: vi.fn() }))
vi.mock("@/app/lib/rateLimit", () => ({ isRateLimited: vi.fn(() => false) }))
vi.mock("@/app/lib/services/analysis.service", () => ({ runAiSamples: vi.fn() }))

/** marker اختصاصی Phase 1 quota — هرگز به داده‌ی واقعی دست نمی‌زند. */
const MARKER_EMAIL = "phase1-quota-concurrency-test@quota.internal"
const MARKER_USERNAME = "phase1-quota-concurrency-test"

const FREE_ALLOWED_UNITS = 15 // §5
const AI_TEST_UNITS = 3 // §16

const DB_REQUIRED =
    "REAL_POSTGRESQL_UNAVAILABLE: تست quota concurrency به PostgreSQL واقعی نیاز دارد؛ skip جعلی ممنوع است (Phase 1 §25)."

/**
 * تایم‌اوت اختصاصی این suite: هر تست چندین round-trip واقعی DB دارد
 * (مثلاً سناریوی «exact limit» = ۱۶ رزرو متوالی). پیش‌فرض ۵ ثانیه‌ی vitest
 * برای integration واقعی کافی نیست — این یک محدودیت runner است، نه شکست منطق.
 */
const DB_TEST_TIMEOUT_MS = 30_000

let prisma: PrismaClient
let dbAvailable = false
let userId = 0

/** هر تست باید صریحاً fail شود وقتی DB نیست — نه skip، نه جعلی. */
function requireDb(): void {
    if (!dbAvailable) throw new Error(DB_REQUIRED)
}

/** ردیف‌های quota کاربر تست را پاک می‌کند تا هر تست از حالت تمیز شروع شود. */
async function resetQuotaRows(): Promise<void> {
    await prisma.aiUsageEvent.deleteMany({ where: { userId } })
    await prisma.aiUsage.deleteMany({ where: { userId } })
}

/** aggregate ردیف‌های quota کاربر — برای اثبات invariant «no overspend». */
async function usageRows() {
    return prisma.aiUsage.findMany({
        where: { userId },
        select: { periodStart: true, reservedUnits: true, consumedUnits: true },
        orderBy: { periodStart: "asc" },
    })
}

async function periodRow(periodStart: Date) {
    return prisma.aiUsage.findUnique({
        where: {
            userId_periodType_periodStart: { userId, periodType: "MONTHLY", periodStart },
        },
        select: { reservedUnits: true, consumedUnits: true },
    })
}

async function eventRow(requestId: string) {
    return prisma.aiUsageEvent.findUnique({
        where: { requestId },
        select: { status: true, failureCode: true, units: true },
    })
}

function codeOf(error: unknown): string | undefined {
    return (error as { code?: string } | undefined)?.code
}

beforeAll(async () => {
    prisma = new PrismaClient()
    try {
        await prisma.$queryRaw`SELECT 1`
        dbAvailable = true
    } catch {
        dbAvailable = false
    }

    if (!dbAvailable) return

    // پاک‌سازی باقی‌مانده‌ی اجراهای قبلی (cascade ردیف‌های quota را هم حذف می‌کند)
    await prisma.user.deleteMany({
        where: { OR: [{ email: MARKER_EMAIL }, { username: MARKER_USERNAME }] },
    })

    const user = await prisma.user.create({
        data: {
            email: MARKER_EMAIL,
            username: MARKER_USERNAME,
            password: "not-a-real-login", // ورود از این مسیر نیست؛ هش واقعی لازم نیست
            timezone: "UTC",
            plan: "FREE",
        },
        select: { id: true },
    })
    userId = user.id
})

afterAll(async () => {
    if (prisma && dbAvailable && userId) {
        // cleanup صریح (cascade) — هرگز داده‌ی تستی باقی نمی‌ماند
        await prisma.aiUsageEvent.deleteMany({ where: { userId } }).catch(() => {})
        await prisma.aiUsage.deleteMany({ where: { userId } }).catch(() => {})
        await prisma.user.deleteMany({ where: { id: userId, email: MARKER_EMAIL } }).catch(() => {})
    }
    if (prisma) await prisma.$disconnect().catch(() => {})
})

beforeEach(async () => {
    if (!dbAvailable) return
    await resetQuotaRows()
})

describe("aiQuota — real PostgreSQL integration/concurrency (Phase 1 §25/§32)", () => {
    /* ------------------------------------------------------------------ */
    /* 1–3) under / exact / over limit + all-or-nothing                    */
    /* ------------------------------------------------------------------ */

    it("under limit: reserves the requested units and records them on the period row", async () => {
        requireDb()
        const { periodStart } = getMonthlyPeriod(new Date("2026-09-15T12:00:00Z"))

        await reserveQuota(prisma, {
            userId,
            requestId: "d5-under-1",
            allowedUnits: FREE_ALLOWED_UNITS,
            units: 1,
            feature: "analyze",
            periodStart,
        })

        expect(await periodRow(periodStart)).toEqual({ reservedUnits: 1, consumedUnits: 0 })
        expect(await eventRow("d5-under-1")).toMatchObject({ status: "RESERVED", units: 1 })
    })

    it("exact limit: grants exactly allowedUnits and denies the next unit (§8)", async () => {
        requireDb()
        const { periodStart } = getMonthlyPeriod(new Date("2026-09-15T12:00:00Z"))

        for (let i = 0; i < FREE_ALLOWED_UNITS; i++) {
            await reserveQuota(prisma, {
                userId,
                requestId: `d5-exact-${i}`,
                allowedUnits: FREE_ALLOWED_UNITS,
                units: 1,
                feature: "analyze",
                periodStart,
            })
        }

        expect(await periodRow(periodStart)).toEqual({
            reservedUnits: FREE_ALLOWED_UNITS,
            consumedUnits: 0,
        })

        await expect(
            reserveQuota(prisma, {
                userId,
                requestId: "d5-exact-overflow",
                allowedUnits: FREE_ALLOWED_UNITS,
                units: 1,
                feature: "analyze",
                periodStart,
            }),
        ).rejects.toBeInstanceOf(QuotaExceededError)
    })

    it("over limit: rejects and leaves NO partial reservation behind (all-or-nothing, §8/§10)", async () => {
        requireDb()
        const { periodStart } = getMonthlyPeriod(new Date("2026-09-15T12:00:00Z"))

        await expect(
            reserveQuota(prisma, {
                userId,
                requestId: "d5-over-1",
                allowedUnits: 5,
                units: 6,
                feature: "analyze",
                periodStart,
            }),
        ).rejects.toBeInstanceOf(QuotaExceededError)

        // transaction rollback → نه event، نه increment
        expect(await eventRow("d5-over-1")).toBeNull()
        expect(await periodRow(periodStart)).toEqual({ reservedUnits: 0, consumedUnits: 0 })
    })

    /* ------------------------------------------------------------------ */
    /* 4) concurrent reservation + invariant no overspend (P1-4 / §9)      */
    /* ------------------------------------------------------------------ */

    it("concurrent reservation: never overspends and accounts every granted unit (P1-4 CAS retry under real load)", async () => {
        requireDb()
        const { periodStart } = getMonthlyPeriod(new Date("2026-09-15T12:00:00Z"))

        const ALLOWED = 5
        const CONCURRENCY = 8

        const results = await Promise.allSettled(
            Array.from({ length: CONCURRENCY }, (_, i) =>
                reserveQuota(prisma, {
                    userId,
                    requestId: `d5-conc-${i}`,
                    allowedUnits: ALLOWED,
                    units: 1,
                    feature: "analyze",
                    periodStart,
                }),
            ),
        )

        const granted = results.filter((r) => r.status === "fulfilled").length
        const failures = results.filter((r) => r.status === "rejected")
        const failureCodes = failures.map((r) =>
            codeOf((r as PromiseRejectedResult).reason),
        )

        // هر شکست باید typed باشد: یا ظرفیت تمام شده، یا exhaustion سمت امن (P1-4 deviation مصوب)
        for (const code of failureCodes) {
            expect(["QUOTA_EXCEEDED", "QUOTA_UNAVAILABLE"]).toContain(code)
        }

        const row = await periodRow(periodStart)
        expect(row).not.toBeNull()

        // هیچ‌وقت overspend
        expect(row!.reservedUnits + row!.consumedUnits).toBeLessThanOrEqual(ALLOWED)
        expect(row!.reservedUnits).toBeLessThanOrEqual(ALLOWED)
        // هر واحد اعطاشده دقیقاً یک‌بار حساب شده
        expect(row!.reservedUnits).toBe(granted)
        expect(granted).toBeGreaterThan(0)
        // تعداد eventهای RESERVED با تعداد رزروهای موفق برابر است (rollback در شکست‌ها)
        expect(
            await prisma.aiUsageEvent.count({ where: { userId, status: "RESERVED" } }),
        ).toBe(granted)
    })

    it("invariant no overspend holds across all period rows after mixed traffic", async () => {
        requireDb()
        const { periodStart } = getMonthlyPeriod(new Date("2026-09-15T12:00:00Z"))

        await reserveQuota(prisma, {
            userId,
            requestId: "d5-inv-a",
            allowedUnits: FREE_ALLOWED_UNITS,
            units: 4,
            feature: "analyze",
            periodStart,
        })
        await completeQuota(prisma, "d5-inv-a", undefined, { periodStart })
        await reserveQuota(prisma, {
            userId,
            requestId: "d5-inv-b",
            allowedUnits: FREE_ALLOWED_UNITS,
            units: 4,
            feature: "analyze",
            periodStart,
        })

        for (const row of await usageRows()) {
            expect(row.reservedUnits).toBeGreaterThanOrEqual(0)
            expect(row.consumedUnits).toBeGreaterThanOrEqual(0)
            expect(row.reservedUnits + row.consumedUnits).toBeLessThanOrEqual(
                FREE_ALLOWED_UNITS,
            )
        }
    })

    /* ------------------------------------------------------------------ */
    /* 5) concurrent first-row creation (unique constraint + retry, §8)    */
    /* ------------------------------------------------------------------ */

    it("concurrent first-row creation: unique constraint arbitrates — exactly one AiUsage row, no overspend", async () => {
        requireDb()
        const { periodStart } = getMonthlyPeriod(new Date("2026-09-15T12:00:00Z"))

        // هیچ ردیفی برای این دوره وجود ندارد (beforeEach پاک کرده است)
        expect(await periodRow(periodStart)).toBeNull()

        const CONCURRENCY = 6
        const results = await Promise.allSettled(
            Array.from({ length: CONCURRENCY }, (_, i) =>
                reserveQuota(prisma, {
                    userId,
                    requestId: `d5-first-${i}`,
                    allowedUnits: FREE_ALLOWED_UNITS,
                    units: 1,
                    feature: "analyze",
                    periodStart,
                }),
            ),
        )
        const granted = results.filter((r) => r.status === "fulfilled").length

        // race ساخت اولین ردیف نباید به خطای کنترل‌نشده/P2002 درزکننده منجر شود
        for (const r of results.filter((x) => x.status === "rejected")) {
            expect(["QUOTA_EXCEEDED", "QUOTA_UNAVAILABLE"]).toContain(
                codeOf((r as PromiseRejectedResult).reason),
            )
        }

        const rows = await usageRows()
        expect(rows).toHaveLength(1) // unique(userId, periodType, periodStart) برقرار است
        expect(rows[0].reservedUnits).toBe(granted)
        expect(rows[0].reservedUnits + rows[0].consumedUnits).toBeLessThanOrEqual(
            FREE_ALLOWED_UNITS,
        )
    })

    /* ------------------------------------------------------------------ */
    /* 6) unique requestId race (idempotency §15)                          */
    /* ------------------------------------------------------------------ */

    it("unique requestId race: concurrent duplicates produce exactly ONE logical reservation", async () => {
        requireDb()
        const { periodStart } = getMonthlyPeriod(new Date("2026-09-15T12:00:00Z"))

        const REQUEST_ID = "d5-same-request-id"
        const CONCURRENCY = 6

        const results = await Promise.allSettled(
            Array.from({ length: CONCURRENCY }, () =>
                reserveQuota(prisma, {
                    userId,
                    requestId: REQUEST_ID,
                    allowedUnits: FREE_ALLOWED_UNITS,
                    units: 1,
                    feature: "analyze",
                    periodStart,
                }),
            ),
        )

        const granted = results.filter((r) => r.status === "fulfilled").length
        const rejected = results.filter((r) => r.status === "rejected")

        expect(granted).toBe(1)
        expect(rejected).toHaveLength(CONCURRENCY - 1)
        // همه‌ی بازنده‌ها conflict هستند (نه خطای نامرتبط)
        for (const r of rejected) {
            expect(codeOf((r as PromiseRejectedResult).reason)).toBe("IDEMPOTENCY_CONFLICT")
        }

        // فقط یک event و فقط یک واحد رزرو شده
        expect(await prisma.aiUsageEvent.count({ where: { userId, requestId: REQUEST_ID } })).toBe(1)
        expect(await eventRow(REQUEST_ID)).toMatchObject({ status: "RESERVED", units: 1 })
        expect((await periodRow(periodStart))!.reservedUnits).toBe(1)

        // درخواست دوباره‌ی همان requestId (replay) هم رزرو جدید نمی‌سازد
        await expect(
            reserveQuota(prisma, {
                userId,
                requestId: REQUEST_ID,
                allowedUnits: FREE_ALLOWED_UNITS,
                units: 1,
                feature: "analyze",
                periodStart,
            }),
        ).rejects.toBeInstanceOf(IdempotencyConflictError)
        expect((await periodRow(periodStart))!.reservedUnits).toBe(1)
    })

    it("provider retries = ONE logical quota unit (§16): a retry within the same requestId never reserves again", async () => {
        requireDb()
        const { periodStart } = getMonthlyPeriod(new Date("2026-09-15T12:00:00Z"))

        await reserveQuota(prisma, {
            userId,
            requestId: "d5-retry-unit",
            allowedUnits: FREE_ALLOWED_UNITS,
            units: 1,
            feature: "analyze",
            periodStart,
        })

        // شبیه‌سازی retry provider داخل همان logical request → همان requestId
        for (let attempt = 0; attempt < 3; attempt++) {
            await expect(
                reserveQuota(prisma, {
                    userId,
                    requestId: "d5-retry-unit",
                    allowedUnits: FREE_ALLOWED_UNITS,
                    units: 1,
                    feature: "analyze",
                    periodStart,
                }),
            ).rejects.toBeInstanceOf(IdempotencyConflictError)
        }

        expect((await periodRow(periodStart))!.reservedUnits).toBe(1)
        expect(await prisma.aiUsageEvent.count({ where: { userId } })).toBe(1)
    })

    /* ------------------------------------------------------------------ */
    /* 7–8) duplicate complete / release (idempotent, §11)                 */
    /* ------------------------------------------------------------------ */

    it("duplicate complete: consumes exactly once; the second call is a no-op", async () => {
        requireDb()
        const { periodStart } = getMonthlyPeriod(new Date("2026-09-15T12:00:00Z"))
        const REQUEST_ID = "d5-dup-complete"

        await reserveQuota(prisma, {
            userId,
            requestId: REQUEST_ID,
            allowedUnits: FREE_ALLOWED_UNITS,
            units: 2,
            feature: "analyze",
            periodStart,
        })

        await expect(
            completeQuota(prisma, REQUEST_ID, undefined, { periodStart }),
        ).resolves.toBe(true)
        expect(await periodRow(periodStart)).toEqual({ reservedUnits: 0, consumedUnits: 2 })

        // دوباره complete → idempotent no-op، بدون مصرف مجدد
        await expect(
            completeQuota(prisma, REQUEST_ID, undefined, { periodStart }),
        ).resolves.toBe(false)
        expect(await periodRow(periodStart)).toEqual({ reservedUnits: 0, consumedUnits: 2 })
        expect(await eventRow(REQUEST_ID)).toMatchObject({ status: "CONSUMED" })
    })

    it("duplicate release: releases exactly once; the second call is a no-op", async () => {
        requireDb()
        const { periodStart } = getMonthlyPeriod(new Date("2026-09-15T12:00:00Z"))
        const REQUEST_ID = "d5-dup-release"

        await reserveQuota(prisma, {
            userId,
            requestId: REQUEST_ID,
            allowedUnits: FREE_ALLOWED_UNITS,
            units: 2,
            feature: "analyze",
            periodStart,
        })

        await expect(
            releaseQuota(prisma, REQUEST_ID, undefined, { periodStart }),
        ).resolves.toBe(true)
        expect(await periodRow(periodStart)).toEqual({ reservedUnits: 0, consumedUnits: 0 })

        await expect(
            releaseQuota(prisma, REQUEST_ID, undefined, { periodStart }),
        ).resolves.toBe(false)
        expect(await periodRow(periodStart)).toEqual({ reservedUnits: 0, consumedUnits: 0 })
        expect(await eventRow(REQUEST_ID)).toMatchObject({ status: "RELEASED" })
    })

    /* ------------------------------------------------------------------ */
    /* 9) periodStart / monthly rollover (P1-2 + P1-3)                     */
    /* ------------------------------------------------------------------ */

    it("rollover: complete/release act on the reservation's own periodStart and never mutate the other period", async () => {
        requireDb()
        const periodA = getMonthlyPeriod(new Date("2026-09-15T12:00:00Z")).periodStart
        const periodB = getMonthlyPeriod(new Date("2026-10-05T12:00:00Z")).periodStart
        expect(periodA.getTime()).not.toBe(periodB.getTime())

        await reserveQuota(prisma, {
            userId,
            requestId: "d5-rollover-a",
            allowedUnits: FREE_ALLOWED_UNITS,
            units: 1,
            feature: "analyze",
            periodStart: periodA,
        })
        await reserveQuota(prisma, {
            userId,
            requestId: "d5-rollover-b",
            allowedUnits: FREE_ALLOWED_UNITS,
            units: 3,
            feature: "ai-test",
            periodStart: periodB,
        })

        // دو ردیف مستقل
        expect((await usageRows()).map((r) => r.periodStart.getTime())).toEqual([
            periodA.getTime(),
            periodB.getTime(),
        ])

        // release ماه قبل → فقط ردیف A
        await expect(
            releaseQuota(prisma, "d5-rollover-a", undefined, { periodStart: periodA }),
        ).resolves.toBe(true)
        expect(await periodRow(periodA)).toEqual({ reservedUnits: 0, consumedUnits: 0 })
        expect(await periodRow(periodB)).toEqual({ reservedUnits: 3, consumedUnits: 0 }) // B دست‌نخورده

        // complete ماه جدید → فقط ردیف B
        await expect(
            completeQuota(prisma, "d5-rollover-b", undefined, { periodStart: periodB }),
        ).resolves.toBe(true)
        expect(await periodRow(periodB)).toEqual({ reservedUnits: 0, consumedUnits: 3 })
        expect(await periodRow(periodA)).toEqual({ reservedUnits: 0, consumedUnits: 0 }) // A دست‌نخورده
    })

    it("fail-closed when the reservation's own period row is missing/insufficient (P1-3 guard)", async () => {
        requireDb()
        const { periodStart } = getMonthlyPeriod(new Date("2026-09-15T12:00:00Z"))
        const REQUEST_ID = "d5-failclosed-period"

        await reserveQuota(prisma, {
            userId,
            requestId: REQUEST_ID,
            allowedUnits: FREE_ALLOWED_UNITS,
            units: 1,
            feature: "analyze",
            periodStart,
        })

        // ردیف دوره را عمداً نامتوازن می‌کنیم (شبیه‌سازی drift/از‌دست‌رفتن رزرو)
        await prisma.aiUsage.update({
            where: {
                userId_periodType_periodStart: { userId, periodType: "MONTHLY", periodStart },
            },
            data: { reservedUnits: 0 },
        })

        // complete نباید بخشی از شمارنده‌ها را حرکت دهد → QUOTA_UNAVAILABLE + rollback کامل
        await expect(
            completeQuota(prisma, REQUEST_ID, undefined, { periodStart }),
        ).rejects.toBeInstanceOf(QuotaUnavailableError)

        expect(await periodRow(periodStart)).toEqual({ reservedUnits: 0, consumedUnits: 0 })
        expect(await eventRow(REQUEST_ID)).toMatchObject({ status: "RESERVED" }) // rollback
    })

    /* ------------------------------------------------------------------ */
    /* 10–11) provider failure + release failure / RELEASE_FAILED (§12/§13) */
    /* ------------------------------------------------------------------ */

    it("provider failure release: event → RELEASED with AI_PROVIDER_UNAVAILABLE and quota fully restored (§12)", async () => {
        requireDb()
        const { periodStart } = getMonthlyPeriod(new Date("2026-09-15T12:00:00Z"))
        const REQUEST_ID = "d5-provider-failure"

        await reserveQuota(prisma, {
            userId,
            requestId: REQUEST_ID,
            allowedUnits: FREE_ALLOWED_UNITS,
            units: 1,
            feature: "analyze",
            periodStart,
        })

        await expect(
            releaseQuota(prisma, REQUEST_ID, undefined, {
                failureCode: "AI_PROVIDER_UNAVAILABLE",
                periodStart,
            }),
        ).resolves.toBe(true)

        expect(await eventRow(REQUEST_ID)).toMatchObject({
            status: "RELEASED",
            failureCode: "AI_PROVIDER_UNAVAILABLE",
        })
        expect(await periodRow(periodStart)).toEqual({ reservedUnits: 0, consumedUnits: 0 })
    })

    it("release failure: reservation stays RESERVED, is marked RELEASE_FAILED and stays reconcilable (§13/D2)", async () => {
        requireDb()
        const { periodStart } = getMonthlyPeriod(new Date("2026-09-15T12:00:00Z"))
        const REQUEST_ID = "d5-release-failure"

        await reserveQuota(prisma, {
            userId,
            requestId: REQUEST_ID,
            allowedUnits: FREE_ALLOWED_UNITS,
            units: 1,
            feature: "analyze",
            periodStart,
        })

        // تزریق خرابی واقعی DB در مسیر release: ردیف دوره را به حالت drift می‌بریم
        // (reservedUnits < delta) تا guard شرطی رد کند → rollback کل transaction
        await prisma.aiUsage.update({
            where: {
                userId_periodType_periodStart: { userId, periodType: "MONTHLY", periodStart },
            },
            data: { reservedUnits: 0 },
        })

        await expect(
            releaseQuota(prisma, REQUEST_ID, undefined, { periodStart }),
        ).rejects.toBeInstanceOf(QuotaUnavailableError)

        // قرارداد §13: transaction rollback → event در RESERVED می‌ماند (قابل تشخیص برای reconciliation)
        expect(await eventRow(REQUEST_ID)).toMatchObject({ status: "RESERVED" })
        expect((await eventRow(REQUEST_ID))!.failureCode).toBeNull()

        // D2: علامت‌گذاری best-effort → failureCode = RELEASE_FAILED بدون تغییر status
        await expect(markReleaseFailed(prisma, REQUEST_ID)).resolves.toBe(true)
        expect(await eventRow(REQUEST_ID)).toMatchObject({
            status: "RESERVED",
            failureCode: "RELEASE_FAILED",
        })

        // rollback کامل: هیچ mutation جزئی روی ردیف دوره اعمال نشده —
        // ردیف دقیقاً در همان حالت قبل از تلاش release می‌ماند (drift تزریق‌شده، بدون consume).
        expect(await periodRow(periodStart)).toEqual({ reservedUnits: 0, consumedUnits: 0 })
    })

    /* ------------------------------------------------------------------ */
    /* 12) quota DB failure (fail-closed §19)                              */
    /* ------------------------------------------------------------------ */

    it("quota DB failure: reserve for an unknown user fails closed with QUOTA_UNAVAILABLE", async () => {
        requireDb()
        const { periodStart } = getMonthlyPeriod(new Date("2026-09-15T12:00:00Z"))

        await expect(
            reserveQuota(prisma, {
                userId: 2147483000, // کاربر ناموجود → خطای DB واقعی (FK)
                requestId: "d5-db-failure-reserve",
                allowedUnits: FREE_ALLOWED_UNITS,
                units: 1,
                feature: "analyze",
                periodStart,
            }),
        ).rejects.toBeInstanceOf(QuotaUnavailableError)
    })

    it("quota DB failure: an unusable period row fails closed and never partially consumes", async () => {
        requireDb()
        const { periodStart } = getMonthlyPeriod(new Date("2026-09-15T12:00:00Z"))
        const REQUEST_ID = "d5-db-failure-complete"

        await reserveQuota(prisma, {
            userId,
            requestId: REQUEST_ID,
            allowedUnits: FREE_ALLOWED_UNITS,
            units: 2,
            feature: "analyze",
            periodStart,
        })

        // تزریق خرابی واقعی: ردیف دوره را حذف می‌کنیم (DB drift)
        await prisma.aiUsage.delete({
            where: {
                userId_periodType_periodStart: { userId, periodType: "MONTHLY", periodStart },
            },
        })

        await expect(
            completeQuota(prisma, REQUEST_ID, undefined, { periodStart }),
        ).rejects.toBeInstanceOf(QuotaUnavailableError)

        // هیچ نوشتن جزئی: event دست‌نخورده در RESERVED
        expect(await eventRow(REQUEST_ID)).toMatchObject({ status: "RESERVED" })
    })

    /* ------------------------------------------------------------------ */
    /* 14–15) /api/ai/test contract: production guard + reserve = 3 (§16)  */
    /* ------------------------------------------------------------------ */

    it("production guard: GET /api/ai/test returns 404 and writes NOTHING to the real DB (§16)", async () => {
        requireDb()

        const { GET } = await import("@/app/api/ai/test/route")
        vi.stubEnv("NODE_ENV", "production")
        try {
            const res = await GET()
            expect(res.status).toBe(404)

            // گارد اولین business action است → هیچ quota/event واقعی نوشته نشده
            expect(await prisma.aiUsage.count({ where: { userId } })).toBe(0)
            expect(await prisma.aiUsageEvent.count({ where: { userId } })).toBe(0)
        } finally {
            vi.unstubAllEnvs()
        }
    })

    it("ai-test contract: reserve = 3 units is all-or-nothing (§16)", async () => {
        requireDb()
        const { periodStart } = getMonthlyPeriod(new Date("2026-09-15T12:00:00Z"))

        // ظرفیت ۲ < ۳ → کل invocation باید رد شود، بدون partial reservation
        await expect(
            reserveQuota(prisma, {
                userId,
                requestId: "d5-aitest-partial",
                allowedUnits: 2,
                units: AI_TEST_UNITS,
                feature: "ai-test",
                periodStart,
            }),
        ).rejects.toBeInstanceOf(QuotaExceededError)

        expect(await eventRow("d5-aitest-partial")).toBeNull()
        expect(await periodRow(periodStart)).toEqual({ reservedUnits: 0, consumedUnits: 0 })

        // ظرفیت کافی → ۳ unit یکجا
        await reserveQuota(prisma, {
            userId,
            requestId: "d5-aitest-full",
            allowedUnits: FREE_ALLOWED_UNITS,
            units: AI_TEST_UNITS,
            feature: "ai-test",
            periodStart,
        })
        expect(await periodRow(periodStart)).toEqual({
            reservedUnits: AI_TEST_UNITS,
            consumedUnits: 0,
        })

        // و complete آن invocation دقیقاً ۳ unit را consume می‌کند (یک logical request)
        await expect(
            completeQuota(prisma, "d5-aitest-full", undefined, { periodStart }),
        ).resolves.toBe(true)
        expect(await periodRow(periodStart)).toEqual({
            reservedUnits: 0,
            consumedUnits: AI_TEST_UNITS,
        })
    })
}, DB_TEST_TIMEOUT_MS)
