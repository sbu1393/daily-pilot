import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke test: POST /api/auth/change-password (ADR-04).     */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    changePassword: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/services/auth.service", () => ({ changePassword: mocks.changePassword }))

import { POST } from "./route"
import { SamePasswordError, UserNotFoundError, WrongPasswordError } from "@/app/lib/services/errors"

const USER = { id: 1, username: "test", email: "test@example.com", timezone: "Asia/Tehran" }
const VALID_BODY = {
    currentPassword: "oldpass123",
    newPassword: "newpass123",
    newPasswordConfirm: "newpass123",
}

const callPOST = (body: unknown) =>
    POST(new NextRequest("http://localhost/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify(body),
    }))

const callPOSTRaw = (rawBody: string) =>
    POST(new NextRequest("http://localhost/api/auth/change-password", {
        method: "POST",
        body: rawBody,
    }))

describe("POST /api/auth/change-password", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
    })

    it("returns 200 with { ok: true, message } on success", async () => {
        mocks.changePassword.mockResolvedValue(undefined)

        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, message: "رمز عبور با موفقیت تغییر یافت ✅" })
        expect(mocks.changePassword).toHaveBeenCalledWith(1, "oldpass123", "newpass123")
    })

    it("returns 400 VALIDATION_ERROR when the new passwords do not match and never calls the service", async () => {
        const res = await callPOST({
            currentPassword: "oldpass123",
            newPassword: "newpass123",
            newPasswordConfirm: "different123",
        })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(parsed.error.errors).toBeDefined()
        expect(mocks.changePassword).not.toHaveBeenCalled()
    })

    it("propagates ServiceError WRONG_PASSWORD as 401", async () => {
        mocks.changePassword.mockRejectedValue(new WrongPasswordError())

        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(401)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("WRONG_PASSWORD")
    })

    it("propagates ServiceError SAME_PASSWORD as 400", async () => {
        mocks.changePassword.mockRejectedValue(new SamePasswordError())

        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("SAME_PASSWORD")
    })

    it("returns 400 VALIDATION_ERROR for a malformed JSON body and never calls the service", async () => {
        const res = await callPOSTRaw("{not json")

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.changePassword).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR for a short newPassword and never calls the service", async () => {
        const res = await callPOST({
            currentPassword: "oldpass123",
            newPassword: "short12", // 7 کاراکتر < حداقل ۸
            newPasswordConfirm: "short12",
        })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(parsed.error.errors).toBeDefined()
        expect(mocks.changePassword).not.toHaveBeenCalled()
    })

    it("propagates ServiceError USER_NOT_FOUND as 404", async () => {
        mocks.changePassword.mockRejectedValue(new UserNotFoundError())

        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(404)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("USER_NOT_FOUND")
    })

    it("returns 401 UNAUTHORIZED when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(401)
        expect(mocks.changePassword).not.toHaveBeenCalled()
    })
})