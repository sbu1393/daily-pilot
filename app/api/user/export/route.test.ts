import { beforeEach, describe, expect, it, vi } from "vitest"

import { ServiceError } from "@/app/lib/services/errors"

const mocks = vi.hoisted(() => ({
    requireVerifiedUser: vi.fn(),
    buildUserDataExport: vi.fn(),
    isRateLimited: vi.fn(),
    recordError: vi.fn(),
}))

vi.mock("@/app/lib/requireVerifiedUser", () => ({ requireVerifiedUser: mocks.requireVerifiedUser }))
vi.mock("@/app/lib/services/userData.service", () => ({ buildUserDataExport: mocks.buildUserDataExport }))
vi.mock("@/app/lib/rateLimit", () => ({ isRateLimited: mocks.isRateLimited }))
vi.mock("@/src/lib/observability/recordError", () => ({ recordError: mocks.recordError }))

import { GET } from "./route"

const USER = { id: 7, email: "user@example.com" }

beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireVerifiedUser.mockResolvedValue(USER)
    mocks.isRateLimited.mockReturnValue(false)
    mocks.buildUserDataExport.mockResolvedValue({ profile: { id: 7 }, tasks: [] })
})

describe("GET /api/user/export", () => {
    it("فایل JSON قابل‌دانلود با هدرهای درست برمی‌گرداند", async () => {
        const res = await GET()

        expect(res.status).toBe(200)
        expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8")
        expect(res.headers.get("Content-Disposition")).toBe(
            'attachment; filename="roozsaz-data.json"',
        )
        expect(res.headers.get("Cache-Control")).toBe("no-store")
        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))

        const body = await res.json()
        expect(body).toEqual({ profile: { id: 7 }, tasks: [] })
        expect(mocks.buildUserDataExport).toHaveBeenCalledWith(USER.id)
    })

    it("خروجی را با تورفتگی (JSON مرتب) تولید می‌کند", async () => {
        const res = await GET()
        const text = await res.text()

        expect(text).toContain('\n  "profile"')
    })

    it("بدون نشست → 401 و بدون ساخت خروجی", async () => {
        mocks.requireVerifiedUser.mockRejectedValue(
            new ServiceError(401, "UNAUTHORIZED", "Unauthorized"),
        )

        const res = await GET()

        expect(res.status).toBe(401)
        expect(mocks.buildUserDataExport).not.toHaveBeenCalled()
    })

    it("rate limit → 429 و بدون ساخت خروجی", async () => {
        mocks.isRateLimited.mockReturnValue(true)

        const res = await GET()

        expect(res.status).toBe(429)
        expect(mocks.buildUserDataExport).not.toHaveBeenCalled()
        expect(mocks.isRateLimited).toHaveBeenCalledWith(
            `export:user:${USER.id}`,
            expect.any(Number),
            expect.any(Number),
        )
    })

    it("خطای غیرمنتظره → 500 و recordError", async () => {
        mocks.buildUserDataExport.mockRejectedValue(new Error("db down"))

        const res = await GET()

        expect(res.status).toBe(500)
        expect(mocks.recordError).toHaveBeenCalledTimes(1)
    })
})
