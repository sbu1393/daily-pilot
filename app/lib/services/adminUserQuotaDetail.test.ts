import { beforeEach, describe, expect, it, vi } from "vitest"

/* getAdminUserQuotaDetail — نمای V2-aware سهمیه یک کاربر.
   وابستگی‌های دامنه mock می‌شوند تا فقط منطق همین reader تست شود. */
const mocks = vi.hoisted(() => ({
    resolveEffectivePlan: vi.fn(),
    readCutoverAt: vi.fn(),
    resolveQuotaMode: vi.fn(),
    readQuotaBuckets: vi.fn(),
    resolvePlanPolicy: vi.fn(),
    getMonthlyPeriod: vi.fn(),
}))

vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: () => ({}) }))
vi.mock("./entitlement.service", () => ({ resolveEffectivePlan: mocks.resolveEffectivePlan }))
vi.mock("./aiQuotaCutover.service", () => ({
    readCutoverAt: mocks.readCutoverAt,
    resolveQuotaMode: mocks.resolveQuotaMode,
}))
vi.mock("./aiQuotaV2.service", () => ({ readQuotaBuckets: mocks.readQuotaBuckets }))
vi.mock("./planPolicy.service", () => ({
    getMonthlyPeriod: mocks.getMonthlyPeriod,
    resolvePlanPolicy: mocks.resolvePlanPolicy,
}))

import { getAdminUserQuotaDetail } from "./admin.query"
import { UserNotFoundError } from "./errors"

const NOW = new Date("2026-09-15T10:00:00.000Z")

function makePrisma(overrides: Record<string, unknown> = {}) {
    return {
        user: { findUnique: vi.fn().mockResolvedValue({ timezone: "Asia/Tehran" }) },
        aiUsage: { findUnique: vi.fn().mockResolvedValue(null) },
        ...overrides,
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.getMonthlyPeriod.mockReturnValue({
        periodStart: new Date("2026-09-01T00:00:00.000Z"),
        nextPeriodStart: new Date("2026-10-01T00:00:00.000Z"),
    })
    mocks.readCutoverAt.mockResolvedValue(new Date("2026-09-30T20:30:00.000Z"))
    mocks.resolvePlanPolicy.mockReturnValue({ plan: "FREE", allowedUnits: 15, periodType: "MONTHLY" })
})

describe("getAdminUserQuotaDetail — NEW mode", () => {
    beforeEach(() => {
        mocks.resolveQuotaMode.mockReturnValue("NEW")
        mocks.resolveEffectivePlan.mockResolvedValue("FREE")
        mocks.readQuotaBuckets.mockResolvedValue([
            { feature: "ANALYZE", source: "BASE", capacity: 15, reserved: 2, consumed: 3, remaining: 10 },
            { feature: "ANALYZE", source: "PROMO", capacity: 5, reserved: 0, consumed: 1, remaining: 4 },
            { feature: "PLAN", source: "BASE", capacity: 2, reserved: 0, consumed: 1, remaining: 1 },
            { feature: "PLAN", source: "PROMO", capacity: 0, reserved: 0, consumed: 0, remaining: 0 },
        ])
    })

    it("returns BASE and PROMO separately with a summed totalRemaining", async () => {
        const detail = await getAdminUserQuotaDetail(5, { prisma: makePrisma(), now: NOW })

        expect(detail.mode).toBe("NEW")
        expect(detail.dimensions.analyze.base.remaining).toBe(10)
        expect(detail.dimensions.analyze.promo.remaining).toBe(4)
        expect(detail.dimensions.analyze.totalRemaining).toBe(14)
        expect(detail.dimensions.plan.promo.capacity).toBe(0)
        expect(detail.dimensions.plan.totalRemaining).toBe(1)
    })

    it("passes the effective plan (not User.plan) to readQuotaBuckets", async () => {
        mocks.resolveEffectivePlan.mockResolvedValue("PRO")
        await getAdminUserQuotaDetail(5, { prisma: makePrisma(), now: NOW })

        expect(mocks.resolveEffectivePlan).toHaveBeenCalledWith(expect.anything(), 5, NOW)
        expect(mocks.readQuotaBuckets).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ userId: 5, plan: "PRO" }),
        )
    })
})

describe("getAdminUserQuotaDetail — LEGACY mode", () => {
    it("uses the shared AiUsage pool with resolvePlanPolicy caps", async () => {
        mocks.resolveQuotaMode.mockReturnValue("LEGACY")
        mocks.resolveEffectivePlan.mockResolvedValue("PRO")
        mocks.resolvePlanPolicy.mockReturnValue({ plan: "PRO", allowedUnits: 300, periodType: "MONTHLY" })
        const prisma = makePrisma({
            aiUsage: { findUnique: vi.fn().mockResolvedValue({ reservedUnits: 2, consumedUnits: 1 }) },
        })

        const detail = await getAdminUserQuotaDetail(5, { prisma, now: NOW })

        expect(detail.mode).toBe("LEGACY")
        expect(detail.effectivePlan).toBe("PRO")
        expect(detail.dimensions.analyze.base.capacity).toBe(300)
        expect(detail.dimensions.analyze.base.remaining).toBe(297)
        expect(detail.dimensions.plan.base.remaining).toBe(297)
        expect(mocks.readQuotaBuckets).not.toHaveBeenCalled()
    })
})

describe("getAdminUserQuotaDetail — not found", () => {
    it("throws UserNotFoundError for a missing user", async () => {
        const prisma = makePrisma({ user: { findUnique: vi.fn().mockResolvedValue(null) } })
        await expect(getAdminUserQuotaDetail(999, { prisma })).rejects.toBeInstanceOf(UserNotFoundError)
    })
})
