import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke tests: GET + PATCH /api/auth/profile (ADR-04).     */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    updateProfile: vi.fn(),
    touchAuthenticatedActivity: vi.fn(),
    recordProductEvent: vi.fn(),
    getPrisma: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/services/auth.service", () => ({ updateProfile: mocks.updateProfile }))
vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: mocks.getPrisma }))
vi.mock("@/app/lib/services/userActivity.service", () => ({
    touchAuthenticatedActivity: mocks.touchAuthenticatedActivity,
}))
vi.mock("@/app/lib/services/productEvent.service", () => ({
    recordProductEvent: mocks.recordProductEvent,
}))

import { GET, PATCH } from "./route"

describe("/api/auth/profile — X-Request-ID (فاز صفر §7)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
        mocks.touchAuthenticatedActivity.mockResolvedValue({ touched: true })
        mocks.recordProductEvent.mockResolvedValue({ recorded: true, eventName: "profile.updated" })
        mocks.getPrisma.mockReturnValue({})
    })

    it("GET 200 success carries X-Request-ID", async () => {
        const res = await GET()

        expect(res.status).toBe(200)
        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
    })

    it("GET 401 response carries X-Request-ID", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await GET()

        expect(res.status).toBe(401)
        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
    })

    it("PATCH response always carries X-Request-ID", async () => {
        mocks.updateProfile.mockResolvedValue({ id: 1, username: "test" })

        const res = await callPATCH({ firstName: "A" })

        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
    })
})
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
        mocks.touchAuthenticatedActivity.mockResolvedValue({ touched: true })
        mocks.recordProductEvent.mockResolvedValue({ recorded: true, eventName: "profile.updated" })
        mocks.getPrisma.mockReturnValue({})
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

    /* فاز ۳ — گام ۸: integration تحلیل (touch + profile.updated). */

    it("touches activity and records profile.updated after a successful update", async () => {
        mocks.updateProfile.mockResolvedValue({ ...USER, firstName: "علی" })

        const res = await callPATCH({ username: "test", firstName: "علی" })

        expect(res.status).toBe(200)
        expect(mocks.touchAuthenticatedActivity).toHaveBeenCalledTimes(1)
        expect(mocks.recordProductEvent).toHaveBeenCalledTimes(1)
        expect(mocks.recordProductEvent).toHaveBeenCalledWith(
            1,
            "profile.updated",
            { changedFields: ["firstName"] },
            expect.objectContaining({ requestId: expect.any(String), feature: "auth" }),
        )
    })

    it("changedFields contains field names only — never any values", async () => {
        mocks.updateProfile.mockResolvedValue({ ...USER, firstName: "علی", lastName: "رضایی" })

        await callPATCH({ username: "newname", firstName: "علی", lastName: "رضایی" })

        const props = mocks.recordProductEvent.mock.calls[0][2]
        expect(Object.keys(props).sort()).toEqual(["changedFields"])
        expect(props.changedFields).toEqual(["username", "firstName", "lastName"])
    })

    it("email/phone/password/avatar values never reach the event properties", async () => {
        mocks.updateProfile.mockResolvedValue({ ...USER, phone: "09121234567" })

        await callPATCH({
            username: "test",
            phone: "09121234567", // مقدار تلفن — هرگز در properties
        })

        const args = JSON.stringify(mocks.recordProductEvent.mock.calls[0])
        expect(args).not.toContain("09121234567")
        expect(args).not.toContain("test@example.com")
        expect(mocks.recordProductEvent).toHaveBeenCalledWith(
            1,
            "profile.updated",
            { changedFields: ["phone"] },
            expect.anything(),
        )
    })

    it("emits no event and no touch on validation/business failure", async () => {
        mocks.updateProfile.mockRejectedValue(new UsernameTakenError())

        const res = await callPATCH({ username: "taken" })

        expect(res.status).toBe(409)
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
    })

    it("keeps the 200 response unchanged when analytics fails (fail-open)", async () => {
        mocks.updateProfile.mockResolvedValue({ ...USER, firstName: "علی" })
        mocks.touchAuthenticatedActivity.mockRejectedValue(new Error("analytics db down"))

        const res = await callPATCH({ username: "test", firstName: "علی" })

        expect(res.status).toBe(200)
        const parsed = await res.json()
        expect(parsed.ok).toBe(true)
        expect(parsed.data.firstName).toBe("علی")
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
    })

    it("keeps the 200 response when recordProductEvent itself fails (fail-open)", async () => {
        mocks.updateProfile.mockResolvedValue({ ...USER, firstName: "علی" })
        mocks.recordProductEvent.mockRejectedValue(new Error("event insert failed"))

        const res = await callPATCH({ username: "test", firstName: "علی" })

        expect(res.status).toBe(200)
        const parsed = await res.json()
        expect(parsed.ok).toBe(true)
    })

    it("propagates the requestId (correlation only)", async () => {
        mocks.updateProfile.mockResolvedValue({ ...USER, firstName: "علی" })

        await callPATCH({ username: "test", firstName: "علی" })

        const ctx = mocks.recordProductEvent.mock.calls[0][3]
        expect(ctx.requestId).toEqual(expect.any(String))
        expect(ctx.endpoint).toBe("/api/auth/profile")
        expect(ctx.feature).toBe("auth")
    })
})