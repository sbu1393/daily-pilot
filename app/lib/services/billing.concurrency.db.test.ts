// فاز ۵ — گام ۱۹: تست‌های concurrency با PostgreSQL واقعی (سند فاز ۵ §۲۹، §۳۵ «PostgreSQL concurrency
// tests»، §۳۶ آیتم ۱۹).
//
// دامنه (فقط تست — هیچ production code/schema/migration/model تغییر نمی‌کند):
//   1. first-entitlement creation race        (§۲۹: unique(userId) + bounded retry/re-read)
//   2. simultaneous renewals                  (§۲۹/§۳۵: سریال‌شدن روی تنها ردیف Entitlement کاربر)
//   3. expiration + renewal race              (§۲۹/§۳۵: expiration کهنه هرگز PRO تازه‌تمدیدشده را downgrade نمی‌کند)
//   4. lazy expiration materialization        (§۱۷/§۲۹: یک بار ACTIVE→EXPIRED + User.plan=FREE)
//   5. payment idempotency-key race           (§۶/§۲۹/§۳۵: یک سفارش برای `userId + checkoutIdempotencyKey`)
//   6. authority attach race (متفاوت)         (§۶/§۲۹: overwrite نشدن authority + CONFLICT درست)
//   7. authority attach race (یکسان)          (§۶: idempotent، یک مقدار persist‌شده)
//   8. finalize (duplicate callback) race     (§۱۴/§۲۸/§۲۹/§۳۵: فقط یک finalize، یک grant، یک سیگنال emission)
//   9. unique provider-reference race         (§۲۹: یک reference نمی‌تواند دو سفارش را تأیید کند)
//  10. unique provider-authority race         (§۲۹: یک authority هرگز به دو سفارش نمی‌چسبد)
//
// قواعد اجرا (طبق دستور گام ۱۹):
// - PostgreSQL واقعی (نه mock Prisma، نه SQLite، نه fake). کلاینت همان PrismaClient واقعی است.
// - اگر PostgreSQL در دسترس نباشد تست **fail مصنوعی نمی‌شود** و «سبز جعلی» هم نمی‌سازد: با skip
//   استاندارد vitest و پیام واضح REAL_POSTGRESQL_UNAVAILABLE گزارش می‌شود (همان واژگان الگوی
//   موجود repo در userActivity.concurrency.db.test.ts — با semantics skip که دستور گام ۱۹ خواسته است).
// - هر تست کاربر اختصاصی خودش را می‌سازد (prefixed/unique) و به هیچ رکورد موجود دست نمی‌زند؛
//   cleanup در afterAll با cascade انجام می‌شود و شکست آن صریحاً گزارش/شکست داده می‌شود.
// - هیچ assertion روی تعداد دفعات write سطح پایین‌تر از آنچه DB نشان می‌دهد ساخته نمی‌شود؛
//   صحت واقعی از constraint + conditional update + state نهایی خوانده می‌شود.
// - این فایل هیچ transaction/هم‌زمانی‌سازی مصنوعی به production code اضافه نمی‌کند؛ فقط رفتار واقعی
//   PostgreSQL + Prisma را زیر بار هم‌زمان می‌سنجد.
//
// اجرای صریح تکی: `npx vitest run app/lib/services/billing.concurrency.db.test.ts`

import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { BILLING_ENV, getBillingConfig } from "../billing/config"
import {
    attachProviderAuthority,
    finalizeVerifiedPayment,
    prepareCheckout,
} from "./billing.service"
import { activate, lazyExpire, renew } from "./entitlement.service"
import {
    EntitlementConflictError,
    PaymentIdempotencyConflictError,
    PaymentStateUnresolvedError,
    ServiceError,
    toServiceErrorFromInfrastructure,
} from "./errors"

/** پیام skip استاندارد — همان واژگان REAL_POSTGRESQL_UNAVAILABLE الگوی موجود repo. */
const REAL_POSTGRESQL_UNAVAILABLE =
    "REAL_POSTGRESQL_UNAVAILABLE: تست concurrency گام ۱۹ به PostgreSQL واقعی نیاز دارد؛ skip استاندارد (بدون سبزِ جعلی و بدون fail مصنوعی)."

/** پیشوند اختصاصی این تست — تضمین فاصله از داده‌ی واقعی. */
const MARKER = "step19-billing-concurrency"

/** تعداد فراخوانی هم‌زمان در هر سناریو. */
const CONCURRENCY = 4

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * fixture محیطی فقط برای کلیدهایی که در محیط موجود نیستند.
 *
 * دلیل: مسیر `prepareCheckout` مقدار محصول را از config سروری می‌خواند (fail-fast). این تست
 * business value تولید نمی‌کند و هیچ‌جا مقدار را hard-code نمی‌کند؛ فقط اگر محیط مقدار نداشت،
 * یک fixture با نام صریح می‌گذارد تا تست از «نبود config» به‌جای «صحت concurrency» قرمز نشود.
 * اگر محیط مقدار واقعی داشته باشد، همان مقدار برنده است و ادعاها با snapshot همان config سنجیده می‌شوند.
 */
const BILLING_TEST_ENV: readonly (readonly [string, string])[] = [
    [BILLING_ENV.proAmount, "100000"],
    [BILLING_ENV.proCurrency, "IRR"],
    [BILLING_ENV.proEntitlementDays, "30"],
    [BILLING_ENV.merchantId, "step19-test-merchant"],
    [BILLING_ENV.mode, "sandbox"],
    [BILLING_ENV.baseUrl, "https://sandbox.zarinpal.test"],
    [BILLING_ENV.callbackUrl, "https://daily-pal.test/api/billing/callback/zarinpal"],
    [BILLING_ENV.zarinpalDescription, "step19 concurrency fixture"],
    [BILLING_ENV.orderTtlMs, "900000"],
    [BILLING_ENV.resultUrlSuccess, "https://daily-pal.test/billing/success"],
    [BILLING_ENV.resultUrlFailure, "https://daily-pal.test/billing/failure"],
]

let prisma: PrismaClient
let dbAvailable = false
let userSeq = 0
let cleanupFailed = false

const createdUserIds: number[] = []

beforeAll(async () => {
    for (const [key, value] of BILLING_TEST_ENV) {
        if (!process.env[key]) process.env[key] = value
    }

    try {
        prisma = new PrismaClient()
        // gate سخت: فقط اتصال واقعی و اجرای واقعی یک query به PostgreSQL اجازه‌ی اجرا می‌دهد.
        await prisma.$queryRaw`SELECT 1`
        dbAvailable = true
    } catch {
        dbAvailable = false
    }
})

afterAll(async () => {
    if (!prisma) return

    try {
        if (dbAvailable && createdUserIds.length > 0) {
            // cascade: PaymentOrder/Entitlement/ProductEvent/Task/... همه با user حذف می‌شوند
            await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
        }
    } catch (error) {
        cleanupFailed = true
        console.error("STEP19_CLEANUP_FAILED", {
            userIds: createdUserIds,
            error: error instanceof Error ? error.message : error,
        })
    } finally {
        await prisma.$disconnect().catch(() => {})
    }

    if (cleanupFailed) {
        throw new Error("STEP19_CLEANUP_FAILED: حذف کاربران اختصاصی این تست ناموفق بود.")
    }
})

/** کاربر اختصاصی این تست — هیچ رکورد موجودی خوانده/تغییر داده نمی‌شود. */
async function createDedicatedUser(label: string): Promise<number> {
    userSeq += 1
    const suffix = `${label}-${userSeq}-${Date.now()}`
    const user = await prisma.user.create({
        data: {
            email: `${MARKER}-${suffix}@concurrency.internal`,
            username: `${MARKER}-${suffix}`,
            // ورود از این مسیر نیست؛ یک هش واقعی لازم نیست (الگوی Step 11).
            password: "not-a-real-login",
            plan: "FREE",
        },
        select: { id: true },
    })

    createdUserIds.push(user.id)
    return user.id
}

async function readEntitlementRow(userId: number) {
    return prisma.entitlement.findUniqueOrThrow({ where: { userId } })
}

async function readUserPlan(userId: number) {
    const row = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { plan: true },
    })
    return row.plan
}

async function readOrder(orderId: string) {
    return prisma.paymentOrder.findUniqueOrThrow({ where: { id: orderId } })
}

function fulfilledValues<T>(results: PromiseSettledResult<T>[]): T[] {
    return results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
}

function rejectedReasons<T>(results: PromiseSettledResult<T>[]): unknown[] {
    return results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
}

describe("Phase 5 — real PostgreSQL concurrency (step 19)", () => {
    it(
        "first-entitlement creation race: one Entitlement row, serialized grants, no raw unique violation",
        async (ctx) => {
            if (!dbAvailable) ctx.skip(REAL_POSTGRESQL_UNAVAILABLE)

            const userId = await createDedicatedUser("first-entitlement")
            const days = 30
            const at = new Date()

            const settled = await Promise.allSettled(
                Array.from({ length: CONCURRENCY }, () =>
                    activate(prisma, { userId, provider: "ZARINPAL", entitlementDays: days }, at),
                ),
            )

            const fulfilled = fulfilledValues(settled)
            const rejected = rejectedReasons(settled)

            // race ساخت ردیف اول: هیچ P2002 خامی بیرون نمی‌زند — فقط conflict دامنه‌ای (bounded retry)
            for (const reason of rejected) expect(reason).toBeInstanceOf(EntitlementConflictError)
            expect(fulfilled.length).toBeGreaterThanOrEqual(1)

            // تنها یک ردیف per user؛ هیچ‌کدام از فراخوانی‌ها دومی نساخته است
            const rows = await prisma.entitlement.findMany({ where: { userId } })
            expect(rows).toHaveLength(1)
            expect(rows[0].status).toBe("ACTIVE")
            expect(rows[0].planCode).toBe("PRO")

            // هر grant موفق دقیقاً یک دوره اضافه کرده و هیچ grantی گم نشده است (بدون lost update)
            expect(rows[0].currentPeriodStart.getTime()).toBe(at.getTime())
            expect(rows[0].currentPeriodEnd.getTime()).toBe(
                at.getTime() + days * fulfilled.length * DAY_MS,
            )
            expect(await readUserPlan(userId)).toBe("PRO")
        },
        30_000,
    )

    it(
        "simultaneous renewals: entitlement updates serialize on the single user row (no lost update)",
        async (ctx) => {
            if (!dbAvailable) ctx.skip(REAL_POSTGRESQL_UNAVAILABLE)

            const userId = await createDedicatedUser("simultaneous-renewals")
            const days = 10
            const periodStart = new Date()
            const periodEnd = new Date(periodStart.getTime() + days * DAY_MS)

            await prisma.entitlement.create({
                data: {
                    userId,
                    provider: "ZARINPAL",
                    status: "ACTIVE",
                    planCode: "PRO",
                    currentPeriodStart: periodStart,
                    currentPeriodEnd: periodEnd,
                },
            })
            await prisma.user.update({ where: { id: userId }, data: { plan: "PRO" } })

            // دقیقاً داخل دوره‌ی فعال → شاخه‌ی «extension» (تمدید، نه دوره‌ی جدید)
            const at = new Date(periodStart.getTime() + DAY_MS)

            const settled = await Promise.allSettled(
                Array.from({ length: CONCURRENCY }, () =>
                    renew(prisma, { userId, provider: "ZARINPAL", entitlementDays: days }, at),
                ),
            )

            const fulfilled = fulfilledValues(settled)
            for (const reason of rejectedReasons(settled)) {
                expect(reason).toBeInstanceOf(EntitlementConflictError)
            }
            expect(fulfilled.length).toBeGreaterThanOrEqual(1)

            const row = await readEntitlementRow(userId)
            expect(row.status).toBe("ACTIVE")
            expect(row.planCode).toBe("PRO")
            // دوره هرگز کوتاه/ریست نمی‌شود و هر تمدید موفق دقیقاً یک دوره امتداد می‌دهد
            expect(row.currentPeriodStart.getTime()).toBe(periodStart.getTime())
            expect(row.currentPeriodEnd.getTime()).toBe(
                periodStart.getTime() + (1 + fulfilled.length) * days * DAY_MS,
            )
            expect(await readUserPlan(userId)).toBe("PRO")
        },
        30_000,
    )

    it(
        "expiration + renewal race: a stale expiration never downgrades a renewed PRO entitlement",
        async (ctx) => {
            if (!dbAvailable) ctx.skip(REAL_POSTGRESQL_UNAVAILABLE)

            const userId = await createDedicatedUser("expiry-renewal-race")
            const days = 30
            // دوره‌ی گذشته اما هنوز materialize نشده: status=ACTIVE با currentPeriodEnd < now
            const periodEnd = new Date(Date.now() - DAY_MS)
            const periodStart = new Date(periodEnd.getTime() - days * DAY_MS)

            await prisma.entitlement.create({
                data: {
                    userId,
                    provider: "ZARINPAL",
                    status: "ACTIVE",
                    planCode: "PRO",
                    currentPeriodStart: periodStart,
                    currentPeriodEnd: periodEnd,
                },
            })
            await prisma.user.update({ where: { id: userId }, data: { plan: "PRO" } })

            const at = new Date()

            const [expireResult, renewResult] = await Promise.allSettled([
                lazyExpire(prisma, userId, at),
                renew(prisma, { userId, provider: "ZARINPAL", entitlementDays: days }, at),
            ])

            // خرید تأییدشده هرگز نباید شکست بخورد؛ expiration هم‌زمان فقط می‌تواند قبل یا بعد برسد
            expect(renewResult.status).toBe("fulfilled")
            // expiration هم‌زمان هم هرگز نباید شکست بخورد (نه P2002 خام، نه ENTITLEMENT_CONFLICT از race):
            // اگر زودتر برسد FREE و بعد تمدید PRO را برمی‌گرداند؛ اگر دیرتر برسد CAS کهنه match نمی‌شود.
            expect(expireResult.status).toBe("fulfilled")

            const row = await readEntitlementRow(userId)
            // نتیجه‌ی نهایی فارغ از ترتیب: دوره‌ی تازه از now، ACTIVE و PRO — بدون downgrade ماندگار
            expect(row.currentPeriodStart.getTime()).toBe(at.getTime())
            expect(row.currentPeriodEnd.getTime()).toBe(at.getTime() + days * DAY_MS)
            expect(row.status).toBe("ACTIVE")
            expect(row.planCode).toBe("PRO")
            expect(await readUserPlan(userId)).toBe("PRO")
            expect(await prisma.entitlement.count({ where: { userId } })).toBe(1)

            // اثبات قطعی نبودن downgrade: ارزیابی انقضا در لحظه‌ی پیش از تمدید هم PRO می‌دهد،
            // چون ردیف جاری (دوره‌ی تازه) دیگر آن دوره‌ی کهنه‌ی خوانده‌شده را match نمی‌کند.
            const staleExpiration = await lazyExpire(prisma, userId, at)
            expect(staleExpiration.effectivePlan).toBe("PRO")
            expect((await readEntitlementRow(userId)).status).toBe("ACTIVE")
            expect(await readUserPlan(userId)).toBe("PRO")
        },
        30_000,
    )

    it(
        "lazy expiration under concurrency materializes ACTIVE→EXPIRED exactly once",
        async (ctx) => {
            if (!dbAvailable) ctx.skip(REAL_POSTGRESQL_UNAVAILABLE)

            const userId = await createDedicatedUser("expiration-once")
            const periodEnd = new Date(Date.now() - DAY_MS)
            const periodStart = new Date(periodEnd.getTime() - 30 * DAY_MS)

            await prisma.entitlement.create({
                data: {
                    userId,
                    provider: "ZARINPAL",
                    status: "ACTIVE",
                    planCode: "PRO",
                    currentPeriodStart: periodStart,
                    currentPeriodEnd: periodEnd,
                },
            })
            await prisma.user.update({ where: { id: userId }, data: { plan: "PRO" } })

            const at = new Date()
            const settled = await Promise.allSettled(
                Array.from({ length: CONCURRENCY }, () => lazyExpire(prisma, userId, at)),
            )

            for (const reason of rejectedReasons(settled)) {
                expect(reason).toBeInstanceOf(EntitlementConflictError)
            }
            const fulfilled = fulfilledValues(settled)
            expect(fulfilled.length).toBeGreaterThanOrEqual(1)
            expect(fulfilled.every((result) => result.effectivePlan === "FREE")).toBe(true)

            const row = await readEntitlementRow(userId)
            expect(row.status).toBe("EXPIRED")
            expect(await readUserPlan(userId)).toBe("FREE")
            expect(await prisma.entitlement.count({ where: { userId } })).toBe(1)
            // هیچ انقضای هم‌زمانی مقدار دوره را دست‌کاری نکرده است
            expect(row.currentPeriodStart.getTime()).toBe(periodStart.getTime())
            expect(row.currentPeriodEnd.getTime()).toBe(periodEnd.getTime())
        },
        30_000,
    )

    it(
        "payment idempotency race: exactly one PaymentOrder per (userId, Idempotency-Key)",
        async (ctx) => {
            if (!dbAvailable) ctx.skip(REAL_POSTGRESQL_UNAVAILABLE)

            const userId = await createDedicatedUser("idempotency-race")
            const key = `step19-key-${Date.now()}`
            const { pro, orderTtlMs } = getBillingConfig()

            const settled = await Promise.allSettled(
                Array.from({ length: CONCURRENCY }, () =>
                    prepareCheckout(prisma, {
                        userId,
                        checkoutIdempotencyKey: key,
                        orderTtlMs,
                    }),
                ),
            )

            const fulfilled = fulfilledValues(settled)
            for (const reason of rejectedReasons(settled)) {
                expect(reason).toBeInstanceOf(PaymentIdempotencyConflictError)
            }
            expect(fulfilled.length).toBeGreaterThanOrEqual(1)

            const rows = await prisma.paymentOrder.findMany({
                where: { userId, checkoutIdempotencyKey: key },
            })
            // هیچ سفارش دومی برای همان کلید ساخته نشده است (unique سرور-محور + bounded retry)
            expect(rows).toHaveLength(1)
            expect(rows[0].status).toBe("PENDING")
            // همه‌ی فراخوانی‌های موفق همان سفارش را می‌بینند و فقط یک create واقعی رخ داده است
            expect(fulfilled.every((result) => result.order.id === rows[0].id)).toBe(true)
            expect(fulfilled.filter((result) => !result.reused)).toHaveLength(1)
            // snapshot سروری از config واحد — هیچ کلاینتی نمی‌تواند مقدار متفاوت بسازد
            expect(rows[0].amount).toBe(pro.amount)
            expect(rows[0].currency).toBe(pro.currency)
            expect(rows[0].entitlementDays).toBe(pro.entitlementDays)
        },
        30_000,
    )

    it(
        "authority attach race: one winner, no overwrite, conflict for every other authority",
        async (ctx) => {
            if (!dbAvailable) ctx.skip(REAL_POSTGRESQL_UNAVAILABLE)

            const userId = await createDedicatedUser("authority-race")
            const key = `step19-authority-${Date.now()}`
            const { orderTtlMs } = getBillingConfig()
            const prepared = await prepareCheckout(prisma, {
                userId,
                checkoutIdempotencyKey: key,
                orderTtlMs,
            })

            const stamp = Date.now()
            const authorities = Array.from(
                { length: CONCURRENCY },
                (_, index) => `step19-authority-${stamp}-${index}`,
            )

            const settled = await Promise.allSettled(
                authorities.map((authority) =>
                    attachProviderAuthority(prisma, {
                        userId,
                        checkoutIdempotencyKey: key,
                        authority,
                    }),
                ),
            )

            const winners = authorities.filter(
                (_authority, index) => settled[index].status === "fulfilled",
            )
            const failures = rejectedReasons(settled)

            // دقیقاً یک authority برنده می‌شود؛ بقیه کنفلیکت دامنه‌ای می‌گیرند (بدون overwrite)
            expect(winners).toHaveLength(1)
            expect(failures).toHaveLength(CONCURRENCY - 1)
            for (const reason of failures) {
                expect(reason).toBeInstanceOf(PaymentIdempotencyConflictError)
            }

            const stored = await readOrder(prepared.order.id)
            expect(stored.providerAuthority).toBe(winners[0])
            expect(stored.status).toBe("PENDING")

            // و پس از race، هر authority متفاوتی بازهم overwrite نمی‌کند و مقدار ذخیره‌شده ثابت می‌ماند
            await expect(
                attachProviderAuthority(prisma, {
                    userId,
                    checkoutIdempotencyKey: key,
                    authority: `step19-authority-late-${stamp}`,
                }),
            ).rejects.toBeInstanceOf(PaymentIdempotencyConflictError)

            expect((await readOrder(prepared.order.id)).providerAuthority).toBe(winners[0])
        },
        30_000,
    )

    it(
        "authority attach race: identical concurrent authorities are idempotent (one persisted value)",
        async (ctx) => {
            if (!dbAvailable) ctx.skip(REAL_POSTGRESQL_UNAVAILABLE)

            const userId = await createDedicatedUser("authority-idempotent")
            const key = `step19-authority-same-${Date.now()}`
            const { orderTtlMs } = getBillingConfig()
            const prepared = await prepareCheckout(prisma, {
                userId,
                checkoutIdempotencyKey: key,
                orderTtlMs,
            })

            const authority = `step19-authority-same-${Date.now()}`

            const settled = await Promise.allSettled(
                Array.from({ length: CONCURRENCY }, () =>
                    attachProviderAuthority(prisma, {
                        userId,
                        checkoutIdempotencyKey: key,
                        authority,
                    }),
                ),
            )

            // همان authority → replay موفق/idempotent برای همه، بدون هیچ تغییری در state
            expect(rejectedReasons(settled)).toHaveLength(0)
            expect(fulfilledValues(settled)).toHaveLength(CONCURRENCY)

            const stored = await readOrder(prepared.order.id)
            expect(stored.providerAuthority).toBe(authority)
            expect(stored.status).toBe("PENDING")
        },
        30_000,
    )

    it(
        "finalize race (duplicate callback): one finalization, one grant, one emission signal",
        async (ctx) => {
            if (!dbAvailable) ctx.skip(REAL_POSTGRESQL_UNAVAILABLE)

            const userId = await createDedicatedUser("finalize-race")
            const { pro, orderTtlMs } = getBillingConfig()
            const days = pro.entitlementDays

            const key = `step19-finalize-${Date.now()}`
            const prepared = await prepareCheckout(prisma, {
                userId,
                checkoutIdempotencyKey: key,
                orderTtlMs,
            })

            const authority = `step19-finalize-${Date.now()}`
            await attachProviderAuthority(prisma, {
                userId,
                checkoutIdempotencyKey: key,
                authority,
            })

            const at = new Date()
            const verification = { reference: `step19-ref-${Date.now()}`, amount: prepared.order.amount }

            const settled = await Promise.allSettled(
                Array.from({ length: CONCURRENCY }, () =>
                    finalizeVerifiedPayment(prisma, { authority, verification }, at),
                ),
            )

            // callback تکراری/هم‌زمان باید idempotent no-op بماند: هیچ خطای خامی بیرون نمی‌زند
            expect(rejectedReasons(settled)).toHaveLength(0)
            const results = fulfilledValues(settled)

            const finalized = results.filter((result) => result.finalized)
            expect(finalized).toHaveLength(1)
            expect(finalized[0].entitlementAction).toBe("ACTIVATED")
            // بازنده‌ها نه entitlement می‌گیرند و نه سیگنال emission می‌سازند
            expect(
                results
                    .filter((result) => !result.finalized)
                    .every((result) => result.entitlementAction === null),
            ).toBe(true)

            // entitlement فقط یک بار grant شده است (نه N بار)
            const entitlementRows = await prisma.entitlement.findMany({ where: { userId } })
            expect(entitlementRows).toHaveLength(1)
            expect(entitlementRows[0].status).toBe("ACTIVE")
            expect(entitlementRows[0].currentPeriodEnd.getTime()).toBe(at.getTime() + days * DAY_MS)

            const order = await readOrder(prepared.order.id)
            expect(order.status).toBe("PAID")
            expect(order.paidAt?.getTime()).toBe(at.getTime())
            expect(order.providerReference).toBe(verification.reference)
            expect(order.entitlementId).toBe(entitlementRows[0].id)
            expect(await readUserPlan(userId)).toBe("PRO")

            // ProductEvent (رفتار قابل‌تست در سطح DB): قاعده‌ی route این است که رویداد فقط وقتی
            // entitlementAction غیر-null است ثبت شود. سیگنال در race دقیقاً یک بار غیر-null شده،
            // پس این قاعده نمی‌تواند رویداد تکراری بسازد — با شمارش واقعی سطرها تأیید می‌شود.
            const emissionSignals = results.filter((result) => result.entitlementAction !== null)
            expect(emissionSignals).toHaveLength(1)
            for (const result of results) {
                if (result.entitlementAction === null) continue
                await prisma.productEvent.create({
                    data: {
                        userId,
                        requestId: `step19-emission-${Date.now()}`,
                        eventName:
                            result.entitlementAction === "ACTIVATED"
                                ? "billing.entitlement_activated"
                                : "billing.entitlement_renewed",
                        feature: "billing",
                        properties: { provider: "ZARINPAL", entitlementDays: days },
                    },
                })
            }
            expect(await prisma.productEvent.count({ where: { userId } })).toBe(1)

            // callback تکراری بعدی (توالی) هم no-op کامل است: نه grant دوم، نه paidAt جدید، نه رویداد
            const replay = await finalizeVerifiedPayment(prisma, { authority, verification }, new Date())
            expect(replay.finalized).toBe(false)
            expect(replay.entitlementAction).toBeNull()

            const afterReplay = await readOrder(prepared.order.id)
            expect(afterReplay.paidAt?.getTime()).toBe(at.getTime())
            expect((await readEntitlementRow(userId)).currentPeriodEnd.getTime()).toBe(
                at.getTime() + days * DAY_MS,
            )
            expect(await prisma.productEvent.count({ where: { userId } })).toBe(1)
        },
        30_000,
    )

    it(
        "unique provider-reference race: one reference can confirm only one order (loser rolls back)",
        async (ctx) => {
            if (!dbAvailable) ctx.skip(REAL_POSTGRESQL_UNAVAILABLE)

            const { pro, orderTtlMs } = getBillingConfig()
            const days = pro.entitlementDays
            const at = new Date()
            const reference = `step19-shared-ref-${Date.now()}`

            const cases: {
                userId: number
                orderId: string
                authority: string
                verification: { reference: string; amount: number }
            }[] = []

            for (const label of ["ref-a", "ref-b"]) {
                const userId = await createDedicatedUser(label)
                const key = `step19-shared-ref-${label}-${Date.now()}`
                const prepared = await prepareCheckout(prisma, {
                    userId,
                    checkoutIdempotencyKey: key,
                    orderTtlMs,
                })
                const authority = `step19-shared-ref-auth-${label}-${Date.now()}`

                await attachProviderAuthority(prisma, {
                    userId,
                    checkoutIdempotencyKey: key,
                    authority,
                })

                cases.push({
                    userId,
                    orderId: prepared.order.id,
                    authority,
                    verification: { reference, amount: prepared.order.amount },
                })
            }

            const settled = await Promise.allSettled(
                cases.map((item) =>
                    finalizeVerifiedPayment(
                        prisma,
                        { authority: item.authority, verification: item.verification },
                        at,
                    ),
                ),
            )

            const fulfilled = fulfilledValues(settled)
            const rejected = rejectedReasons(settled)

            // تنها یک سفارش می‌تواند با این reference نهایی شود؛ دیگری نباید موفق شود
            expect(fulfilled).toHaveLength(1)
            expect(rejected).toHaveLength(1)

            // خطای بازنده باید در مرز خطا شناخته‌شده باشد (دامنه، یا Prisma known error که §9.11
            // آن را به 409 CONFLICT نگاشت می‌کند) — نه یک شکست ناشناخته/سرکوب‌شده.
            const loserError = rejected[0]
            const mapped =
                loserError instanceof ServiceError
                    ? loserError
                    : toServiceErrorFromInfrastructure(loserError)
            expect(mapped).not.toBeNull()

            // پیامدهای DB: reference فقط یک بار persist شده و بازنده کامل rollback شده است
            const paidRows = await prisma.paymentOrder.findMany({
                where: { providerReference: reference },
            })
            expect(paidRows).toHaveLength(1)
            expect(paidRows[0].status).toBe("PAID")

            const loser = cases.find((item) => item.orderId !== paidRows[0].id)
            expect(loser).toBeDefined()

            const loserOrder = await readOrder(loser!.orderId)
            expect(loserOrder.status).toBe("PENDING")
            expect(loserOrder.paidAt).toBeNull()
            expect(loserOrder.entitlementId).toBeNull()
            expect(await prisma.entitlement.findUnique({ where: { userId: loser!.userId } })).toBeNull()

            const winnerEntitlement = await readEntitlementRow(paidRows[0].userId)
            expect(winnerEntitlement.currentPeriodEnd.getTime()).toBe(at.getTime() + days * DAY_MS)
        },
        30_000,
    )

    it(
        "unique provider-authority race: one authority can never attach to two orders",
        async (ctx) => {
            if (!dbAvailable) ctx.skip(REAL_POSTGRESQL_UNAVAILABLE)

            const { orderTtlMs } = getBillingConfig()
            const authority = `step19-shared-authority-${Date.now()}`

            const cases: { userId: number; orderId: string; key: string }[] = []

            for (const label of ["authority-a", "authority-b"]) {
                const userId = await createDedicatedUser(label)
                const key = `step19-shared-authority-${label}-${Date.now()}`
                const prepared = await prepareCheckout(prisma, {
                    userId,
                    checkoutIdempotencyKey: key,
                    orderTtlMs,
                })

                cases.push({ userId, orderId: prepared.order.id, key })
            }

            const settled = await Promise.allSettled(
                cases.map((item) =>
                    attachProviderAuthority(prisma, {
                        userId: item.userId,
                        checkoutIdempotencyKey: item.key,
                        authority,
                    }),
                ),
            )

            // یک winner + یک شکستِ گزارش‌شده (وضعیت قابل‌تعیین نیست) — هیچ بازنویسی خاموشی رخ نمی‌دهد
            const winners = fulfilledValues(settled)
            const failures = rejectedReasons(settled)
            expect(winners).toHaveLength(1)
            expect(failures).toHaveLength(1)
            expect(failures[0]).toBeInstanceOf(PaymentStateUnresolvedError)

            // constraint یکتا: همان authority هرگز روی دو سفارش نمی‌نشیند و مقدار سفارش بازنده null می‌ماند
            const attachedRows = await prisma.paymentOrder.findMany({
                where: { providerAuthority: authority },
            })
            expect(attachedRows).toHaveLength(1)

            const loser = cases.find((item) => item.orderId !== attachedRows[0].id)
            expect(loser).toBeDefined()

            const loserOrder = await readOrder(loser!.orderId)
            expect(loserOrder.providerAuthority).toBeNull()
            expect(loserOrder.status).toBe("PENDING")
        },
        30_000,
    )
})
