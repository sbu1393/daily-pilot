import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* ADR-07 — POST/DELETE /api/push/subscribe (ADR-04 envelope).          */
/* getCurrentUser + push.service mocked: no DB.                        */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    savePushSubscription: vi.fn(),
    removePushSubscription: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/services/push.service", () => ({
    savePushSubscription: mocks.savePushSubscription,
    removePushSubscription: mocks.removePushSubscription,
}))

import { DELETE, POST } from "./route"

const USER = { id: 1, username: "test", email: "test@example.com", timezone: "Asia/Tehran" }
const ENDPOINT = "https://push.example.com/abc"
const VALID_BODY = { endpoint: ENDPOINT, keys: { p256dh: "p256dh-key", auth: "auth-key" } }

function postRequest(body: unknown) {
    return new NextRequest("http://localhost/api/push/subscribe", {
        method: "POST",
        body: typeof body === "string" ? body : JSON.stringify(body),
    })
}

describe("POST /api/push/subscribe", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
    })

    it("returns 201 and saves the subscription for the session user", async () => {
        mocks.savePushSubscription.mockResolvedValue({
            id: "sub_1",
            userId: 1,
            endpoint: ENDPOINT,
            lastSeenAt: new Date("2026-01-01T00:00:00.000Z"),
        })

        const res = await POST(postRequest(VALID_BODY))

        expect(res.status).toBe(201)
        const parsed = await res.json()
        expect(parsed.ok).toBe(true)
        expect(parsed.data).toMatchObject({ id: "sub_1", endpoint: ENDPOINT })
        // کلیدهای حساس هرگز echo نمی‌شوند
        expect(JSON.stringify(parsed)).not.toContain("p256dh-key")
        expect(JSON.stringify(parsed)).not.toContain("auth-key")
        expect(mocks.savePushSubscription).toHaveBeenCalledWith(1, {
            endpoint: ENDPOINT,
            keys: { p256dh: "p256dh-key", auth: "auth-key" },
        })
    })

    it("ignores an injected userId and always binds to the session user", async () => {
        mocks.savePushSubscription.mockResolvedValue({
            id: "sub_1",
            userId: 1,
            endpoint: ENDPOINT,
            lastSeenAt: new Date(),
        })

        const res = await POST(postRequest({ ...VALID_BODY, userId: 999 }))

        expect(res.status).toBe(201)
        expect(mocks.savePushSubscription).toHaveBeenCalledWith(
            1,
            expect.not.objectContaining({ userId: 999 }),
        )
        const savedInput = mocks.savePushSubscription.mock.calls[0][1]
        expect(savedInput).not.toHaveProperty("userId")
    })

    it("returns 401 UNAUTHORIZED when not authenticated and never writes", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await POST(postRequest(VALID_BODY))

        expect(res.status).toBe(401)
        expect(mocks.savePushSubscription).not.toHaveBeenCalled()
    })

    it.each([
        ["missing keys", { endpoint: ENDPOINT }],
        ["invalid endpoint", { endpoint: "nope", keys: { p256dh: "p", auth: "a" } }],
        ["malformed JSON", "{ not json"],
    ])("returns 400 VALIDATION_ERROR for %s and never writes", async (_label, body) => {
        const res = await POST(postRequest(body))

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.savePushSubscription).not.toHaveBeenCalled()
    })

    it("returns 500 INTERNAL on an unexpected service failure", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
        mocks.savePushSubscription.mockRejectedValue(new Error("db down"))

        const res = await POST(postRequest(VALID_BODY))

        expect(res.status).toBe(500)
        errorSpy.mockRestore()
    })
})

describe("DELETE /api/push/subscribe", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
    })

    it("removes only the current user's subscription using the encoded endpoint", async () => {
        mocks.removePushSubscription.mockResolvedValue({ removed: true })

        const res = await DELETE(
            new NextRequest(`http://localhost/api/push/subscribe?endpoint=${encodeURIComponent(ENDPOINT)}`, {
                method: "DELETE",
            }),
        )

        expect(res.status).toBe(200)
        const parsed = await res.json()
        expect(parsed.data).toEqual({ removed: true })
        expect(mocks.removePushSubscription).toHaveBeenCalledWith(1, ENDPOINT)
    })

    it("is idempotent when the subscription is unknown or belongs to someone else", async () => {
        mocks.removePushSubscription.mockResolvedValue({ removed: false })

        const res = await DELETE(
            new NextRequest(`http://localhost/api/push/subscribe?endpoint=${encodeURIComponent(ENDPOINT)}`, {
                method: "DELETE",
            }),
        )

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toMatchObject({ ok: true, data: { removed: false } })
    })

    it("returns 400 VALIDATION_ERROR when endpoint is missing/invalid and never writes", async () => {
        const res = await DELETE(new NextRequest("http://localhost/api/push/subscribe", { method: "DELETE" }))

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.removePushSubscription).not.toHaveBeenCalled()
    })

    it("returns 401 UNAUTHORIZED when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await DELETE(
            new NextRequest(`http://localhost/api/push/subscribe?endpoint=${encodeURIComponent(ENDPOINT)}`, {
                method: "DELETE",
            }),
        )

        expect(res.status).toBe(401)
        expect(mocks.removePushSubscription).not.toHaveBeenCalled()
    })
})
