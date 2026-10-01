import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* T4 — route test برای GET /api/admin/tickets (صف پشتیبانی)            */
/* الگوی route test مخزن: app/api/admin/users/route.test.ts              */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    requireAdmin: vi.fn(),
    listTickets: vi.fn(),
}))

vi.mock("@/app/lib/requireAdmin", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/requireAdmin")>()),
    requireAdmin: mocks.requireAdmin,
}))
vi.mock("@/app/lib/services/ticket.service", () => ({ listTickets: mocks.listTickets }))

import { GET } from "./route"
import { AdminForbiddenError } from "@/app/lib/requireAdmin"
import { ServiceError } from "@/app/lib/services/errors"

const ADMIN = { id: 1, username: "root", email: "root@x.com", plan: "PRO", role: "ADMIN", timezone: "Asia/Tehran" }

const call = (query = "") => GET(new NextRequest(`http://localhost/api/admin/tickets${query}`))

beforeEach(() => {
    vi.clearAllMocks()
    mocks.listTickets.mockResolvedValue({ items: [], page: 1, limit: 20, total: 0, hasMore: false })
})

describe("GET /api/admin/tickets — authorization", () => {
    it("401 UNAUTHORIZED when unauthenticated", async () => {
        mocks.requireAdmin.mockRejectedValue(new ServiceError(401, "UNAUTHORIZED", "Unauthorized"))

        const res = await call()

        expect(res.status).toBe(401)
        expect((await res.json()).error.code).toBe("UNAUTHORIZED")
        expect(mocks.listTickets).not.toHaveBeenCalled()
    })

    it("403 ADMIN_FORBIDDEN for an authenticated non-admin, service untouched", async () => {
        mocks.requireAdmin.mockRejectedValue(new AdminForbiddenError())

        const res = await call()

        expect(res.status).toBe(403)
        expect((await res.json()).error.code).toBe("ADMIN_FORBIDDEN")
        expect(mocks.listTickets).not.toHaveBeenCalled()
    })

    it("403 even for a PRO user whose role is USER (role ≠ plan)", async () => {
        mocks.requireAdmin.mockRejectedValue(new AdminForbiddenError())

        const res = await call()

        expect(res.status).toBe(403)
    })

    it("does not accept a role from the query string", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)

        await call("?role=ADMIN")

        expect(mocks.listTickets.mock.calls[0][0]).toEqual({ id: ADMIN.id, role: "ADMIN" })
    })
})

describe("GET /api/admin/tickets — delegation & validation", () => {
    it("delegates with the DB-backed ADMIN actor and the T2 defaults", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)

        const res = await call()

        expect(res.status).toBe(200)
        expect(mocks.listTickets).toHaveBeenCalledWith({ id: ADMIN.id, role: "ADMIN" }, { page: 1, limit: 20 })
    })

    it("forwards a valid status filter", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)

        await call("?status=PENDING&page=2&limit=10")

        expect(mocks.listTickets).toHaveBeenCalledWith({ id: ADMIN.id, role: "ADMIN" }, {
            page: 2,
            limit: 10,
            status: "PENDING",
        })
    })

    it.each(["?page=0", "?limit=9999", "?status=RESOLVED"])(
        "400 VALIDATION_ERROR for %s without calling the service",
        async (query) => {
            mocks.requireAdmin.mockResolvedValue(ADMIN)

            const res = await call(query)

            expect(res.status).toBe(400)
            expect(mocks.listTickets).not.toHaveBeenCalled()
        },
    )

    it("returns the pagination envelope", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        mocks.listTickets.mockResolvedValue({ items: [{ id: 5 }], page: 2, limit: 10, total: 25, hasMore: true })

        const res = await call("?page=2&limit=10")

        expect((await res.json()).data).toEqual({
            items: [{ id: 5 }],
            page: 2,
            limit: 10,
            total: 25,
            hasMore: true,
        })
    })

    it("passes the ADMIN id (never a body/query-supplied userId)", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)

        await call("?userId=999")

        expect(mocks.listTickets.mock.calls[0][0].id).toBe(ADMIN.id)
    })
})
