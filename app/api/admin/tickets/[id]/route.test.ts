import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* T4 — route tests برای GET/PATCH /api/admin/tickets/[id]              */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    requireAdmin: vi.fn(),
    getTicket: vi.fn(),
    updateTicket: vi.fn(),
}))

vi.mock("@/app/lib/requireAdmin", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/requireAdmin")>()),
    requireAdmin: mocks.requireAdmin,
}))
vi.mock("@/app/lib/services/ticket.service", () => ({
    getTicket: mocks.getTicket,
    updateTicket: mocks.updateTicket,
}))

import { GET, PATCH } from "./route"
import { AdminForbiddenError } from "@/app/lib/requireAdmin"
import { ServiceError } from "@/app/lib/services/errors"

const ADMIN = { id: 1, username: "root", email: "root@x.com", plan: "PRO", role: "ADMIN", timezone: "Asia/Tehran" }

const getCall = (id: string, query = "") =>
    GET(new NextRequest(`http://localhost/api/admin/tickets/${id}${query}`), {
        params: Promise.resolve({ id }),
    })

const patchCall = (id: string, body: unknown) =>
    PATCH(
        new NextRequest(`http://localhost/api/admin/tickets/${id}`, {
            method: "PATCH",
            body: typeof body === "string" ? body : JSON.stringify(body),
            headers: { "content-type": "application/json" },
        }),
        { params: Promise.resolve({ id }) },
    )

beforeEach(() => {
    vi.clearAllMocks()
})

describe("GET /api/admin/tickets/[id] — authorization", () => {
    it("401 when unauthenticated", async () => {
        mocks.requireAdmin.mockRejectedValue(new ServiceError(401, "UNAUTHORIZED", "Unauthorized"))

        const res = await getCall("5")

        expect(res.status).toBe(401)
        expect(mocks.getTicket).not.toHaveBeenCalled()
    })

    it("403 ADMIN_FORBIDDEN for a non-admin and never reaches the service", async () => {
        mocks.requireAdmin.mockRejectedValue(new AdminForbiddenError())

        const res = await getCall("5")

        expect(res.status).toBe(403)
        expect(mocks.getTicket).not.toHaveBeenCalled()
    })

    it("400 for an invalid id", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)

        const res = await getCall("abc")

        expect(res.status).toBe(400)
        expect(mocks.getTicket).not.toHaveBeenCalled()
    })

    it("delegates with the ADMIN actor", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        mocks.getTicket.mockResolvedValue({
            ticket: { id: 5, userId: 42, messages: [] },
            messagePage: { page: 1, limit: 20, total: 0, hasMore: false },
        })

        const res = await getCall("5")

        expect(res.status).toBe(200)
        expect(mocks.getTicket).toHaveBeenCalledWith(
            { id: ADMIN.id, role: "ADMIN" },
            5,
            { messagesPage: 1, messagesLimit: 20 },
        )
    })

    it("maps a service not-found to 404", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        mocks.getTicket.mockRejectedValue(new ServiceError(404, "TICKET_NOT_FOUND", "تیکت پیدا نشد"))

        const res = await getCall("5")

        expect(res.status).toBe(404)
        expect((await res.json()).error.code).toBe("TICKET_NOT_FOUND")
    })
})

describe("GET /api/admin/tickets/[id] — message pagination (R1)", () => {
    beforeEach(() => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        mocks.getTicket.mockResolvedValue({
            ticket: { id: 5, userId: 42, messages: [] },
            messagePage: { page: 1, limit: 20, total: 0, hasMore: false },
        })
    })

    it("returns messagePage next to the ticket (additive, ticket.messages kept)", async () => {
        // سرویس منبع حقیقت است؛ route فقط آن را بدون تغییر کنار `ticket` می‌گذارد.
        mocks.getTicket.mockResolvedValue({
            ticket: { id: 5, userId: 42, messages: [] },
            messagePage: { page: 2, limit: 10, total: 37, hasMore: true },
        })

        const res = await getCall("5", "?messagesPage=2&messagesLimit=10")

        const body = await res.json()
        expect(body.data.ticket.userId).toBe(42)
        expect(body.data.messagePage).toEqual({ page: 2, limit: 10, total: 37, hasMore: true })
    })

    it("forwards valid pagination params to the service", async () => {
        await getCall("5", "?messagesPage=4&messagesLimit=5")

        expect(mocks.getTicket).toHaveBeenCalledWith(expect.anything(), 5, {
            messagesPage: 4,
            messagesLimit: 5,
        })
    })

    it.each(["messagesPage=0", "messagesPage=xyz", "messagesLimit=0", "messagesLimit=101"])(
        "400 VALIDATION_ERROR for %s",
        async (query) => {
            const res = await getCall("5", `?${query}`)

            expect(res.status).toBe(400)
            expect((await res.json()).error.code).toBe("VALIDATION_ERROR")
            expect(mocks.getTicket).not.toHaveBeenCalled()
        },
    )

    it("still requires ADMIN — pagination params never bypass the guard", async () => {
        mocks.requireAdmin.mockRejectedValue(new AdminForbiddenError())

        const res = await getCall("5", "?messagesPage=1&messagesLimit=100")

        expect(res.status).toBe(403)
        expect(mocks.getTicket).not.toHaveBeenCalled()
    })

    it("does not let query params reshape the actor (no role/userId smuggling)", async () => {
        await getCall("5", "?messagesPage=1&messagesLimit=20&role=ADMIN&userId=999&isStaff=true")

        expect(mocks.getTicket.mock.calls[0][0]).toEqual({ id: ADMIN.id, role: "ADMIN" })
        expect(mocks.getTicket.mock.calls[0][2]).toEqual({ messagesPage: 1, messagesLimit: 20 })
    })
})

describe("PATCH /api/admin/tickets/[id] — delegation & validation", () => {
    it("403 for a non-admin before any validation or service call", async () => {
        mocks.requireAdmin.mockRejectedValue(new AdminForbiddenError())

        const res = await patchCall("5", { priority: "URGENT" })

        expect(res.status).toBe(403)
        expect(mocks.updateTicket).not.toHaveBeenCalled()
    })

    it("forwards a staff-only update (URGENT) to the service", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        mocks.updateTicket.mockResolvedValue({ id: 5, priority: "URGENT" })

        const res = await patchCall("5", { priority: "URGENT", status: "PENDING" })

        expect(res.status).toBe(200)
        expect(mocks.updateTicket).toHaveBeenCalledWith({ id: ADMIN.id, role: "ADMIN" }, 5, {
            priority: "URGENT",
            status: "PENDING",
        })
    })

    it("400 for an empty patch", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)

        const res = await patchCall("5", {})

        expect(res.status).toBe(400)
        expect(mocks.updateTicket).not.toHaveBeenCalled()
    })

    it.each([
        { closedAt: "2026-01-01T00:00:00.000Z" },
        { userId: 999 },
        { authorUserId: 999 },
        { assignedToUserId: 999 },
        { isStaff: true },
    ])("400 — rejects server-controlled field %o", async (extra) => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)

        const res = await patchCall("5", { status: "CLOSED", ...extra })

        expect(res.status).toBe(400)
        expect(mocks.updateTicket).not.toHaveBeenCalled()
    })

    it.each([
        ["invalid transition", new ServiceError(409, "TICKET_INVALID_TRANSITION", "نامعتبر"), 409, "TICKET_INVALID_TRANSITION"],
        ["concurrent conflict", new ServiceError(409, "TICKET_CONFLICT", "تعارض"), 409, "TICKET_CONFLICT"],
        ["not found", new ServiceError(404, "TICKET_NOT_FOUND", "پیدا نشد"), 404, "TICKET_NOT_FOUND"],
    ])("maps a service %s", async (_label, error, status, code) => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        mocks.updateTicket.mockRejectedValue(error)

        const res = await patchCall("5", { status: "CLOSED" })

        expect(res.status).toBe(status)
        expect((await res.json()).error.code).toBe(code)
    })

    it("500 INTERNAL fallback for an unknown failure", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        mocks.updateTicket.mockRejectedValue(new Error("boom"))

        const res = await patchCall("5", { status: "CLOSED" })

        expect(res.status).toBe(500)
        expect((await res.json()).error.code).toBe("INTERNAL")
    })
})
