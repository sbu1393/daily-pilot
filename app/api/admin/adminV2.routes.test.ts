import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* Admin V2 route tests — requireAdmin + service لایه mock می‌شوند (الگوی route tests repo). */

const mocks = vi.hoisted(() => ({
    requireAdmin: vi.fn(),
    listQuotaPolicies: vi.fn(),
    updateQuotaPolicy: vi.fn(),
    readCutoverAt: vi.fn(),
    resolveCurrentQuotaMode: vi.fn(),
    getMonthlyPeriod: vi.fn(),
    listPromoCodes: vi.fn(),
    createPromoCode: vi.fn(),
    setPromoCodeActive: vi.fn(),
    getAdminUserQuotaDetail: vi.fn(),
    listAdminAuditLogs: vi.fn(),
}))

vi.mock("@/app/lib/requireAdmin", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/requireAdmin")>()),
    requireAdmin: mocks.requireAdmin,
}))
vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: () => ({}) }))
vi.mock("@/app/lib/services/quotaPolicy.service", () => ({
    listQuotaPolicies: mocks.listQuotaPolicies,
    updateQuotaPolicy: mocks.updateQuotaPolicy,
}))
vi.mock("@/app/lib/services/aiQuotaCutover.service", () => ({
    readCutoverAt: mocks.readCutoverAt,
    resolveCurrentQuotaMode: mocks.resolveCurrentQuotaMode,
}))
vi.mock("@/app/lib/services/planPolicy.service", () => ({
    getMonthlyPeriod: mocks.getMonthlyPeriod,
}))
vi.mock("@/app/lib/services/promoCode.service", () => ({
    listPromoCodes: mocks.listPromoCodes,
    createPromoCode: mocks.createPromoCode,
    setPromoCodeActive: mocks.setPromoCodeActive,
}))
vi.mock("@/app/lib/services/admin.query", () => ({
    getAdminUserQuotaDetail: mocks.getAdminUserQuotaDetail,
}))
vi.mock("@/app/lib/services/adminAudit.query", () => ({
    listAdminAuditLogs: mocks.listAdminAuditLogs,
}))

import { ServiceError } from "@/app/lib/services/errors"
import { AdminForbiddenError } from "@/app/lib/requireAdmin"

import { GET as quotaGET, POST as quotaPOST } from "@/app/api/admin/quota-policy/route"
import { GET as promosGET, POST as promosPOST } from "@/app/api/admin/promo-codes/route"
import { PATCH as promoPATCH } from "@/app/api/admin/promo-codes/[id]/route"
import { GET as userQuotaGET } from "@/app/api/admin/users/[id]/quota/route"
import { GET as auditGET } from "@/app/api/admin/audit-log/route"

const ADMIN = { id: 1, role: "ADMIN", plan: "PRO", username: "root" }

const postReq = (url: string, body: unknown) =>
    new NextRequest(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    })

beforeEach(() => {
    vi.clearAllMocks()
    mocks.readCutoverAt.mockResolvedValue(new Date("2026-09-30T20:30:00.000Z"))
    mocks.resolveCurrentQuotaMode.mockReturnValue("NEW")
    mocks.getMonthlyPeriod.mockReturnValue({
        periodStart: new Date("2026-09-01T00:00:00.000Z"),
        nextPeriodStart: new Date("2026-10-01T00:00:00.000Z"),
    })
})

describe("Admin V2 routes — authorization matrix", () => {
    const cases: [string, () => Promise<Response>][] = [
        ["GET quota-policy", () => quotaGET()],
        ["POST quota-policy", () => quotaPOST(postReq("http://x", {}))],
        ["GET promo-codes", () => promosGET()],
        ["POST promo-codes", () => promosPOST(postReq("http://x", {}))],
        ["PATCH promo-codes/[id]", () => promoPATCH(postReq("http://x", { isActive: true }), { params: Promise.resolve({ id: "pc1" }) })],
        ["GET users/[id]/quota", () => userQuotaGET(new NextRequest("http://x"), { params: Promise.resolve({ id: "5" }) })],
        ["GET audit-log", () => auditGET(new NextRequest("http://x"))],
    ]

    for (const [name, handler] of cases) {
        it(`${name}: 401 when unauthenticated`, async () => {
            mocks.requireAdmin.mockRejectedValue(new ServiceError(401, "UNAUTHORIZED", "Unauthorized"))
            const res = await handler()
            expect(res.status).toBe(401)
        })
        it(`${name}: 403 ADMIN_FORBIDDEN for non-admin`, async () => {
            mocks.requireAdmin.mockRejectedValue(new AdminForbiddenError())
            const res = await handler()
            expect(res.status).toBe(403)
            const parsed = await res.json()
            expect(parsed.error.code).toBe("ADMIN_FORBIDDEN")
        })
    }
})

describe("GET /api/admin/quota-policy", () => {
    it("returns policies + cutover context", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        mocks.listQuotaPolicies.mockResolvedValue([
            { plan: "FREE", feature: "ANALYZE", allowedUnits: 15 },
        ])

        const res = await quotaGET()
        expect(res.status).toBe(200)
        const parsed = await res.json()
        expect(parsed.data.policies).toHaveLength(1)
        expect(parsed.data.mode).toBe("NEW")
        expect(typeof parsed.data.periodStart).toBe("string")
    })
})

describe("POST /api/admin/quota-policy", () => {
    it("uses actorUserId from context and accepts a valid payload", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        mocks.updateQuotaPolicy.mockResolvedValue({ plan: "FREE", feature: "ANALYZE", allowedUnits: 5 })

        const res = await quotaPOST(postReq("http://x", { plan: "FREE", feature: "ANALYZE", allowedUnits: 5 }))

        expect(res.status).toBe(200)
        expect(mocks.updateQuotaPolicy).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ plan: "FREE", feature: "ANALYZE", allowedUnits: 5, actorUserId: 1 }),
        )
    })

    it("rejects an invalid payload (negative units) with 400", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        const res = await quotaPOST(postReq("http://x", { plan: "FREE", feature: "ANALYZE", allowedUnits: -1 }))
        expect(res.status).toBe(400)
        expect(mocks.updateQuotaPolicy).not.toHaveBeenCalled()
    })

    it("rejects a body-supplied actorUserId (strict schema)", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        const res = await quotaPOST(postReq("http://x", { plan: "FREE", feature: "ANALYZE", allowedUnits: 5, actorUserId: 999 }))
        expect(res.status).toBe(400)
        expect(mocks.updateQuotaPolicy).not.toHaveBeenCalled()
    })
})

describe("GET/POST /api/admin/promo-codes", () => {
    it("lists promo codes", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        mocks.listPromoCodes.mockResolvedValue([{ id: "pc1", code: "X" }])
        const res = await promosGET()
        expect(res.status).toBe(200)
        const parsed = await res.json()
        expect(parsed.data.items).toHaveLength(1)
    })

    it("creates a promo code using context actor", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        mocks.createPromoCode.mockResolvedValue({
            id: "pc1",
            code: "WELCOME",
            isActive: true,
            validFrom: new Date("2026-09-01T00:00:00.000Z"),
            expiresAt: new Date("2026-10-01T00:00:00.000Z"),
            maxRedemptions: null,
            bonusAnalyzeUnits: 5,
            bonusPlanUnits: 0,
            redeemedCount: 0,
            createdAt: new Date("2026-09-01T00:00:00.000Z"),
        })

        const res = await promosPOST(
            postReq("http://x", {
                code: "WELCOME",
                validFrom: "2026-09-01T00:00:00.000Z",
                expiresAt: "2026-10-01T00:00:00.000Z",
                bonusAnalyzeUnits: 5,
                bonusPlanUnits: 0,
            }),
        )

        expect(res.status).toBe(200)
        expect(mocks.createPromoCode).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ code: "WELCOME", bonusAnalyzeUnits: 5, actorUserId: 1 }),
        )
    })

    it("maps a duplicate code (409) from the service", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        mocks.createPromoCode.mockRejectedValue(new ServiceError(409, "CONFLICT", "این مقدار قبلاً ثبت شده است"))

        const res = await promosPOST(
            postReq("http://x", {
                code: "WELCOME",
                validFrom: "2026-09-01T00:00:00.000Z",
                expiresAt: "2026-10-01T00:00:00.000Z",
                bonusAnalyzeUnits: 5,
                bonusPlanUnits: 0,
            }),
        )

        expect(res.status).toBe(409)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("CONFLICT")
    })
})

describe("PATCH /api/admin/promo-codes/[id]", () => {
    it("toggles and returns 200", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        mocks.setPromoCodeActive.mockResolvedValue(true)
        const res = await promoPATCH(postReq("http://x", { isActive: false }), { params: Promise.resolve({ id: "pc1" }) })
        expect(res.status).toBe(200)
        expect(mocks.setPromoCodeActive).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ promoCodeId: "pc1", isActive: false, actorUserId: 1 }),
        )
    })

    it("returns 404 for a missing id", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        mocks.setPromoCodeActive.mockResolvedValue(false)
        const res = await promoPATCH(postReq("http://x", { isActive: true }), { params: Promise.resolve({ id: "nope" }) })
        expect(res.status).toBe(404)
    })

    it("rejects extra body fields with 400", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        const res = await promoPATCH(postReq("http://x", { isActive: true, code: "HACK" }), { params: Promise.resolve({ id: "pc1" }) })
        expect(res.status).toBe(400)
        expect(mocks.setPromoCodeActive).not.toHaveBeenCalled()
    })
})

describe("GET /api/admin/users/[id]/quota", () => {
    it("400 for a non-integer id", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        const res = await userQuotaGET(new NextRequest("http://x"), { params: Promise.resolve({ id: "abc" }) })
        expect(res.status).toBe(400)
        expect(mocks.getAdminUserQuotaDetail).not.toHaveBeenCalled()
    })

    it("delegates with the parsed id and returns the detail shape", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        mocks.getAdminUserQuotaDetail.mockResolvedValue({
            effectivePlan: "PRO",
            mode: "NEW",
            periodStart: "2026-09-01T00:00:00.000Z",
            dimensions: {
                analyze: { base: { capacity: 1, reserved: 0, consumed: 0, remaining: 1 }, promo: { capacity: 0, reserved: 0, consumed: 0, remaining: 0 }, totalRemaining: 1 },
                plan: { base: { capacity: 1, reserved: 0, consumed: 0, remaining: 1 }, promo: { capacity: 0, reserved: 0, consumed: 0, remaining: 0 }, totalRemaining: 1 },
            },
        })

        const res = await userQuotaGET(new NextRequest("http://x"), { params: Promise.resolve({ id: "5" }) })
        expect(res.status).toBe(200)
        expect(mocks.getAdminUserQuotaDetail).toHaveBeenCalledWith(5)
        const parsed = await res.json()
        expect(parsed.data.effectivePlan).toBe("PRO")
    })

    it("maps USER_NOT_FOUND to 404", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        mocks.getAdminUserQuotaDetail.mockRejectedValue(new ServiceError(404, "USER_NOT_FOUND", "کاربری یافت نشد"))
        const res = await userQuotaGET(new NextRequest("http://x"), { params: Promise.resolve({ id: "999" }) })
        expect(res.status).toBe(404)
    })
})

describe("GET /api/admin/audit-log", () => {
    it("delegates filters and returns a paginated shape", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        mocks.listAdminAuditLogs.mockResolvedValue({ items: [], page: 2, pageSize: 20, total: 21 })

        const res = await auditGET(
            new NextRequest("http://x?action=promo.created&targetType=promo_code&targetId=pc1&actorUserId=7&page=2&limit=20"),
        )

        expect(res.status).toBe(200)
        expect(mocks.listAdminAuditLogs).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                action: "promo.created",
                targetType: "promo_code",
                targetId: "pc1",
                actorUserId: 7,
                page: 2,
                pageSize: 20,
            }),
        )
        const parsed = await res.json()
        expect(parsed.data.hasMore).toBe(false)
    })
})
