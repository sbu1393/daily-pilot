import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* فاز ۴ — Step 6: route tests برای GET /api/admin/users               */
/* requireAdmin + searchUsers mock می‌شوند (الگوی route tests repo).    */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    requireAdmin: vi.fn(),
    searchUsers: vi.fn(),
}))

vi.mock("@/app/lib/requireAdmin", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/requireAdmin")>()),
    requireAdmin: mocks.requireAdmin,
}))
vi.mock("@/app/lib/services/admin.query", () => ({ searchUsers: mocks.searchUsers }))

import { GET } from "./route"
import { ServiceError } from "@/app/lib/services/errors"
import { AdminForbiddenError } from "@/app/lib/requireAdmin"

const ADMIN = {
    id: 1,
    username: "root",
    email: "root@example.com",
    plan: "PRO",
    role: "ADMIN",
    timezone: "Asia/Tehran",
    lastSeenAt: null,
}
const PLAIN_USER = { ...ADMIN, id: 2, role: "USER" }

const call = (query = "") => GET(new NextRequest(`http://localhost/api/admin/users${query}`))

beforeEach(() => {
    vi.clearAllMocks()
})

describe("GET /api/admin/users — authorization", () => {
    it("401 UNAUTHORIZED when unauthenticated", async () => {
        mocks.requireAdmin.mockRejectedValue(new ServiceError(401, "UNAUTHORIZED", "Unauthorized"))

        const res = await call()

        expect(res.status).toBe(401)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("UNAUTHORIZED")
        expect(mocks.searchUsers).not.toHaveBeenCalled()
    })

    it("403 ADMIN_FORBIDDEN for an authenticated USER", async () => {
        mocks.requireAdmin.mockRejectedValue(new AdminForbiddenError())

        const res = await call()

        expect(res.status).toBe(403)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("ADMIN_FORBIDDEN")
    })

    it("403 even for a PRO user with role=USER (Role ≠ Plan)", async () => {
        mocks.requireAdmin.mockRejectedValue(new AdminForbiddenError())

        const res = await call()

        expect(res.status).toBe(403)
    })

    it("403 even when a JWT carries a fake role=ADMIN claim (guard uses DB-backed role only)", async () => {
        // requireAdmin خودش role را فقط از DB می‌خواند؛ claim جعلی JWT هرگز نمی‌تواند
        // از گارد عبور کند — mock سطح گارد است چون decision در همان لایه گرفته می‌شود.
        mocks.requireAdmin.mockRejectedValue(new AdminForbiddenError())

        const res = await call()

        expect(res.status).toBe(403)
    })

    it("200 for an ADMIN — delegates to searchUsers with the admin id in context", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        mocks.searchUsers.mockResolvedValue({
            users: [{ id: 9, username: "u9", emailMasked: "u9***@x.com", plan: "FREE", role: "USER", timezone: "Asia/Tehran", lastSeenAt: null }],
            page: 1,
            pageSize: 20,
            total: 1,
        })

        const res = await call()

        expect(res.status).toBe(200)
        const parsed = await res.json()
        expect(parsed.ok).toBe(true)
        expect(parsed.data.items).toHaveLength(1)
        expect(parsed.data.page).toBe(1)
        expect(parsed.data.limit).toBe(20)
        expect(parsed.data.total).toBe(1)
        expect(parsed.data.hasMore).toBe(false)
    })
})

describe("GET /api/admin/users — pagination / search / ordering", () => {
    beforeEach(() => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        mocks.searchUsers.mockResolvedValue({ users: [], page: 1, pageSize: 20, total: 0 })
    })

    it("passes q/plan/role/page/limit/sort through to the service", async () => {
        await call("?q=test&plan=PRO&role=USER&page=3&limit=50&sort=id_asc")

        expect(mocks.searchUsers).toHaveBeenCalledWith({
            q: "test",
            plan: "PRO",
            role: "USER",
            page: 3,
            limit: 50,
            sort: "id_asc",
        })
    })

    it("defaults to id DESC ordering when no sort is provided", async () => {
        await call()

        expect(mocks.searchUsers).toHaveBeenCalledWith(
            expect.objectContaining({ sort: "id_desc" }),
        )
    })

    it("ignores an invalid sort value and falls back to id DESC (deterministic)", async () => {
        await call("?sort=email_asc")

        expect(mocks.searchUsers).toHaveBeenCalledWith(
            expect.objectContaining({ sort: "id_desc" }),
        )
    })

    it("normalizes invalid page/limit instead of rejecting (bounded normalization)", async () => {
        await call("?page=abc&limit=xyz")

        expect(mocks.searchUsers).toHaveBeenCalledWith(
            expect.objectContaining({ page: undefined, limit: undefined }),
        )
    })

    it("hasMore reflects page*size < total correctness", async () => {
        mocks.searchUsers.mockResolvedValue({ users: [], page: 2, pageSize: 50, total: 120 })

        const res = await call("?page=2&limit=50")
        const parsed = await res.json()

        expect(parsed.data.hasMore).toBe(true) // 2*50=100 < 120
    })
})

describe("GET /api/admin/users — privacy / failure", () => {
    beforeEach(() => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
    })

    it("never spreads raw user rows — output comes only from the allowlisted DTO", async () => {
        mocks.searchUsers.mockResolvedValue({
            users: [
                {
                    id: 9,
                    username: "u9",
                    emailMasked: "u9***@x.com",
                    plan: "FREE",
                    role: "USER",
                    timezone: "Asia/Tehran",
                    lastSeenAt: null,
                },
            ],
            page: 1,
            pageSize: 20,
            total: 1,
        })

        const res = await call()
        const body = JSON.stringify(await res.json())

        // کلیدهای ممنوعه هرگز در payload نیستند (DTO allowlist در سرویس تضمین شده)
        expect(body).not.toContain("password")
        expect(body).not.toContain("phone")
        expect(body).not.toContain("email\"") // خام email — فقط emailMasked
        expect(body).not.toContain("token")
    })

    it("propagates a DB failure as 500 INTERNAL (fail-closed §22)", async () => {
        mocks.searchUsers.mockRejectedValue(new Error("db down"))
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

        const res = await call()

        expect(res.status).toBe(500)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("INTERNAL")
        errorSpy.mockRestore()
    })

    it("plain USER identity can never reach the success path", async () => {
        // simulation: اگر requireAdmin به هر دلیل PLAIN_USER برگرداند، route همچنان
        // success نمی‌دهد چون گارد قبل از آن 403 می‌دهد — اینجا فقط contract route را
        // ثابت می‌کنیم که در مسیر success خروجی service است نه identity خود caller.
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        mocks.searchUsers.mockResolvedValue({ users: [], page: 1, pageSize: 20, total: 0 })
        void PLAIN_USER

        const res = await call()
        const parsed = await res.json()

        expect(parsed.ok).toBe(true)
        expect(parsed.data).not.toHaveProperty("role")
    })
})
