import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, type NextResponse } from "next/server"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke test: POST /api/auth/register (ADR-04).            */
/* registerUser mocked (no DB); rateLimit + createSession mocked.      */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    isRateLimited: vi.fn(),
    clientIp: vi.fn(),
    createSession: vi.fn(),
    registerUser: vi.fn(),
}))

vi.mock("@/app/lib/rateLimit", () => ({
    isRateLimited: mocks.isRateLimited,
    clientIp: mocks.clientIp,
}))
vi.mock("@/app/lib/createSession", () => ({ createSession: mocks.createSession }))
vi.mock("@/app/lib/services/auth.service", () => ({ registerUser: mocks.registerUser }))

import { POST } from "./route"

describe("POST /api/auth/register — X-Request-ID (فاز صفر §7/§25)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.clientIp.mockReturnValue("1.2.3.4")
        mocks.isRateLimited.mockReturnValue(false)
        mocks.createSession.mockImplementation((_user: unknown, response: unknown) => response)
    })

    it("201 success (with session) carries X-Request-ID", async () => {
        mocks.registerUser.mockResolvedValue(USER)

        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(201)
        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
    })

    it("409 domain error carries X-Request-ID", async () => {
        mocks.registerUser.mockRejectedValue(new EmailTakenError())

        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(409)
        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
    })
})
import { EmailTakenError } from "@/app/lib/services/errors"

const USER = { id: 1, username: "testuser", email: "test@example.com" }
const VALID_BODY = {
    username: "testuser",
    email: "test@example.com",
    password: "secret123",
    confirmPassword: "secret123",
}

const callPOST = (body: unknown) =>
    POST(new NextRequest("http://localhost/api/auth/register", {
        method: "POST",
        body: JSON.stringify(body),
    }))

describe("POST /api/auth/register", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.clientIp.mockReturnValue("1.2.3.4")
        mocks.isRateLimited.mockReturnValue(false)
        mocks.createSession.mockImplementation((_user: unknown, response: NextResponse) => {
            response.cookies.set("token", "mocked-jwt", { httpOnly: true, path: "/" })
            return response
        })
    })

    it("returns 201 with { ok: true, data: { user: { id, email } } } and sets the session cookie", async () => {
        mocks.registerUser.mockResolvedValue(USER)

        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(201)
        await expect(res.json()).resolves.toEqual({
            ok: true,
            data: { user: { id: 1, email: "test@example.com" } },
        })
        expect(mocks.registerUser).toHaveBeenCalledWith({
            username: "testuser",
            email: "test@example.com",
            password: "secret123",
        })
        expect(mocks.createSession).toHaveBeenCalledWith(
            expect.objectContaining({ id: 1, email: "test@example.com" }),
            expect.anything(),
        )
        expect(res.cookies.get("token")?.value).toBe("mocked-jwt")
    })

    it("normalizes email before calling registerUser", async () => {
        mocks.registerUser.mockResolvedValue(USER)

        const res = await callPOST({
            ...VALID_BODY,
            email: "  TEST@Example.COM  ",
        })

        expect(res.status).toBe(201)
        expect(mocks.registerUser).toHaveBeenCalledWith({
            username: "testuser",
            email: "test@example.com",
            password: "secret123",
        })
    })

    it("returns 429 RATE_LIMITED when the IP bucket is exhausted", async () => {
        mocks.isRateLimited.mockReturnValue(true)

        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(429)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("RATE_LIMITED")
        expect(mocks.registerUser).not.toHaveBeenCalled()
    })

    it("propagates ServiceError EMAIL_TAKEN as 409", async () => {
        mocks.registerUser.mockRejectedValue(new EmailTakenError())

        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(409)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("EMAIL_TAKEN")
        expect(mocks.createSession).not.toHaveBeenCalled()
    })

    it.each([
        ["malformed JSON", "{ this is not json"],
        ["empty body", ""],
    ])(
        "returns 400 VALIDATION_ERROR (not 500) for a %s body (M3)",
        async (_label, raw) => {
            const res = await POST(
                new NextRequest("http://localhost/api/auth/register", { method: "POST", body: raw }),
            )

            expect(res.status).toBe(400)
            const parsed = await res.json()
            expect(parsed.ok).toBe(false)
            expect(parsed.error.code).toBe("VALIDATION_ERROR")
            expect(mocks.registerUser).not.toHaveBeenCalled()
            expect(mocks.createSession).not.toHaveBeenCalled()
        },
    )

    it("returns 400 VALIDATION_ERROR for an invalid body and never calls registerUser", async () => {
        const res = await callPOST({
            username: "ab", // <3 کاراکتر
            email: "bad",
            password: "short",
            confirmPassword: "different",
        })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(parsed.error.errors).toBeDefined()
        expect(mocks.registerUser).not.toHaveBeenCalled()
    })

    it("maps an unexpected error to 500 INTERNAL with the fa fallback message", async () => {
        mocks.registerUser.mockRejectedValue(new Error("db exploded"))

        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(500)
        const parsed = await res.json()
        expect(parsed).toEqual({
            ok: false,
            error: { code: "INTERNAL", message: "خطای سرور" },
        })
    })
})