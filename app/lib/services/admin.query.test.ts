import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* فاز ۴ — Step 5: admin.query — read-only foundation                  */
/* الگوی repository: Prisma client تزریق‌شده mock می‌شود (no real DB).   */
/* ------------------------------------------------------------------ */

vi.mock("./getPrisma", () => ({ getPrisma: () => ({}) }))

import {
    getAdminActivity,
    getAdminActivityStats,
    getAdminAiUsage,
    getAdminBillingSummary,
    getAdminErrors,
    getAdminErrorStats,
    getAdminOverview,
    getUserDetail,
    maskProviderReference,
    ADMIN_QUERY_MAX_PAGE_SIZE,
} from "./admin.query"
import { UserNotFoundError } from "./errors"

const NOW = new Date("2026-09-17T10:00:00.000Z")

function makePrisma() {
    return {
        aiUsage: { findMany: vi.fn().mockResolvedValue([]) },
        aiUsageEvent: {
            findMany: vi.fn().mockResolvedValue([]),
            count: vi.fn().mockResolvedValue(0),
        },
    }
}

describe("getAdminActivity (ProductEvent source — Phase 3 primitive only)", () => {
    it("delegates to listProductEvents with a valid bounded userId filter", async () => {
        const result = await getAdminActivity({ userId: 5, page: 2, pageSize: 10 })

        expect(result).toEqual({ events: [], page: 2, pageSize: 10, total: 0 })
    })

    it("returns empty for a global (userId-less) history request — per-user primitive", async () => {
        const result = await getAdminActivity({})

        expect(result).toEqual({ events: [], page: 1, pageSize: 20, total: 0 })
    })

    it("clamps pageSize above 100 to 100 (bounded pagination)", async () => {
        const result = await getAdminActivity({ userId: 5, pageSize: 5000 })

        expect(result.pageSize).toBe(100)
    })

    it("stats delegate to getEventUsageStats (global event usage, not DAU source)", async () => {
        const result = await getAdminActivityStats(48)

        expect(result.windowHours).toBe(48)
        expect(result.byEventName).toEqual([])
    })
})

describe("getAdminAiUsage (AiUsage + AiUsageEvent — read-only)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("issues only read calls (findMany/count) — never mutations", async () => {
        const prisma = makePrisma()

        await getAdminAiUsage({ userId: 3 }, { prisma, now: NOW })

        expect(prisma.aiUsage.findMany).toHaveBeenCalledTimes(1)
        expect(prisma.aiUsageEvent.findMany).toHaveBeenCalledTimes(1)
        expect(prisma.aiUsageEvent.count).toHaveBeenCalledTimes(1)
        // هیچ reserve/complete/release/update/create در سطح این mock وجود ندارد —
        // خود client فقط findMany/count را expose می‌کند؛ تایپ آن mutation را ناممکن می‌کند.
    })

    it("returns allowlisted DTOs only — no raw model, no prompt/response, deterministic ordering", async () => {
        const prisma = makePrisma()
        prisma.aiUsage.findMany.mockResolvedValue([
            {
                id: 1,
                userId: 3,
                periodType: "MONTHLY",
                periodStart: new Date("2026-09-01T00:00:00.000Z"),
                reservedUnits: 10,
                consumedUnits: 4,
                // فیلد خارج از allowlist — هرگز نباید در خروجی باشد
                internalNote: "secret",
            },
        ])
        prisma.aiUsageEvent.findMany.mockResolvedValue([
            {
                id: 7,
                requestId: "req_abc",
                userId: 3,
                feature: "analyze",
                model: "mock",
                units: 1,
                status: "CONSUMED",
                attempts: 1,
                failureCode: null,
                durationMs: 120,
                createdAt: new Date("2026-09-16T08:00:00.000Z"),
            },
        ])
        prisma.aiUsageEvent.count.mockResolvedValue(1)

        const result = await getAdminAiUsage({ userId: 3 }, { prisma, now: NOW })

        expect(result.quota[0]).toEqual({
            id: 1,
            userId: 3,
            periodType: "MONTHLY",
            periodStart: "2026-09-01T00:00:00.000Z",
            reservedUnits: 10,
            consumedUnits: 4,
        })
        expect(result.events[0]).toEqual({
            id: 7,
            requestId: "req_abc",
            userId: 3,
            feature: "analyze",
            model: "mock",
            units: 1,
            status: "CONSUMED",
            attempts: 1,
            failureCode: null,
            durationMs: 120,
            createdAt: "2026-09-16T08:00:00.000Z",
        })
        // ordering arguments deterministic: createdAt desc, id desc
        const findArgs = prisma.aiUsageEvent.findMany.mock.calls[0][0] as {
            orderBy: Record<string, string>[]
            take: number
            skip: number
        }
        expect(findArgs.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }])
        expect(findArgs.take).toBe(20)
        expect(findArgs.skip).toBe(0)
    })

    it("clamps pageSize to the 100 cap and skips negative pages", async () => {
        const prisma = makePrisma()

        const over = await getAdminAiUsage({ pageSize: 1000 }, { prisma, now: NOW })
        const neg = await getAdminAiUsage({ page: -5 }, { prisma, now: NOW })

        expect(over.pageSize).toBe(ADMIN_QUERY_MAX_PAGE_SIZE)
        expect(neg.page).toBe(1)
    })

    it("fails open — DB rejection yields empty result with the requested page shape", async () => {
        const prisma = makePrisma()
        prisma.aiUsageEvent.findMany.mockRejectedValue(new Error("db down"))

        const result = await getAdminAiUsage({ userId: 3, page: 2, pageSize: 5 }, { prisma, now: NOW })

        expect(result).toEqual({ quota: [], events: [], page: 2, pageSize: 5, total: 0 })
    })

    it("drops malformed rows instead of crashing (allowlist projection guard)", async () => {
        const prisma = makePrisma()
        prisma.aiUsageEvent.findMany.mockResolvedValue([{ broken: true }, null])

        const result = await getAdminAiUsage({}, { prisma, now: NOW })

        expect(result.events).toEqual([])
    })
})

describe("getAdminErrors (Phase 2 primitive — redaction preserved)", () => {
    it("delegates to listErrorLogs and returns the stack-free view shape", async () => {
        const result = await getAdminErrors({ pageSize: 7 })

        expect(result.pageSize).toBe(7)
        expect(result.logs).toEqual([])
        expect(result.total).toBe(0)
    })

    it("delegates stats to getErrorStats (fail-open zeros)", async () => {
        const result = await getAdminErrorStats({ windowHours: 24 })

        expect(result.totalInWindow).toBe(0)
    })
})

describe("getAdminOverview — independent widgets (§12)", () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("users widget delegates to getActiveUserStats with the injected client and now", async () => {
        const count = vi.fn().mockResolvedValue(4)

        const result = await getAdminOverview({
            now: NOW,
            prismaClient: { user: { count } },
        })

        expect(result.users).toEqual({ dau: 4, wau: 4, mau: 4 })
        // window boundaries از now تزریق‌شده مشتق می‌شوند (dau = 24h)
        expect(count.mock.calls[0][0].where.lastSeenAt.gte.toISOString()).toBe(
            "2026-09-16T10:00:00.000Z",
        )
    })

    it("users widget fails open to zeros when the underlying read fails (widget isolation)", async () => {
        const count = vi.fn().mockRejectedValue(new Error("db down"))

        const result = await getAdminOverview({
            now: NOW,
            prismaClient: { user: { count } },
        })

        expect(result.users).toEqual({ dau: 0, wau: 0, mau: 0 })
    })

    it("aiQuota widget aggregates the current period — read-only aggregate only", async () => {
        const aggregate = vi.fn().mockResolvedValue({
            _sum: { reservedUnits: 30, consumedUnits: 12 },
        })

        const result = await getAdminOverview({
            now: NOW,
            prisma: { aiUsage: { aggregate } },
            prismaClient: { user: { count: vi.fn().mockResolvedValue(0) } },
        })

        expect(result.aiQuota).toEqual({
            periodStart: "2026-09-01T00:00:00.000Z",
            reservedUnits: 30,
            consumedUnits: 12,
        })
        const args = aggregate.mock.calls[0][0] as { where: Record<string, unknown> }
        expect(args.where).toEqual({ periodType: "MONTHLY", periodStart: new Date("2026-09-01T00:00:00.000Z") })
    })

    it("aiQuota widget failure leaves only that widget unavailable (§12)", async () => {
        const aggregate = vi.fn().mockRejectedValue(new Error("db down"))

        const result = await getAdminOverview({
            now: NOW,
            prisma: { aiUsage: { aggregate } },
            prismaClient: { user: { count: vi.fn().mockResolvedValue(2) } },
        })

        expect(result.aiQuota).toBeNull()
        expect(result.users).toEqual({ dau: 2, wau: 2, mau: 2 })
        expect(result.errors.totalInWindow).toBe(0)
    })

    it("activity and errors widgets come from Phase 2/3 primitives (fail-open)", async () => {
        const result = await getAdminOverview({
            now: NOW,
            prismaClient: { user: { count: vi.fn().mockResolvedValue(0) } },
        })

        expect(result.activity.windowHours).toBe(24)
        expect(result.errors.totalInWindow).toBe(0)
    })
})

/* ------------------------------------------------------------------ */
/* فاز ۵ — گام ۱۶ (§۲۴): نمای read-only بیلیینگ در admin               */
/* ------------------------------------------------------------------ */

const ENTITLEMENT_ROW = {
    status: "ACTIVE",
    planCode: "PRO",
    provider: "ZARINPAL",
    currentPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
    currentPeriodEnd: new Date("2026-10-01T00:00:00.000Z"),
}

const ORDER_ROW = {
    status: "PAID",
    provider: "ZARINPAL",
    amount: 100000,
    currency: "IRR",
    entitlementDays: 30,
    createdAt: new Date("2026-09-01T09:00:00.000Z"),
    paidAt: new Date("2026-09-01T09:05:00.000Z"),
    providerReference: "REF-1234567890-1234",
}

function makeBillingClient(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        // فقط خواندن — تایپ client هیچ mutationی را expose نمی‌کند
        user: { findUnique: vi.fn().mockResolvedValue({ plan: "PRO" }) },
        entitlement: { findUnique: vi.fn().mockResolvedValue(ENTITLEMENT_ROW) },
        paymentOrder: { findFirst: vi.fn().mockResolvedValue(ORDER_ROW) },
        errorLog: {
            findMany: vi.fn().mockResolvedValue([]),
            count: vi.fn().mockResolvedValue(0),
        },
        ...overrides,
    }
}

describe("maskProviderReference (§24 — masked provider reference)", () => {
    it("keeps only the last 4 characters", () => {
        expect(maskProviderReference("REF-1234567890-1234")).toBe("••••1234")
        expect(maskProviderReference("abcdefgh")).toBe("••••efgh")
    })

    it("fully masks short values (last-4 would leak the whole value)", () => {
        expect(maskProviderReference("1234")).toBe("••••")
        expect(maskProviderReference("ab")).toBe("••••")
    })

    it("returns null for empty/null/undefined/non-string input", () => {
        expect(maskProviderReference("")).toBeNull()
        expect(maskProviderReference("   ")).toBeNull()
        expect(maskProviderReference(null)).toBeNull()
        expect(maskProviderReference(undefined)).toBeNull()
        expect(maskProviderReference(1234 as unknown as string)).toBeNull()
    })
})

describe("getAdminBillingSummary (§24 — stored state, read-only)", () => {
    it("returns plan mirror + entitlement + latest payment + billing error logs only", async () => {
        const client = makeBillingClient()
        client.errorLog.findMany.mockResolvedValue([])

        const summary = await getAdminBillingSummary(5, { prisma: client, now: NOW })

        expect(summary).toEqual({
            plan: "PRO",
            entitlement: {
                status: "ACTIVE",
                planCode: "PRO",
                provider: "ZARINPAL",
                currentPeriodStart: "2026-09-01T00:00:00.000Z",
                currentPeriodEnd: "2026-10-01T00:00:00.000Z",
            },
            latestPayment: {
                status: "PAID",
                provider: "ZARINPAL",
                amount: 100000,
                currency: "IRR",
                entitlementDays: 30,
                createdAt: "2026-09-01T09:00:00.000Z",
                paidAt: "2026-09-01T09:05:00.000Z",
                providerReferenceMasked: "••••1234",
            },
            errorLogs: [],
        })
    })

    it("never exposes raw provider reference/authority or secret fields", async () => {
        const client = makeBillingClient()
        // حتی اگر رکورد مخرب authority/secret هم داشته باشد، projection allowlist آن را حذف می‌کند
        client.paymentOrder.findFirst.mockResolvedValue({
            ...ORDER_ROW,
            providerAuthority: "A-raw-authority-9999",
            merchantOrderId: "mo-raw",
            checkoutIdempotencyKey: "idem-raw",
            failureCode: "RAW_FAILURE",
            requestId: "req-raw",
        })

        const summary = await getAdminBillingSummary(5, { prisma: client, now: NOW })

        const serialized = JSON.stringify(summary)
        for (const forbidden of [
            "A-raw-authority-9999",
            "REF-1234567890-1234",
            "mo-raw",
            "idem-raw",
            "RAW_FAILURE",
            "req-raw",
        ]) {
            expect(serialized).not.toContain(forbidden)
        }
        expect(summary.latestPayment?.providerReferenceMasked).toBe("••••1234")
        expect(Object.keys(summary.latestPayment ?? {}).sort()).toEqual([
            "amount",
            "createdAt",
            "currency",
            "entitlementDays",
            "paidAt",
            "provider",
            "providerReferenceMasked",
            "status",
        ])
    })

    it("issues read-only queries (findUnique/findFirst/findMany) — no resolve/lazy expiration/mutation", async () => {
        const client = makeBillingClient()

        await getAdminBillingSummary(5, { prisma: client, now: NOW })

        expect(client.entitlement.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: 5 } }),
        )
        expect(client.paymentOrder.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { userId: 5 },
                orderBy: { createdAt: "desc" },
            }),
        )
        // client تزریق‌شده هیچ update/create/updateMany/upsert ندارد — mutation ناممکن است
        expect(Object.keys(client.entitlement)).toEqual(["findUnique"])
        expect(Object.keys(client.paymentOrder)).toEqual(["findFirst"])
    })

    it("scopes billing error logs to the billing feature (bounded)", async () => {
        const client = makeBillingClient()

        await getAdminBillingSummary(5, { prisma: client, now: NOW })

        const where = client.errorLog.findMany.mock.calls[0][0].where
        expect(where.userId).toBe(5)
        expect(where.feature).toBe("billing")
        expect(client.errorLog.findMany.mock.calls[0][0].take).toBe(5)
    })

    it("fails closed with USER_NOT_FOUND for an unknown user", async () => {
        const client = makeBillingClient({ user: { findUnique: vi.fn().mockResolvedValue(null) } })

        await expect(getAdminBillingSummary(5, { prisma: client, now: NOW })).rejects.toBeInstanceOf(
            UserNotFoundError,
        )
    })

    it("section isolation: an entitlement read failure only nulls that section", async () => {
        const client = makeBillingClient({
            entitlement: { findUnique: vi.fn().mockRejectedValue(new Error("db down")) },
        })

        const summary = await getAdminBillingSummary(5, { prisma: client, now: NOW })

        expect(summary.entitlement).toBeNull()
        expect(summary.latestPayment?.status).toBe("PAID")
        expect(summary.errorLogs).toEqual([])
    })

    it("drops malformed rows instead of crashing (allowlist projection)", async () => {
        const client = makeBillingClient({
            entitlement: { findUnique: vi.fn().mockResolvedValue({ broken: true }) },
            paymentOrder: { findFirst: vi.fn().mockResolvedValue(null) },
        })

        const summary = await getAdminBillingSummary(5, { prisma: client, now: NOW })

        expect(summary.entitlement).toBeNull()
        expect(summary.latestPayment).toBeNull()
    })

    it("an order without a provider reference masks to null (never a fabricated value)", async () => {
        const client = makeBillingClient({
            paymentOrder: {
                findFirst: vi.fn().mockResolvedValue({ ...ORDER_ROW, status: "PENDING", paidAt: null, providerReference: null }),
            },
        })

        const summary = await getAdminBillingSummary(5, { prisma: client, now: NOW })

        expect(summary.latestPayment?.providerReferenceMasked).toBeNull()
        expect(summary.latestPayment?.paidAt).toBeNull()
    })
})

describe("getUserDetail — billingSummary integration (§24)", () => {
    function makeDetailClient(plan = "PRO") {
        return {
            user: {
                findUnique: vi
                    .fn()
                    .mockResolvedValue({
                        id: 5,
                        username: "u",
                        email: "u@example.com",
                        plan,
                        role: "USER",
                        timezone: "Asia/Tehran",
                        lastSeenAt: new Date("2026-09-17T09:00:00.000Z"),
                    }),
            },
            aiUsage: { findUnique: vi.fn().mockResolvedValue(null) },
            errorLog: {
                findMany: vi.fn().mockResolvedValue([]),
                count: vi.fn().mockResolvedValue(0),
            },
            entitlement: { findUnique: vi.fn().mockResolvedValue(ENTITLEMENT_ROW) },
            paymentOrder: { findFirst: vi.fn().mockResolvedValue(ORDER_ROW) },
        }
    }

    it("includes the billing summary in the detail response", async () => {
        const client = makeDetailClient()

        const detail = await getUserDetail(5, { prisma: client, now: NOW })

        expect(detail.user.plan).toBe("PRO")
        expect(detail.billingSummary?.plan).toBe("PRO")
        expect(detail.billingSummary?.entitlement?.status).toBe("ACTIVE")
        expect(detail.billingSummary?.latestPayment?.providerReferenceMasked).toBe("••••1234")
        expect(detail.billingSummary?.errorLogs).toEqual([])
    })

    it("shows the stored plan mirror and stored entitlement state as-is (no effective-plan resolve / lazy expiration)", async () => {
        // دوره تمام شده ولی status هنوز ACTIVE ذخیره شده؛ پلن آینه‌ای هم PRO است.
        // reader admin نباید lazy expiration را materialize کند یا پلن را بازمحاسبه کند:
        // باید همان state ذخیره‌شده را نشان دهد (هیچ نوشتنی روی این client وجود ندارد).
        const client = makeDetailClient("PRO")
        client.entitlement.findUnique.mockResolvedValue({
            ...ENTITLEMENT_ROW,
            currentPeriodEnd: new Date("2026-01-01T00:00:00.000Z"),
        })

        const detail = await getUserDetail(5, { prisma: client, now: NOW })

        expect(detail.billingSummary?.plan).toBe("PRO")
        expect(detail.billingSummary?.entitlement?.status).toBe("ACTIVE")
        expect(detail.billingSummary?.entitlement?.currentPeriodEnd).toBe("2026-01-01T00:00:00.000Z")
        // فقط خواندن — هیچ update/updateMany/create در client وجود ندارد
        expect(Object.keys(client.entitlement)).toEqual(["findUnique"])
        expect(Object.keys(client.paymentOrder)).toEqual(["findFirst"])
    })

    it("billing read failures degrade only their own section (detail stays intact)", async () => {
        const client = makeDetailClient("FREE")
        client.entitlement.findUnique.mockRejectedValue(new Error("db down"))
        client.paymentOrder.findFirst.mockRejectedValue(new Error("db down"))

        const detail = await getUserDetail(5, { prisma: client, now: NOW })

        expect(detail.user.plan).toBe("FREE")
        expect(detail.billingSummary?.plan).toBe("FREE")
        expect(detail.billingSummary?.entitlement).toBeNull()
        expect(detail.billingSummary?.latestPayment).toBeNull()
        expect(detail.billingSummary?.errorLogs).toEqual([])
        expect(detail.recentErrors).toEqual([])
        // پلن از همان ردیف کاربر گرفته می‌شود — هیچ read دوم/اضافه‌ای برای بخش بیلیینگ نیست
        expect(client.user.findUnique).toHaveBeenCalledTimes(1)
    })
})
