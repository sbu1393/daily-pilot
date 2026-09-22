// یادآورها — route tests برای POST /api/notifications/unsubscribe
//
// تمرکز اصلی: حذف همیشه userId-scoped است (کاربر A نمی‌تواند اشتراک کاربر B را
// با حدس‌زدن endpoint پاک کند) و لغو دوباره idempotent است.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    isRateLimited: vi.fn(() => false),
    recordError: vi.fn(),
    removePushSubscription: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/rateLimit", () => ({ isRateLimited: mocks.isRateLimited }))
vi.mock("@/src/lib/observability/recordError", () => ({ recordError: mocks.recordError }))
vi.mock("@/app/lib/services/push.service", () => ({
    removePushSubscription: mocks.removePushSubscription,
}))

import { POST } from "./route"

const USER = { id: 7, email: "user@example.com" }
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123"

function post(body: unknown) {
    return POST(
        new NextRequest("http://localhost/api/notifications/unsubscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: typeof body === "string" ? body : JSON.stringify(body),
        }),
    )
}

beforeEach(() => {
    mocks.getCurrentUser.mockReset().mockResolvedValue(USER)
    mocks.isRateLimited.mockReset().mockReturnValue(false)
    mocks.recordError.mockReset()
    mocks.removePushSubscription.mockReset().mockResolvedValue({ removed: 1 })
})

describe("POST /api/notifications/unsubscribe", () => {
    it("بدون نشست → 401", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await post({ endpoint: ENDPOINT })

        expect(res.status).toBe(401)
        expect(mocks.removePushSubscription).not.toHaveBeenCalled()
    })

    it("rate limit → 429", async () => {
        mocks.isRateLimited.mockReturnValue(true)

        const res = await post({ endpoint: ENDPOINT })

        expect(res.status).toBe(429)
        expect(mocks.removePushSubscription).not.toHaveBeenCalled()
        const [limiterKey] = mocks.isRateLimited.mock.calls[0] as unknown as [string]
        expect(limiterKey).toBe(`push:unsubscribe:user:${USER.id}`)
    })

    it("بدنه‌ی نامعتبر → 400", async () => {
        for (const body of [{}, { endpoint: "" }, { endpoint: 42 }, "not-json"]) {
            const res = await post(body)
            expect(res.status).toBe(400)
        }

        expect(mocks.removePushSubscription).not.toHaveBeenCalled()
    })

    it("حذف با userId نشست (بدون IDOR حتی اگر بدنه userId بفرستد)", async () => {
        const res = await post({ endpoint: ENDPOINT, userId: 999 })

        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ ok: true, data: { removed: 1 } })
        expect(mocks.removePushSubscription).toHaveBeenCalledWith(USER.id, ENDPOINT)
    })

    it("endpoint ناشناس → 200 با removed=0 (idempotent، بدون خطا)", async () => {
        mocks.removePushSubscription.mockResolvedValue({ removed: 0 })

        const res = await post({ endpoint: ENDPOINT })

        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ ok: true, data: { removed: 0 } })
    })

    it("خطای غیرمنتظره → 500 و recordError", async () => {
        mocks.removePushSubscription.mockRejectedValue(new Error("db down"))

        const res = await post({ endpoint: ENDPOINT })

        expect(res.status).toBe(500)
        expect(mocks.recordError).toHaveBeenCalledTimes(1)
    })
})
