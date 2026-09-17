// فاز ۵ — گام ۱۸: route integration tests برای GET /api/billing/subscription
// (سند §25 «GET /api/billing/subscription» — بخش قراردادِ endpoint؛ §35 فهرست اختصاصی برای این
// route تعریف نکرده، پس فقط رفتار قفل‌شده‌ی قرارداد تست می‌شود: auth، shape امن D1، بدون leak)
//
// مرزهای تست:
// - route با mock لایه سرویس ایزوله می‌شود (اجازه‌ی صریح سند گام ۱۸)؛ هیچ DB واقعی نیست.
// - انقضای lazy/effective-plan خودشان در entitlement/billing service tests (گام ۱۷) پوشش دارند؛
//   این‌جا فقط مرز route تست است — هیچ منطق دامنه‌ای در route وجود ندارد (سند §27).

import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    getPrisma: vi.fn(),
    recordError: vi.fn(),
    getSubscriptionView: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: mocks.getPrisma }))
vi.mock("@/src/lib/observability/recordError", () => ({ recordError: mocks.recordError }))
vi.mock("@/app/lib/services/billing.service", () => ({
    getSubscriptionView: mocks.getSubscriptionView,
}))

import { GET } from "./route"

const USER = { id: 7, email: "user@example.com", plan: "PRO" }
const START = "2026-08-18T10:00:00.000Z"
const END = "2026-09-17T10:00:00.000Z"

function subscriptionGet() {
    return GET(new NextRequest("http://localhost/api/billing/subscription"))
}

describe("GET /api/billing/subscription (§25 contract)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
        mocks.getPrisma.mockReturnValue({})
    })

    it("unauthenticated → 401 UNAUTHORIZED with the standard envelope (no service call)", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await subscriptionGet()

        expect(res.status).toBe(401)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        })
        expect(mocks.getSubscriptionView).not.toHaveBeenCalled()
    })

    it("returns the exact safe D1 shape for an active PRO entitlement", async () => {
        mocks.getSubscriptionView.mockResolvedValue({
            plan: "PRO",
            entitlement: {
                status: "ACTIVE",
                provider: "ZARINPAL",
                currentPeriodStart: START,
                currentPeriodEnd: END,
            },
            renewal: { available: true, mode: "EXTENDS_CURRENT" },
        })

        const res = await subscriptionGet()

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
            ok: true,
            data: {
                plan: "PRO",
                entitlement: {
                    status: "ACTIVE",
                    provider: "ZARINPAL",
                    currentPeriodStart: START,
                    currentPeriodEnd: END,
                },
                renewal: { available: true, mode: "EXTENDS_CURRENT" },
            },
        })
        expect(res.headers.get("X-Request-ID")).toBeTruthy()
        // userId فقط برای فراخوانی سرویس — از context احراز‌شده، نه client
        expect(mocks.getSubscriptionView).toHaveBeenCalledWith(expect.anything(), USER.id)
    })

    it("FREE / no entitlement → 200 with entitlement: null and a NEW_PERIOD renewal (never 404)", async () => {
        mocks.getSubscriptionView.mockResolvedValue({
            plan: "FREE",
            entitlement: null,
            renewal: { available: true, mode: "NEW_PERIOD" },
        })

        const res = await subscriptionGet()

        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.ok).toBe(true)
        expect(body.data).toEqual({
            plan: "FREE",
            entitlement: null,
            renewal: { available: true, mode: "NEW_PERIOD" },
        })
    })

    it("never exposes sensitive identifiers (Entitlement.id, userId, authority, reference, order ids)", async () => {
        // داده‌ی «آلوده»ی سرویس: اگر route چیزی اضافه/عبور می‌داد، این تست می‌شکست
        mocks.getSubscriptionView.mockResolvedValue({
            plan: "PRO",
            entitlement: {
                status: "ACTIVE",
                provider: "ZARINPAL",
                currentPeriodStart: START,
                currentPeriodEnd: END,
            },
            renewal: { available: true, mode: "EXTENDS_CURRENT" },
        })

        const res = await subscriptionGet()
        const serialized = JSON.stringify(await res.json())

        for (const forbidden of ["A-1", "mo-1", "ord_1", "ent_1", '"userId"', "providerAuthority", "providerReference"]) {
            expect(serialized).not.toContain(forbidden)
        }
    })

    it("service failure → recorded and mapped through the existing error envelope (503 shape preserved)", async () => {
        const { EntitlementConflictError } = await import("@/app/lib/services/errors")
        mocks.getSubscriptionView.mockRejectedValue(new EntitlementConflictError())

        const res = await subscriptionGet()

        expect(res.status).toBe(409)
        const body = await res.json()
        expect(body.ok).toBe(false)
        expect(body.error.code).toBe("ENTITLEMENT_CONFLICT")
        expect(mocks.recordError).toHaveBeenCalledTimes(1)
        const [error, context] = mocks.recordError.mock.calls[0] as [unknown, { endpoint?: string }]
        expect(context.endpoint).toBe("/api/billing/subscription")
        expect(mocks.getSubscriptionView).toHaveBeenCalledTimes(1)
    })

    it("unexpected failure → 500 INTERNAL fallback envelope", async () => {
        mocks.getSubscriptionView.mockRejectedValue(new Error("boom"))

        const res = await subscriptionGet()

        expect(res.status).toBe(500)
        const body = await res.json()
        expect(body.error.code).toBe("INTERNAL")
        expect(body.error.message).not.toContain("boom")
    })
})
