// یادآورها — route tests برای POST /api/notifications/subscribe
//
// مرزهای تست: route با mock لایه سرویس/پیکربندی ایزوله می‌شود؛ هیچ DB یا
// provider واقعی وجود ندارد. تمرکز: احراز هویت، اعتبارسنجی ورودی، rate limit،
// نبودِ پیکربندی VAPID، و این‌که `userId` هرگز از بدنه‌ی کلاینت خوانده نمی‌شود.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    isRateLimited: vi.fn(() => false),
    recordError: vi.fn(),
    isPushConfigured: vi.fn(() => true),
    savePushSubscription: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/rateLimit", () => ({ isRateLimited: mocks.isRateLimited }))
vi.mock("@/src/lib/observability/recordError", () => ({ recordError: mocks.recordError }))
vi.mock("@/app/lib/push/config", () => ({ isPushConfigured: mocks.isPushConfigured }))
vi.mock("@/app/lib/services/push.service", () => ({
    savePushSubscription: mocks.savePushSubscription,
}))

import { POST } from "./route"

const USER = { id: 7, email: "user@example.com" }
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123"

function post(body: unknown) {
    return POST(
        new NextRequest("http://localhost/api/notifications/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: typeof body === "string" ? body : JSON.stringify(body),
        }),
    )
}

const validBody = {
    endpoint: ENDPOINT,
    expirationTime: null,
    keys: { p256dh: "p256dh-value", auth: "auth-value" },
}

beforeEach(() => {
    mocks.getCurrentUser.mockReset().mockResolvedValue(USER)
    mocks.isRateLimited.mockReset().mockReturnValue(false)
    mocks.recordError.mockReset()
    mocks.isPushConfigured.mockReset().mockReturnValue(true)
    mocks.savePushSubscription.mockReset().mockResolvedValue({ id: "sub_1", pruned: 0 })
})

describe("POST /api/notifications/subscribe", () => {
    it("بدون نشست → 401 و هیچ نوشتنی", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await post(validBody)

        expect(res.status).toBe(401)
        expect(await res.json()).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } })
        expect(mocks.savePushSubscription).not.toHaveBeenCalled()
    })

    it("rate limit → 429 قبل از هر نوشتن در DB", async () => {
        mocks.isRateLimited.mockReturnValue(true)

        const res = await post(validBody)

        expect(res.status).toBe(429)
        expect(await res.json()).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } })
        expect(mocks.savePushSubscription).not.toHaveBeenCalled()
        // کلید limiter user-scoped است (پشت NAT/پراکسی درست کار می‌کند)
        const [limiterKey] = mocks.isRateLimited.mock.calls[0] as unknown as [string]
        expect(limiterKey).toBe(`push:subscribe:user:${USER.id}`)
    })

    it("بدنه‌ی نامعتبر → 400 بدون فراخوانی سرویس", async () => {
        const invalidBodies: unknown[] = [
            {},
            { endpoint: ENDPOINT },
            { endpoint: ENDPOINT, keys: { p256dh: "p" } },
            { endpoint: ENDPOINT, keys: { p256dh: "", auth: "a" } },
            { endpoint: "http://insecure.example.com/push", keys: { p256dh: "p", auth: "a" } },
            { endpoint: "not-a-url", keys: { p256dh: "p", auth: "a" } },
            "not-json",
        ]

        for (const body of invalidBodies) {
            const res = await post(body)
            expect(res.status).toBe(400)
            expect(await res.json()).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } })
        }

        expect(mocks.savePushSubscription).not.toHaveBeenCalled()
    })

    it("بدون پیکربندی VAPID → 503 PUSH_NOT_CONFIGURED", async () => {
        mocks.isPushConfigured.mockReturnValue(false)

        const res = await post(validBody)

        expect(res.status).toBe(503)
        expect(await res.json()).toMatchObject({
            ok: false,
            error: { code: "PUSH_NOT_CONFIGURED" },
        })
        expect(mocks.savePushSubscription).not.toHaveBeenCalled()
    })

    it("مسیر موفق: userId از نشست و بدنه فقط endpoint/keys", async () => {
        const res = await post({
            ...validBody,
            // حمله‌ی احتمالی: نسبت دادن اشتراک به کاربر دیگر
            userId: 999,
        })

        expect(res.status).toBe(201)
        expect(res.headers.get("X-Request-ID")).toBeTruthy()
        expect(await res.json()).toMatchObject({ ok: true, data: { id: "sub_1", pruned: 0 } })

        expect(mocks.savePushSubscription).toHaveBeenCalledTimes(1)
        expect(mocks.savePushSubscription).toHaveBeenCalledWith(USER.id, {
            endpoint: ENDPOINT,
            p256dh: "p256dh-value",
            auth: "auth-value",
        })
    })

    it("پاسخ هیچ endpoint/کلیدی را بازنمی‌گرداند", async () => {
        const res = await post(validBody)
        const body = JSON.stringify(await res.json())

        expect(body).not.toContain(ENDPOINT)
        expect(body).not.toContain("p256dh-value")
        expect(body).not.toContain("auth-value")
    })

    it("خطای غیرمنتظره سرویس → 500 و recordError", async () => {
        mocks.savePushSubscription.mockRejectedValue(new Error("db down"))

        const res = await post(validBody)

        expect(res.status).toBe(500)
        expect(await res.json()).toMatchObject({ ok: false, error: { code: "INTERNAL" } })
        expect(mocks.recordError).toHaveBeenCalledTimes(1)
    })
})
