// یادآورها — route tests برای POST /api/notifications/test (تشخیصی)
//
// گیرنده همیشه کاربر نشست است؛ هیچ ورودی‌ای از کلاینت نمی‌تواند کاربر دیگری را
// هدف بگیرد. rate limit سخت‌گیرانه‌تر است چون هر فراخوانی به provider بیرونی می‌زند.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    isRateLimited: vi.fn(() => false),
    recordError: vi.fn(),
    isPushConfigured: vi.fn(() => true),
    sendPushToUser: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/rateLimit", () => ({ isRateLimited: mocks.isRateLimited }))
vi.mock("@/src/lib/observability/recordError", () => ({ recordError: mocks.recordError }))
vi.mock("@/app/lib/push/config", () => ({ isPushConfigured: mocks.isPushConfigured }))
vi.mock("@/app/lib/services/push.service", () => ({ sendPushToUser: mocks.sendPushToUser }))

import { POST } from "./route"

const USER = { id: 7, email: "user@example.com" }

function post(body?: unknown) {
    return POST(
        new NextRequest("http://localhost/api/notifications/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        }),
    )
}

beforeEach(() => {
    mocks.getCurrentUser.mockReset().mockResolvedValue(USER)
    mocks.isRateLimited.mockReset().mockReturnValue(false)
    mocks.recordError.mockReset()
    mocks.isPushConfigured.mockReset().mockReturnValue(true)
    mocks.sendPushToUser
        .mockReset()
        .mockResolvedValue({ configured: true, sent: 2, failed: 0, removed: 1 })
})

describe("POST /api/notifications/test", () => {
    it("بدون نشست → 401 و هیچ ارسالی", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await post()

        expect(res.status).toBe(401)
        expect(mocks.sendPushToUser).not.toHaveBeenCalled()
    })

    it("rate limit → 429 قبل از هر ارسال به provider", async () => {
        mocks.isRateLimited.mockReturnValue(true)

        const res = await post()

        expect(res.status).toBe(429)
        expect(mocks.sendPushToUser).not.toHaveBeenCalled()
        const limiterCall = mocks.isRateLimited.mock.calls[0] as unknown as [string, number, number]
        expect(limiterCall).toEqual([`push:test:user:${USER.id}`, 5, 900_000])
    })

    it("بدون پیکربندی VAPID → 503 PUSH_NOT_CONFIGURED", async () => {
        mocks.isPushConfigured.mockReturnValue(false)

        const res = await post()

        expect(res.status).toBe(503)
        expect(await res.json()).toMatchObject({ ok: false, error: { code: "PUSH_NOT_CONFIGURED" } })
        expect(mocks.sendPushToUser).not.toHaveBeenCalled()
    })

    it("مسیر موفق: گیرنده فقط کاربر نشست و payload ثابت/بی‌خطر", async () => {
        const res = await post()

        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({
            ok: true,
            data: { configured: true, sent: 2, failed: 0, removed: 1 },
        })

        expect(mocks.sendPushToUser).toHaveBeenCalledTimes(1)
        const [userId, payload] = mocks.sendPushToUser.mock.calls[0] as [
            number,
            Record<string, unknown>,
        ]
        expect(userId).toBe(USER.id)
        expect(Object.keys(payload).sort()).toEqual(["body", "tag", "title", "url"])
        expect(payload.url).toBe("/dashboard")
    })

    it("اگر کاربر هیچ دستگاهی نداشته باشد → 200 با شمارنده‌های صفر", async () => {
        mocks.sendPushToUser.mockResolvedValue({ configured: true, sent: 0, failed: 0, removed: 0 })

        const res = await post()

        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({ ok: true, data: { sent: 0, failed: 0, removed: 0 } })
    })

    it("خطای غیرمنتظره → 500 و recordError", async () => {
        mocks.sendPushToUser.mockRejectedValue(new Error("db down"))

        const res = await post()

        expect(res.status).toBe(500)
        expect(mocks.recordError).toHaveBeenCalledTimes(1)
    })
})
