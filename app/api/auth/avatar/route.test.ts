import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke tests: POST + DELETE /api/auth/avatar (ADR-04).    */
/* setAvatar/removeAvatar mocked: no DB / no image storage.            */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    setAvatar: vi.fn(),
    removeAvatar: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/services/auth.service", () => ({
    setAvatar: mocks.setAvatar,
    removeAvatar: mocks.removeAvatar,
}))

import { DELETE, POST } from "./route"

const USER = { id: 1, username: "test", email: "test@example.com", timezone: "Asia/Tehran" }
const VALID_IMAGE = "data:image/png;base64,iVBORw0KGgo="

const callPOST = (body: unknown) =>
    POST(new NextRequest("http://localhost/api/auth/avatar", {
        method: "POST",
        body: body === undefined ? undefined : JSON.stringify(body),
    }))

const callPOSTRaw = (rawBody: string) =>
    POST(new NextRequest("http://localhost/api/auth/avatar", {
        method: "POST",
        body: rawBody,
    }))

describe("POST /api/auth/avatar", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
    })

    it("returns 200 with { ok: true, data: updated, message } for a valid image", async () => {
        const updated = { id: 1, image: VALID_IMAGE }
        mocks.setAvatar.mockResolvedValue(updated)

        const res = await callPOST({ image: VALID_IMAGE })

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
            ok: true,
            data: updated,
            message: expect.any(String),
        })
        expect(mocks.setAvatar).toHaveBeenCalledWith(1, VALID_IMAGE)
    })

    it("returns 400 VALIDATION_ERROR when no image is sent and never calls the service", async () => {
        const res = await callPOST(undefined)

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.setAvatar).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR for a non-JSON body and never calls the service", async () => {
        const res = await callPOSTRaw("not json at all")

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.setAvatar).not.toHaveBeenCalled()
    })

    it.each([
        ["data:image/png;base64,AA!!", "invalid base64 characters"],
        ["data:image/png;base64,AAAAA", "base64 length not a multiple of 4"],
        ["data:image/png;base64,AA=A", "padding not at the end"],
    ])("returns 400 VALIDATION_ERROR for %s", async (image) => {
        const res = await callPOST({ image })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.setAvatar).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR for an unsupported image format (gif)", async () => {
        const res = await callPOST({ image: "data:image/gif;base64,AAAA" })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.setAvatar).not.toHaveBeenCalled()
    })

    it("returns 413 VALIDATION_ERROR for an oversized image payload", async () => {
        const oversized = `data:image/png;base64,${"A".repeat(900_000)}` // > 800KB

        const res = await callPOST({ image: oversized })

        expect(res.status).toBe(413)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.setAvatar).not.toHaveBeenCalled()
    })

    it("returns 401 UNAUTHORIZED when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await callPOST({ image: VALID_IMAGE })

        expect(res.status).toBe(401)
        expect(mocks.setAvatar).not.toHaveBeenCalled()
    })
})

describe("DELETE /api/auth/avatar", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
    })

    it("returns 200 with { ok: true, message }", async () => {
        const res = await DELETE()

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, message: "عکس پروفایل حذف شد" })
        expect(mocks.removeAvatar).toHaveBeenCalledWith(1)
    })

    it("returns 401 UNAUTHORIZED when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await DELETE()

        expect(res.status).toBe(401)
        expect(mocks.removeAvatar).not.toHaveBeenCalled()
    })
})