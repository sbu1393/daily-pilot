// GET /api/ai/quota — تست‌های قرارداد endpoint
//
// این تست‌ها قفل می‌کنند که مسیر نمایش، همان رفتار مرجع را دارد:
//   • بدون نشست ⇒ 401
//   • `userId` **فقط** از `getCurrentUser()` می‌آید — هیچ ورودی‌ای از درخواست
//     خوانده نمی‌شود، پس «سهمیهٔ کاربر دیگر» از این مسیر قابل درخواست نیست.
//   • فقط GET وجود دارد؛ هیچ متد mutationی صادر نمی‌شود.
//   • پاسخ فقط شماره‌های لازم UI را دارد و فیلد audit/internal لو نمی‌دهد.

import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    getPrisma: vi.fn(),
    recordError: vi.fn(),
    readAiQuotaStatus: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: mocks.getPrisma }))
vi.mock("@/src/lib/observability/recordError", () => ({ recordError: mocks.recordError }))
vi.mock("@/app/lib/services/aiQuotaStatus.service", () => ({
    readAiQuotaStatus: mocks.readAiQuotaStatus,
}))

const STATUS = {
    analyze: { remaining: 9, granted: 15, consumed: 6, promoRemaining: 0 },
    plan: { remaining: 2, granted: 2, consumed: 0, promoRemaining: 2 },
    mode: "NEW" as const,
    periodStart: "2026-09-01T00:00:00.000Z",
}

function user(overrides: Record<string, unknown> = {}) {
    return { id: 7, plan: "FREE", timezone: "Asia/Tehran", role: "USER", ...overrides }
}

async function call() {
    const { GET } = await import("./route")
    return GET()
}

describe("GET /api/ai/quota", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getPrisma.mockReturnValue({})
        mocks.readAiQuotaStatus.mockResolvedValue(STATUS)
    })

    it("کاربر احراز‌شده سهمیهٔ خودش را می‌گیرد", async () => {
        mocks.getCurrentUser.mockResolvedValue(user())

        const res = await call()
        const json = await res.json()

        expect(res.status).toBe(200)
        expect(json.ok).toBe(true)
        expect(json.data).toEqual(STATUS)
    })

    it("userId از session گرفته می‌شود، نه از درخواست", async () => {
        mocks.getCurrentUser.mockResolvedValue(user({ id: 4242 }))

        await call()

        expect(mocks.readAiQuotaStatus).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ userId: 4242 }),
        )
    })

    it("plan مؤثر و timezone کاربر مستقیم به سرویس داده می‌شود", async () => {
        mocks.getCurrentUser.mockResolvedValue(user({ plan: "PRO", timezone: "Asia/Tehran" }))

        await call()

        expect(mocks.readAiQuotaStatus).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ plan: "PRO", timezone: "Asia/Tehran" }),
        )
    })

    it("timezone نبود ⇒ UTC (بدون crash)", async () => {
        mocks.getCurrentUser.mockResolvedValue(user({ timezone: null }))

        const res = await call()

        expect(res.status).toBe(200)
        expect(mocks.readAiQuotaStatus).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ timezone: "UTC" }),
        )
    })

    it("بدون نشست ⇒ 401 و سرویس اصلاً صدا زده نمی‌شود", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await call()
        const json = await res.json()

        expect(res.status).toBe(401)
        expect(json.ok).toBe(false)
        expect(mocks.readAiQuotaStatus).not.toHaveBeenCalled()
    })

    it("خطای quota (fail-closed) از مسیر استاندارد ServiceError برمی‌گردد", async () => {
        mocks.getCurrentUser.mockResolvedValue(user())
        const { QuotaUnavailableError } = await import("@/app/lib/services/errors")
        mocks.readAiQuotaStatus.mockRejectedValue(new QuotaUnavailableError())

        const res = await call()
        const json = await res.json()

        expect(res.status).toBe(503)
        expect(json.error.code).toBe("QUOTA_UNAVAILABLE")
    })

    it("خطای ناشناخته ⇒ 500 و یک رکورد observability", async () => {
        mocks.getCurrentUser.mockResolvedValue(user())
        mocks.readAiQuotaStatus.mockRejectedValue(new Error("boom"))

        const res = await call()

        expect(res.status).toBe(500)
        expect(mocks.recordError).toHaveBeenCalledTimes(1)
    })

    it("هیچ فیلد audit/internal در پاسخ نیست", async () => {
        mocks.getCurrentUser.mockResolvedValue(user())

        const res = await call()
        const json = await res.json()

        expect(Object.keys(json.data).sort()).toEqual([
            "analyze",
            "mode",
            "periodStart",
            "plan",
        ])
        expect(Object.keys(json.data.analyze).sort()).toEqual([
            "consumed",
            "granted",
            "promoRemaining",
            "remaining",
        ])
    })

    it("هیچ متد mutationی ندارد (فقط GET)", async () => {
        const mod = await import("./route")

        expect((mod as Record<string, unknown>).POST).toBeUndefined()
        expect((mod as Record<string, unknown>).PATCH).toBeUndefined()
        expect((mod as Record<string, unknown>).PUT).toBeUndefined()
        expect((mod as Record<string, unknown>).DELETE).toBeUndefined()
    })
})
