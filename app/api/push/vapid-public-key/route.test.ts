import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn() }))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))

import { GET } from "./route"

const USER = { id: 1, username: "test", email: "test@example.com", timezone: "Asia/Tehran" }

describe("GET /api/push/vapid-public-key", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
    })

    afterEach(() => {
        delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
    })

    it("returns the public key from env", async () => {
        process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "BPublicKeyValue"

        const res = await GET(new NextRequest("http://localhost/api/push/vapid-public-key"))

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: { publicKey: "BPublicKeyValue" } })
    })

    it("returns null (200) when the key is not configured", async () => {
        delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY

        const res = await GET(new NextRequest("http://localhost/api/push/vapid-public-key"))

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: { publicKey: null } })
    })

    it("returns 401 UNAUTHORIZED when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await GET(new NextRequest("http://localhost/api/push/vapid-public-key"))

        expect(res.status).toBe(401)
    })
})
