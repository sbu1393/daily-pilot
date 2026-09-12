import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* M1 (audit) — getCurrentUser: تفکیک خطای انتظاری (توکن نامعتبر/منقضی)  */
/* از خطای غیرانتظاری (دیتابیس/زیرساخت).                                */
/* next/headers و getPrisma mock می‌شوند؛ jsonwebtoken واقعی است تا      */
/* رفتار واقعی verify (منقضی/امضای اشتباه) تست شود.                    */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    cookieToken: vi.fn(),
    findUnique: vi.fn(),
}))

vi.mock("next/headers", () => ({
    cookies: async () => ({ get: (name: string) => mocks.cookieToken(name) }),
}))

vi.mock("./getPrisma", () => ({
    getPrisma: () => ({ user: { findUnique: mocks.findUnique } }),
}))

import jwt from "jsonwebtoken"
import { getCurrentUser } from "./getCurrentUser"

const SECRET = "unit-test-secret"
const OTHER_SECRET = "another-secret"
const USER = { id: 1, username: "test", email: "test@example.com", timezone: "Asia/Tehran" }

const cookieWith = (token: string) => ({ value: token })

describe("getCurrentUser (M1 — auth vs infrastructure failures)", () => {
    const originalSecret = process.env.JWT_SECRET

    beforeEach(() => {
        vi.clearAllMocks()
        process.env.JWT_SECRET = SECRET
        mocks.findUnique.mockResolvedValue(USER)
        mocks.cookieToken.mockReturnValue(
            cookieWith(jwt.sign({ id: 1, email: "test@example.com" }, SECRET)),
        )
    })

    afterEach(() => {
        if (originalSecret === undefined) delete process.env.JWT_SECRET
        else process.env.JWT_SECRET = originalSecret
        vi.restoreAllMocks()
    })

    it("returns the session user for a valid token", async () => {
        await expect(getCurrentUser()).resolves.toEqual(USER)

        expect(mocks.cookieToken).toHaveBeenCalledWith("token")
        expect(mocks.findUnique).toHaveBeenCalledWith({
            where: { id: 1 },
            select: expect.objectContaining({
                id: true,
                username: true,
                email: true,
                timezone: true,
            }),
        })
    })

    it("returns null (no DB call) when the session cookie is absent", async () => {
        mocks.cookieToken.mockReturnValue(undefined)

        await expect(getCurrentUser()).resolves.toBeNull()
        expect(mocks.findUnique).not.toHaveBeenCalled()
    })

    it("returns null (never throws) for an expired token — expected auth failure", async () => {
        mocks.cookieToken.mockReturnValue(
            cookieWith(jwt.sign({ id: 1, email: "test@example.com" }, SECRET, { expiresIn: -10 })),
        )

        await expect(getCurrentUser()).resolves.toBeNull()
        expect(mocks.findUnique).not.toHaveBeenCalled()
    })

    it("returns null (never throws) for a token signed with another secret", async () => {
        mocks.cookieToken.mockReturnValue(
            cookieWith(jwt.sign({ id: 1, email: "test@example.com" }, OTHER_SECRET)),
        )

        await expect(getCurrentUser()).resolves.toBeNull()
        expect(mocks.findUnique).not.toHaveBeenCalled()
    })

    it("logs with context and rethrows on a database failure (M1 — no misleading 401)", async () => {
        const dbError = new Error("connection pool exhausted")
        mocks.findUnique.mockRejectedValue(dbError)
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

        await expect(getCurrentUser()).rejects.toThrow("connection pool exhausted")

        expect(errorSpy).toHaveBeenCalledWith("getCurrentUser: user lookup failed", {
            userId: 1,
            error: dbError,
        })
    })

    it("still throws when JWT_SECRET is missing (unchanged contract)", async () => {
        delete process.env.JWT_SECRET

        await expect(getCurrentUser()).rejects.toThrow("JWT_SECRET is not defined")
        expect(mocks.findUnique).not.toHaveBeenCalled()
    })
})
