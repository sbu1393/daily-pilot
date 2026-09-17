import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* فاز ۴ — Step 4: requireAdmin                                        */
/* getCurrentUser mock می‌شود (قرارداد repository: no DB in unit tests)  */
/* — هدف گارد authorization است، نه authentication (که در               */
/* getCurrentUser.test.ts پوشش داده شده).                              */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
}))

vi.mock("./getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))

import { requireAdmin, AdminForbiddenError } from "./requireAdmin"
import { ServiceError } from "@/app/lib/services/errors"

const BASE_USER = {
    id: 1,
    username: "test",
    email: "test@example.com",
    timezone: "Asia/Tehran",
    plan: "FREE",
    role: "USER",
}

describe("requireAdmin (Phase 4 — Step 4)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("401 — unauthenticated (no user) throws UNAUTHORIZED ServiceError", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        await expect(requireAdmin()).rejects.toMatchObject({
            status: 401,
            code: "UNAUTHORIZED",
        })
    })

    it("403 — authenticated USER (role=USER) throws ADMIN_FORBIDDEN", async () => {
        mocks.getCurrentUser.mockResolvedValue({ ...BASE_USER, role: "USER" })

        const err = await requireAdmin().catch((e) => e)
        expect(err).toBeInstanceOf(AdminForbiddenError)
        expect(err).toBeInstanceOf(ServiceError)
        expect(err.status).toBe(403)
        expect(err.code).toBe("ADMIN_FORBIDDEN")
    })

    it("allowed — ADMIN passes and the admin user is returned to the caller", async () => {
        const admin = { ...BASE_USER, role: "ADMIN" }
        mocks.getCurrentUser.mockResolvedValue(admin)

        await expect(requireAdmin()).resolves.toMatchObject({
            id: 1,
            role: "ADMIN",
        })
    })

    it("role comes only from getCurrentUser() — exactly one call per guard invocation", async () => {
        mocks.getCurrentUser.mockResolvedValue({ ...BASE_USER, role: "ADMIN" })

        await requireAdmin()

        expect(mocks.getCurrentUser).toHaveBeenCalledTimes(1)
    })

    it("plan=PRO does not authorize — only role=ADMIN does (Role ≠ Plan)", async () => {
        mocks.getCurrentUser.mockResolvedValue({ ...BASE_USER, plan: "PRO", role: "USER" })

        await expect(requireAdmin()).rejects.toMatchObject({
            status: 403,
            code: "ADMIN_FORBIDDEN",
        })
    })

    it("email/username are never authorization signals — any identity with role=USER is forbidden", async () => {
        mocks.getCurrentUser.mockResolvedValue({
            ...BASE_USER,
            email: "admin-looking@example.com",
            username: "admin",
            role: "USER",
        })

        await expect(requireAdmin()).rejects.toMatchObject({
            status: 403,
            code: "ADMIN_FORBIDDEN",
        })
    })

    it("DB error from getCurrentUser propagates (infrastructure failure, not a 401/403)", async () => {
        const dbError = new Error("connection pool exhausted")
        mocks.getCurrentUser.mockRejectedValue(dbError)

        await expect(requireAdmin()).rejects.toThrow("connection pool exhausted")
    })
})
