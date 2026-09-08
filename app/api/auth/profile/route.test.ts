import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke tests: GET + PATCH /api/auth/profile (ADR-04).     */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    updateProfile: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/services/auth.service", () => ({ updateProfile: mocks.updateProfile }))

import { GET, PATCH } from "./route"
import { UserNotFoundError, UsernameTakenError } from "@/app/lib/services/errors"

const USER = {
    id: 1,
    username: "test",
    email: "test@example.com",
    firstName: null,
    lastName: null,
    image: null,
    birthDate: null,
    phone: null,
    timezone: "Asia/Tehran",
}

const callPATCH = (body: unknown) =>
    PATCH(new NextRequest("http://localhost/api/auth/profile", {
        method: "PATCH",
        body: JSON.stringify(body),
    }))

const callPATCHRaw = (rawBody: string) =>
    PATCH(new NextRequest("http://localhost/api/auth/profile", {
        method: "PATCH",
        body: rawBody,
    }))

describe("GET /api/auth/profile", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
    })

    it("returns 200 with { ok: true, data: user }", async () => {
        const res = await GET()

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: USER })
    })

    it("returns 401 UNAUTHORIZED when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await GET()

        expect(res.status).toBe(401)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        })
    })
})

describe("PATCH /api/auth/profile", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
    })

    it("returns 200 with { ok: true, data: updated, message }", async () => {
        const updated = { ...USER, firstName: "علی" }
        mocks.updateProfile.mockResolvedValue(updated)

        const res = await callPATCH({ username: "test", firstName: "علی" })

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
            ok: true,
            data: updated,
            message: expect.any(String),
        })
        expect(mocks.updateProfile).toHaveBeenCalledWith(1, "test", { username: "test", firstName: "علی" })
    })

    it("returns 400 VALIDATION_ERROR for an invalid body and never calls the service", async () => {
        const res = await callPATCH({ username: "ab" }) // <3 کاراکتر

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(parsed.error.errors).toBeDefined()
        expect(mocks.updateProfile).not.toHaveBeenCalled()
    })

    it("propagates ServiceError USER_NOT_FOUND as 404", async () => {
        mocks.updateProfile.mockRejectedValue(new UserNotFoundError())

        const res = await callPATCH({ username: "test", firstName: "علی" })

        expect(res.status).toBe(404)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("USER_NOT_FOUND")
    })

    it("returns 400 VALIDATION_ERROR for a malformed JSON body and never calls the service", async () => {
        const res = await callPATCHRaw("{not json")

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.updateProfile).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR for an invalid birthDate and never calls the service", async () => {
        const res = await callPATCH({ username: "test", birthDate: "2026-13-01" })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(parsed.error.errors).toBeDefined()
        expect(mocks.updateProfile).not.toHaveBeenCalled()
    })

    it("accepts a valid birthDate and forwards it to the service", async () => {
        const updated = { ...USER, birthDate: "2026-01-01T00:00:00.000Z" }
        mocks.updateProfile.mockResolvedValue(updated)

        const res = await callPATCH({ username: "test", birthDate: "2026-01-01" })

        expect(res.status).toBe(200)
        const parsed = await res.json()
        expect(parsed.ok).toBe(true)
        expect(parsed.data).toEqual(updated)
        expect(mocks.updateProfile).toHaveBeenCalledWith(1, "test", { username: "test", birthDate: "2026-01-01" })
    })

    it("propagates ServiceError USERNAME_TAKEN as 409", async () => {
        mocks.updateProfile.mockRejectedValue(new UsernameTakenError())

        const res = await callPATCH({ username: "taken", firstName: "علی" })

        expect(res.status).toBe(409)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("USERNAME_TAKEN")
    })

    it("returns 401 UNAUTHORIZED when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await callPATCH({ username: "test", firstName: "علی" })

        expect(res.status).toBe(401)
        expect(mocks.updateProfile).not.toHaveBeenCalled()
    })
})