import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, type NextResponse } from "next/server"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke test: POST /api/auth/login (ADR-04).               */
/* authenticate mocked (no DB); rateLimit mocked; createSession mocked */
/* (cookie behavior asserted via the mock, no JWT generation).         */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    isRateLimited: vi.fn(),
    clientIp: vi.fn(),
    createSession: vi.fn(),
    authenticate: vi.fn(),
}))

vi.mock("@/app/lib/rateLimit", () => ({
    isRateLimited: mocks.isRateLimited,
    clientIp: mocks.clientIp,
}))
vi.mock("@/app/lib/createSession", () => ({ createSession: mocks.createSession }))
vi.mock("@/app/lib/services/auth.service", () => ({ authenticate: mocks.authenticate }))

import { POST } from "./route"
import { InvalidCredentialsError } from "@/app/lib/services/errors"

const USER = { id: 1, username: "test", email: "test@example.com" }
const VALID_BODY = { email: "test@example.com", password: "secret123" }

const callPOST = (body: unknown) =>
    POST(new NextRequest("http://localhost/api/auth/login", {
        method: "POST",
        body: JSON.stringify(body),
    }))

describe("POST /api/auth/login", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.clientIp.mockReturnValue("1.2.3.4")
        mocks.isRateLimited.mockReturnValue(false)
        mocks.createSession.mockImplementation((_user: unknown, response: NextResponse) => {
            response.cookies.set("token", "mocked-jwt", { httpOnly: true, path: "/" })
            return response
        })
    })

    it("returns 200 with { ok: true, data: { user } } and sets the session cookie via createSession", async () => {
        mocks.authenticate.mockResolvedValue(USER)

        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
            ok: true,
            data: { user: { id: 1, username: "test", email: "test@example.com" } },
        })
        expect(mocks.authenticate).toHaveBeenCalledWith(
            "test@example.com",
            "secret123",
        )
        expect(mocks.createSession).toHaveBeenCalledWith(
            expect.objectContaining({ id: 1, email: "test@example.com" }),
            expect.anything(),
        )
        expect(res.cookies.get("token")?.value).toBe("mocked-jwt")
    })

    it("normalizes email before rate limiting and authentication", async () => {
        mocks.authenticate.mockResolvedValue(USER)

        const res = await callPOST({
            email: "  TEST@Example.COM  ",
            password: "secret123",
        })

        expect(res.status).toBe(200)
        expect(mocks.isRateLimited).toHaveBeenCalledWith(
            "login:email:test@example.com",
            5,
        )
        expect(mocks.authenticate).toHaveBeenCalledWith(
            "test@example.com",
            "secret123",
        )
    })

    it("returns 429 RATE_LIMITED when the IP bucket is exhausted (before body/validation)", async () => {
        mocks.isRateLimited.mockImplementation((key: string) => key.startsWith("login:ip:"))

        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(429)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("RATE_LIMITED")
        expect(mocks.authenticate).not.toHaveBeenCalled()
    })

    it("returns 429 RATE_LIMITED when the email bucket is exhausted", async () => {
        mocks.isRateLimited.mockImplementation((key: string) => key.startsWith("login:email:"))

        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(429)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("RATE_LIMITED")
        expect(mocks.authenticate).not.toHaveBeenCalled()
    })

    it("propagates ServiceError INVALID_CREDENTIALS as 401", async () => {
        mocks.authenticate.mockRejectedValue(new InvalidCredentialsError())

        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(401)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("INVALID_CREDENTIALS")
        expect(mocks.createSession).not.toHaveBeenCalled()
    })

    it.each([
        ["malformed JSON", "{ this is not json"],
        ["empty body", ""],
    ])(
        "returns 400 VALIDATION_ERROR (not 500) for a %s body (M3)",
        async (_label, raw) => {
            const res = await POST(
                new NextRequest("http://localhost/api/auth/login", { method: "POST", body: raw }),
            )

            expect(res.status).toBe(400)
            const parsed = await res.json()
            expect(parsed.ok).toBe(false)
            expect(parsed.error.code).toBe("VALIDATION_ERROR")
            expect(mocks.authenticate).not.toHaveBeenCalled()
            expect(mocks.createSession).not.toHaveBeenCalled()
        },
    )

    it("returns 400 VALIDATION_ERROR for an invalid body and never calls authenticate", async () => {
        const res = await callPOST({ email: "not-an-email", password: "" })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(parsed.error.errors).toBeDefined()
        expect(mocks.authenticate).not.toHaveBeenCalled()
        expect(mocks.createSession).not.toHaveBeenCalled()
    })
})