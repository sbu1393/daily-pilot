import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* T4 — route test برای POST /api/tickets/[id]/messages                  */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    requireVerifiedUser: vi.fn(),
    addTicketMessage: vi.fn(),
}))

vi.mock("@/app/lib/requireVerifiedUser", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/requireVerifiedUser")>()),
    requireVerifiedUser: mocks.requireVerifiedUser,
}))
vi.mock("@/app/lib/services/ticket.service", () => ({ addTicketMessage: mocks.addTicketMessage }))

import { POST } from "./route"
import {
    TicketClosedError,
    TicketConflictError,
    TicketForbiddenError,
    TicketNotFoundError,
} from "@/app/lib/services/errors"

const USER = { id: 1, username: "u1", email: "u1@x.com", plan: "FREE", role: "USER", timezone: "Asia/Tehran" }

const call = (id: string, body: unknown) =>
    POST(
        new NextRequest(`http://localhost/api/tickets/${id}/messages`, {
            method: "POST",
            body: typeof body === "string" ? body : JSON.stringify(body),
            headers: { "content-type": "application/json" },
        }),
        { params: Promise.resolve({ id }) },
    )

beforeEach(() => {
    vi.clearAllMocks()
})

describe("POST /api/tickets/[id]/messages — success", () => {
    it("401 when unauthenticated", async () => {
        mocks.requireVerifiedUser.mockResolvedValue(null)

        const res = await call("5", { body: "سلام" })

        expect(res.status).toBe(401)
        expect(mocks.addTicketMessage).not.toHaveBeenCalled()
    })

    it("201 and forwards only the trimmed body plus the session actor", async () => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)
        mocks.addTicketMessage.mockResolvedValue({ id: "m1", body: "سلام" })

        const res = await call("5", { body: "  سلام  " })

        expect(res.status).toBe(201)
        expect((await res.json()).data.message.id).toBe("m1")
        expect(mocks.addTicketMessage).toHaveBeenCalledWith({ id: USER.id, role: "USER" }, 5, { body: "سلام" })
    })
})

describe("POST /api/tickets/[id]/messages — validation", () => {
    it.each(["abc", "0", ""])("400 for id %o", async (id) => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)

        const res = await call(id, { body: "سلام" })

        expect(res.status).toBe(400)
        expect(mocks.addTicketMessage).not.toHaveBeenCalled()
    })

    it.each([
        ["missing body", {}],
        ["empty body", { body: "" }],
        ["whitespace-only body", { body: "   " }],
        ["malformed JSON", "not-json"],
    ])("400 for %s", async (_label, body) => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)

        const res = await call("5", body)

        expect(res.status).toBe(400)
        expect(mocks.addTicketMessage).not.toHaveBeenCalled()
    })

    it.each([
        { authorUserId: 999 },
        { isStaff: true },
        { ticketId: 999 },
        { status: "CLOSED" },
        { closedAt: "2026-01-01T00:00:00.000Z" },
    ])("400 — rejects server-controlled field %o (role spoofing / spoofed author)", async (extra) => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)

        const res = await call("5", { body: "سلام", ...extra })

        expect(res.status).toBe(400)
        expect(mocks.addTicketMessage).not.toHaveBeenCalled()
    })
})

describe("POST /api/tickets/[id]/messages — IDOR & error mapping", () => {
    it.each([
        ["ticket of another user", new TicketNotFoundError(), 404, "TICKET_NOT_FOUND"],
        ["forbidden", new TicketForbiddenError(), 403, "TICKET_FORBIDDEN"],
        ["closed ticket", new TicketClosedError(), 409, "TICKET_CLOSED"],
        ["concurrent conflict", new TicketConflictError(), 409, "TICKET_CONFLICT"],
    ])("maps %s without duplicating the rule in the route", async (_label, error, status, code) => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)
        mocks.addTicketMessage.mockRejectedValue(error)

        const res = await call("7", { body: "سلام" })

        expect(res.status).toBe(status)
        expect((await res.json()).error.code).toBe(code)
    })
})
