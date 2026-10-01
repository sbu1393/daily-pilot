import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* T4 — route tests برای GET/POST /api/tickets                          */
/* requireVerifiedUser + سرویس فاز T3 mock می‌شوند (الگوی route tests  */
/* مخزن: app/api/admin/users/route.test.ts) تا خودِ orchestration     */
/* مسیر تست شود، نه DB.                                                */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    requireVerifiedUser: vi.fn(),
    createTicket: vi.fn(),
    listTickets: vi.fn(),
}))

vi.mock("@/app/lib/requireVerifiedUser", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/requireVerifiedUser")>()),
    requireVerifiedUser: mocks.requireVerifiedUser,
}))
vi.mock("@/app/lib/services/ticket.service", () => ({
    createTicket: mocks.createTicket,
    listTickets: mocks.listTickets,
}))

import { GET, POST } from "./route"
import { ServiceError } from "@/app/lib/services/errors"

const USER = { id: 1, username: "u1", email: "u1@x.com", plan: "FREE", role: "USER", timezone: "Asia/Tehran" }

const getCall = (query = "") => GET(new NextRequest(`http://localhost/api/tickets${query}`))

const postCall = (body: unknown) =>
    POST(
        new NextRequest("http://localhost/api/tickets", {
            method: "POST",
            body: typeof body === "string" ? body : JSON.stringify(body),
            headers: { "content-type": "application/json" },
        }),
    )

const emptyPage = { items: [], page: 1, limit: 20, total: 0, hasMore: false }

beforeEach(() => {
    vi.clearAllMocks()
    mocks.listTickets.mockResolvedValue(emptyPage)
})

describe("GET /api/tickets — authentication", () => {
    it("401 UNAUTHORIZED when unauthenticated, and never calls the service", async () => {
        mocks.requireVerifiedUser.mockRejectedValue(new ServiceError(401, "UNAUTHORIZED", "Unauthorized"))

        const res = await getCall()

        expect(res.status).toBe(401)
        expect((await res.json()).error.code).toBe("UNAUTHORIZED")
        expect(mocks.listTickets).not.toHaveBeenCalled()
    })
})

describe("GET /api/tickets — validation", () => {
    it("applies the T2 defaults when page/limit are omitted", async () => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)

        await getCall()

        expect(mocks.listTickets).toHaveBeenCalledWith({ id: USER.id, role: "USER" }, { page: 1, limit: 20 })
    })

    it("forwards parsed page/limit/status to the service", async () => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)

        await getCall("?page=3&limit=50&status=OPEN")

        expect(mocks.listTickets).toHaveBeenCalledWith({ id: USER.id, role: "USER" }, {
            page: 3,
            limit: 50,
            status: "OPEN",
        })
    })

    it.each(["?page=0", "?page=abc", "?limit=0", "?limit=9999", "?status=ARCHIVED"])(
        "400 VALIDATION_ERROR for %s and does not call the service",
        async (query) => {
            mocks.requireVerifiedUser.mockResolvedValue(USER)

            const res = await getCall(query)

            expect(res.status).toBe(400)
            expect((await res.json()).error.code).toBe("VALIDATION_ERROR")
            expect(mocks.listTickets).not.toHaveBeenCalled()
        },
    )
})

describe("GET /api/tickets — success + envelope", () => {
    it("builds the actor from the session identity, not from the query", async () => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)
        mocks.listTickets.mockResolvedValue({ items: [{ id: 5 }], page: 1, limit: 20, total: 1, hasMore: false })

        const res = await getCall()

        const parsed = await res.json()
        expect(res.status).toBe(200)
        expect(parsed.ok).toBe(true)
        expect(parsed.data).toEqual({ items: [{ id: 5 }], page: 1, limit: 20, total: 1, hasMore: false })
        // نقش از session می‌آید؛ هیچ پارامتری نمی‌تواند آن را جایگزین کند
        expect(mocks.listTickets.mock.calls[0][0].role).toBe("USER")
    })

    it("maps a service error without duplicate mapping", async () => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)
        mocks.listTickets.mockRejectedValue(new ServiceError(403, "TICKET_FORBIDDEN", "اجازه ندارید"))

        const res = await getCall()

        expect(res.status).toBe(403)
        expect((await res.json()).error.code).toBe("TICKET_FORBIDDEN")
    })

    it("falls back to 500 INTERNAL for an unknown error", async () => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)
        mocks.listTickets.mockRejectedValue(new Error("boom"))

        const res = await getCall()

        expect(res.status).toBe(500)
        expect((await res.json()).error.code).toBe("INTERNAL")
    })
})

describe("POST /api/tickets — create", () => {
    it("401 UNAUTHORIZED when unauthenticated, and never calls the service", async () => {
        mocks.requireVerifiedUser.mockRejectedValue(new ServiceError(401, "UNAUTHORIZED", "Unauthorized"))

        const res = await postCall({ subject: "s", body: "b" })

        expect(res.status).toBe(401)
        expect(mocks.createTicket).not.toHaveBeenCalled()
    })

    it("201 with the created ticket for a valid body", async () => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)
        mocks.createTicket.mockResolvedValue({ ticket: { id: 5, subject: "s" }, message: { id: "m1" } })

        const res = await postCall({ subject: "  s  ", body: "b", category: "bug", priority: "HIGH" })

        const parsed = await res.json()
        expect(res.status).toBe(201)
        expect(parsed.ok).toBe(true)
        expect(parsed.data.ticket.id).toBe(5)
        // مقادیر trim‌شده‌ی schema فاز T2 به سرویس می‌رسند
        expect(mocks.createTicket).toHaveBeenCalledWith({ id: USER.id, role: "USER" }, {
            subject: "s",
            body: "b",
            category: "bug",
            priority: "HIGH",
        })
    })

    it.each([
        ["missing subject", { body: "b" }],
        ["empty subject", { subject: "  ", body: "b" }],
        ["missing body", { subject: "s" }],
        ["whitespace-only body", { subject: "s", body: "\t\n " }],
        ["invalid priority", { subject: "s", body: "b", priority: "CRITICAL" }],
        ["URGENT is not a user priority", { subject: "s", body: "b", priority: "URGENT" }],
        ["unknown category", { subject: "s", body: "b", category: "HOME" }],
        ["malformed JSON", "not-json"],
    ])("400 VALIDATION_ERROR for %s and does not call the service", async (_label, body) => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)

        const res = await postCall(body)

        expect(res.status).toBe(400)
        expect((await res.json()).error.code).toBe("VALIDATION_ERROR")
        expect(mocks.createTicket).not.toHaveBeenCalled()
    })

    it.each([
        { userId: 999 },
        { authorUserId: 999 },
        { isStaff: true },
        { status: "CLOSED" },
        { closedAt: "2026-01-01T00:00:00.000Z" },
        { assignedToUserId: 999 },
        { role: "ADMIN" },
    ])("rejects mass-assignment / role-spoofing field %o before the service", async (extra) => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)

        const res = await postCall({ subject: "s", body: "b", ...extra })

        expect(res.status).toBe(400)
        expect(mocks.createTicket).not.toHaveBeenCalled()
    })

    it("maps a service error (e.g. forbidden escalation) to its real status", async () => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)
        mocks.createTicket.mockRejectedValue(new ServiceError(403, "TICKET_FORBIDDEN", "اجازه ندارید"))

        const res = await postCall({ subject: "s", body: "b" })

        expect(res.status).toBe(403)
        expect((await res.json()).error.code).toBe("TICKET_FORBIDDEN")
    })
})
