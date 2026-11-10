import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

import { ServiceError, WrongPasswordError } from "@/app/lib/services/errors"

const mocks = vi.hoisted(() => ({
    requireVerifiedUser: vi.fn(),
    deleteUserAccount: vi.fn(),
    isRateLimited: vi.fn(),
    recordError: vi.fn(),
}))

vi.mock("@/app/lib/requireVerifiedUser", () => ({ requireVerifiedUser: mocks.requireVerifiedUser }))
vi.mock("@/app/lib/services/userData.service", () => ({ deleteUserAccount: mocks.deleteUserAccount }))
vi.mock("@/app/lib/rateLimit", () => ({ isRateLimited: mocks.isRateLimited }))
vi.mock("@/src/lib/observability/recordError", () => ({ recordError: mocks.recordError }))

import { DELETE } from "./route"

const USER = { id: 7, email: "user@example.com" }

const callDELETE = (body: unknown) =>
    DELETE(
        new NextRequest("http://localhost/api/user/delete-account", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: typeof body === "string" ? body : JSON.stringify(body),
        }),
    )

beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireVerifiedUser.mockResolvedValue(USER)
    mocks.isRateLimited.mockReturnValue(false)
    mocks.deleteUserAccount.mockResolvedValue(undefined)
})

describe("DELETE /api/user/delete-account", () => {
    it("با رمز درست حساب را حذف و کوکی نشست را منقضی می‌کند", async () => {
        const res = await callDELETE({ password: "secret123" })

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
            ok: true,
            message: "حساب کاربری با موفقیت حذف شد",
        })
        expect(mocks.deleteUserAccount).toHaveBeenCalledWith(USER.id, "secret123")

        const token = res.cookies.get("token")
        expect(token?.value).toBe("")
        expect(token?.maxAge).toBe(0)
        expect(token?.httpOnly).toBe(true)
        expect(token?.path).toBe("/")
    })

    it("بدون نشست → 401 و بدون حذف", async () => {
        mocks.requireVerifiedUser.mockRejectedValue(
            new ServiceError(401, "UNAUTHORIZED", "Unauthorized"),
        )

        const res = await callDELETE({ password: "secret123" })

        expect(res.status).toBe(401)
        expect(mocks.deleteUserAccount).not.toHaveBeenCalled()
    })

    it("rate limit → 429 و بدون حذف", async () => {
        mocks.isRateLimited.mockReturnValue(true)

        const res = await callDELETE({ password: "secret123" })

        expect(res.status).toBe(429)
        expect(mocks.deleteUserAccount).not.toHaveBeenCalled()
        expect(mocks.isRateLimited).toHaveBeenCalledWith(
            `delete-account:user:${USER.id}`,
            expect.any(Number),
            expect.any(Number),
        )
    })

    it.each([
        {},
        { password: "" },
        { password: 123 },
        { password: "secret123", userId: 999 }, // strict: کلید ناشناخته رد می‌شود
        "not-json",
    ])("بدنهٔ نامعتبر → 400 و بدون حذف (%j)", async (body) => {
        const res = await callDELETE(body)

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.deleteUserAccount).not.toHaveBeenCalled()
    })

    it("رمز اشتباه → 401 WRONG_PASSWORD (از سرویس)", async () => {
        mocks.deleteUserAccount.mockRejectedValue(new WrongPasswordError())

        const res = await callDELETE({ password: "wrong" })

        expect(res.status).toBe(401)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("WRONG_PASSWORD")
    })

    it("خطای غیرمنتظره → 500 و recordError", async () => {
        mocks.deleteUserAccount.mockRejectedValue(new Error("db down"))

        const res = await callDELETE({ password: "secret123" })

        expect(res.status).toBe(500)
        expect(mocks.recordError).toHaveBeenCalledTimes(1)
    })
})
