import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* POST /api/promo/redeem — user-facing redemption route tests. */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    redeemPromoCode: vi.fn(),
    isRateLimited: vi.fn(),
    clientIp: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: () => ({}) }))
vi.mock("@/app/lib/services/promoCode.service", () => ({ redeemPromoCode: mocks.redeemPromoCode }))
vi.mock("@/app/lib/rateLimit", () => ({
    isRateLimited: mocks.isRateLimited,
    clientIp: mocks.clientIp,
}))

import { ServiceError } from "@/app/lib/services/errors"
import { POST } from "@/app/api/promo/redeem/route"

const USER = { id: 5, username: "u5", timezone: "Asia/Tehran", role: "USER" }

const req = (body: unknown) =>
    new NextRequest("http://localhost/api/promo/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    })

beforeEach(() => {
    vi.clearAllMocks()
    mocks.getCurrentUser.mockResolvedValue(USER)
    mocks.isRateLimited.mockReturnValue(false)
    mocks.clientIp.mockReturnValue("1.2.3.4")
})

describe("POST /api/promo/redeem — authorization", () => {
    it("401 when unauthenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)
        const res = await POST(req({ code: "ABC" }))
        expect(res.status).toBe(401)
        expect(mocks.redeemPromoCode).not.toHaveBeenCalled()
    })
})

describe("POST /api/promo/redeem — rate limiting", () => {
    it("429 when the per-user limit is hit and never calls the service", async () => {
        mocks.isRateLimited.mockImplementation((key: string) => key.startsWith("promo:user:"))
        const res = await POST(req({ code: "ABC" }))
        expect(res.status).toBe(429)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("RATE_LIMITED")
        expect(mocks.redeemPromoCode).not.toHaveBeenCalled()
    })

    it("429 when the per-IP limit is hit", async () => {
        mocks.isRateLimited.mockImplementation((key: string) => key.startsWith("promo:ip:"))
        const res = await POST(req({ code: "ABC" }))
        expect(res.status).toBe(429)
        expect(mocks.redeemPromoCode).not.toHaveBeenCalled()
    })
})

describe("POST /api/promo/redeem — validation", () => {
    it("400 for an invalid body and never calls the service", async () => {
        const res = await POST(req({ code: "" }))
        expect(res.status).toBe(400)
        expect(mocks.redeemPromoCode).not.toHaveBeenCalled()
    })

    it("rejects extra body fields (strict schema)", async () => {
        const res = await POST(req({ code: "ABC", bonusAnalyzeUnits: 999 }))
        expect(res.status).toBe(400)
        expect(mocks.redeemPromoCode).not.toHaveBeenCalled()
    })
})

describe("POST /api/promo/redeem — success + error mapping", () => {
    it("uses userId/timezone from session (never the body) and returns the safe shape", async () => {
        mocks.redeemPromoCode.mockResolvedValue({
            promoCodeId: "pc1",
            periodStart: new Date("2026-09-01T00:00:00.000Z"),
            bonusAnalyzeUnits: 5,
            bonusPlanUnits: 0,
            grantedFeatures: ["ANALYZE"],
        })

        const res = await POST(req({ code: "WELCOME" }))
        expect(res.status).toBe(200)
        expect(mocks.redeemPromoCode).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ userId: 5, code: "WELCOME", timezone: "Asia/Tehran" }),
        )
        const parsed = await res.json()
        expect(parsed.data.grantedFeatures).toEqual(["ANALYZE"])
        expect(parsed.data.promoCodeId).toBeUndefined()
    })

    it("maps PROMO_CODE_INVALID to 400 (uniform rejection)", async () => {
        mocks.redeemPromoCode.mockRejectedValue(new ServiceError(400, "PROMO_CODE_INVALID", "کد هدیه معتبر نیست"))
        const res = await POST(req({ code: "NOPE" }))
        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("PROMO_CODE_INVALID")
    })

    it("maps PROMO_ALREADY_REDEEMED to 409", async () => {
        mocks.redeemPromoCode.mockRejectedValue(
            new ServiceError(409, "PROMO_ALREADY_REDEEMED", "این کد هدیه را قبلاً استفاده کرده‌اید"),
        )
        const res = await POST(req({ code: "WELCOME" }))
        expect(res.status).toBe(409)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("PROMO_ALREADY_REDEEMED")
    })

    it("maps QUOTA_UNAVAILABLE to 503 with a server-generated requestId (never from client input)", async () => {
        mocks.redeemPromoCode.mockRejectedValue(
            new ServiceError(503, "QUOTA_UNAVAILABLE", "سرویس سهمیه در دسترس نیست؛ بعداً تلاش کن"),
        )

        // کلاینت یک X-Request-ID جعلی می‌فرستد؛ route نباید آن را بپذیرد.
        const spoofed = "spoofed-client-request-id"
        const reqWithSpoofedId = new NextRequest("http://localhost/api/promo/redeem", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Request-ID": spoofed },
            body: JSON.stringify({ code: "WELCOME" }),
        })

        const res = await POST(reqWithSpoofedId)

        // 503 + code
        expect(res.status).toBe(503)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("QUOTA_UNAVAILABLE")

        // requestId server-generated (UUID) و هرگز مقدار جعلی کلاینت نیست
        const requestId = res.headers.get("X-Request-ID")
        expect(typeof requestId).toBe("string")
        expect(requestId).not.toBe(spoofed)
        expect(requestId).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        )

        // raw rejected promo code هرگز در response نیست
        expect(JSON.stringify(parsed)).not.toContain("WELCOME")
    })
})
