import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* T4 — route tests برای GET/PATCH /api/tickets/[id]                    */
/* requireVerifiedUser + سرویس فاز T3 mock می‌شوند.                     */
/* هدف اصلی: route چیزی را duplicate نکند — نه ownership، نه IDOR،       */
/* نه policy وضعیت/priority. همه به سرویس واگذار شده‌اند.               */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    requireVerifiedUser: vi.fn(),
    getTicket: vi.fn(),
    updateTicket: vi.fn(),
}))

vi.mock("@/app/lib/requireVerifiedUser", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/requireVerifiedUser")>()),
    requireVerifiedUser: mocks.requireVerifiedUser,
}))
vi.mock("@/app/lib/services/ticket.service", () => ({
    getTicket: mocks.getTicket,
    updateTicket: mocks.updateTicket,
}))

import { GET, PATCH } from "./route"
import {
    TicketClosedError,
    TicketConflictError,
    TicketForbiddenError,
    TicketInvalidTransitionError,
    TicketNotFoundError,
} from "@/app/lib/services/errors"

const USER = { id: 1, username: "u1", email: "u1@x.com", plan: "FREE", role: "USER", timezone: "Asia/Tehran" }

const getCall = (id: string, query = "") =>
    GET(new NextRequest(`http://localhost/api/tickets/${id}${query}`), {
        params: Promise.resolve({ id }),
    })

const patchCall = (id: string, body: unknown) =>
    PATCH(
        new NextRequest(`http://localhost/api/tickets/${id}`, {
            method: "PATCH",
            body: typeof body === "string" ? body : JSON.stringify(body),
            headers: { "content-type": "application/json" },
        }),
        { params: Promise.resolve({ id }) },
    )

beforeEach(() => {
    vi.clearAllMocks()
})

describe("GET /api/tickets/[id] — authentication & id validation", () => {
    it("401 UNAUTHORIZED when unauthenticated", async () => {
        mocks.requireVerifiedUser.mockResolvedValue(null)

        const res = await getCall("5")

        expect(res.status).toBe(401)
        expect(mocks.getTicket).not.toHaveBeenCalled()
    })

    it.each(["abc", "0", "-1", "1.5", ""])("400 VALIDATION_ERROR for id %o", async (id) => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)

        const res = await getCall(id)

        expect(res.status).toBe(400)
        expect((await res.json()).error.code).toBe("VALIDATION_ERROR")
        expect(mocks.getTicket).not.toHaveBeenCalled()
    })

    it("parses the route param to a number and passes the session actor", async () => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)
        mocks.getTicket.mockResolvedValue({
            ticket: { id: 5, subject: "s", messages: [] },
            messagePage: { page: 1, limit: 20, total: 0, hasMore: false },
        })

        const res = await getCall("5")

        expect(res.status).toBe(200)
        expect(mocks.getTicket).toHaveBeenCalledWith({ id: USER.id, role: "USER" }, 5, {
            messagesPage: 1,
            messagesLimit: 20,
        })
    })
})

describe("GET /api/tickets/[id] — message pagination (R1)", () => {
    beforeEach(() => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)
        mocks.getTicket.mockResolvedValue({
            ticket: { id: 5, subject: "s", messages: [] },
            messagePage: { page: 1, limit: 20, total: 0, hasMore: false },
        })
    })

    it("returns messagePage next to the ticket (additive, ticket.messages kept)", async () => {
        // سرویس منبع حقیقت است؛ route فقط آن را بدون تغییر کنار `ticket` می‌گذارد.
        mocks.getTicket.mockResolvedValue({
            ticket: { id: 5, subject: "s", messages: [] },
            messagePage: { page: 2, limit: 10, total: 37, hasMore: true },
        })

        const res = await getCall("5", "?messagesPage=2&messagesLimit=10")

        const body = await res.json()
        expect(body.data.ticket.id).toBe(5)
        expect(body.data.messagePage).toEqual({ page: 2, limit: 10, total: 37, hasMore: true })
    })

    it("forwards valid pagination params to the service", async () => {
        await getCall("5", "?messagesPage=3&messagesLimit=25")

        expect(mocks.getTicket).toHaveBeenCalledWith(expect.anything(), 5, {
            messagesPage: 3,
            messagesLimit: 25,
        })
    })

    it.each([
        ["messagesPage=0", "below the minimum page"],
        ["messagesPage=abc", "non-numeric page"],
        ["messagesPage=1.5", "fractional page"],
        ["messagesLimit=0", "below the minimum limit"],
        ["messagesLimit=101", "above the T2 maximum"],
    ])("400 VALIDATION_ERROR for %s (%s)", async (query) => {
        const res = await getCall("5", `?${query}`)

        expect(res.status).toBe(400)
        expect((await res.json()).error.code).toBe("VALIDATION_ERROR")
        expect(mocks.getTicket).not.toHaveBeenCalled()
    })

    it("pagination params grant nothing: the session actor still comes from auth", async () => {
        await getCall("5", "?messagesPage=1&messagesLimit=20&userId=999&role=ADMIN&isStaff=true")

        const [actor] = mocks.getTicket.mock.calls[0]
        expect(actor).toEqual({ id: USER.id, role: "USER" })
    })

    it("rejects an over-cap limit instead of reading the whole thread", async () => {
        await getCall("5", "?messagesLimit=100000")

        expect(mocks.getTicket).not.toHaveBeenCalled()
    })
})

describe("GET /api/tickets/[id] — IDOR is delegated to the service", () => {
    it("returns the service's 404 verbatim (route never downgrades it to 403)", async () => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)
        mocks.getTicket.mockRejectedValue(new TicketNotFoundError())

        const res = await getCall("7")

        expect(res.status).toBe(404)
        expect((await res.json()).error.code).toBe("TICKET_NOT_FOUND")
    })

    it("does not treat the URL id as proof of ownership (no extra check in the route)", async () => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)
        mocks.getTicket.mockRejectedValue(new TicketNotFoundError())

        await getCall("7")

        // فقط یک فراخوانی سرویس؛ هیچ findUnique/findFirst اضافه‌ای در route نیست
        expect(mocks.getTicket).toHaveBeenCalledTimes(1)
        expect(mocks.getTicket).toHaveBeenCalledWith(
            { id: USER.id, role: "USER" },
            7,
            expect.anything(),
        )
    })
})

describe("PATCH /api/tickets/[id] — validation", () => {
    it("400 for an empty patch (T2 no-change guard), service untouched", async () => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)

        const res = await patchCall("5", {})

        expect(res.status).toBe(400)
        expect(mocks.updateTicket).not.toHaveBeenCalled()
    })

    it.each([
        ["invalid status", { status: "RESOLVED" }],
        ["invalid priority", { priority: "CRITICAL" }],
        ["unknown category", { category: "HOME" }],
        ["malformed JSON", "not-json"],
    ])("400 VALIDATION_ERROR for %s", async (_label, body) => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)

        const res = await patchCall("5", body)

        expect(res.status).toBe(400)
        expect(mocks.updateTicket).not.toHaveBeenCalled()
    })

    it.each([
        { userId: 999 },
        { authorUserId: 999 },
        { isStaff: true },
        { closedAt: "2026-01-01T00:00:00.000Z" },
        { assignedToUserId: 999 },
        { ticketId: 999 },
    ])("400 — rejects server-controlled field %o before the service", async (extra) => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)

        const res = await patchCall("5", { status: "CLOSED", ...extra })

        expect(res.status).toBe(400)
        expect(mocks.updateTicket).not.toHaveBeenCalled()
    })

    it("400 for an invalid id before reading the body", async () => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)

        const res = await patchCall("abc", { priority: "HIGH" })

        expect(res.status).toBe(400)
        expect(mocks.updateTicket).not.toHaveBeenCalled()
    })
})

describe("PATCH /api/tickets/[id] — error mapping comes from the service", () => {
    it.each([
        ["forbidden (user changing status)", new TicketForbiddenError(), 403, "TICKET_FORBIDDEN"],
        ["not found / not owner", new TicketNotFoundError(), 404, "TICKET_NOT_FOUND"],
        ["invalid transition", new TicketInvalidTransitionError(), 409, "TICKET_INVALID_TRANSITION"],
        ["concurrent conflict", new TicketConflictError(), 409, "TICKET_CONFLICT"],
    ])("maps %s", async (_label, error, status, code) => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)
        mocks.updateTicket.mockRejectedValue(error)

        const res = await patchCall("5", { priority: "HIGH" })

        expect(res.status).toBe(status)
        expect((await res.json()).error.code).toBe(code)
    })

    it("200 with the updated ticket for a valid patch", async () => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)
        mocks.updateTicket.mockResolvedValue({ id: 5, priority: "HIGH" })

        const res = await patchCall("5", { priority: "HIGH" })

        expect(res.status).toBe(200)
        expect((await res.json()).data.ticket.priority).toBe("HIGH")
        expect(mocks.updateTicket).toHaveBeenCalledWith({ id: USER.id, role: "USER" }, 5, { priority: "HIGH" })
    })

    it("maps a closed ticket to its own 409 code (no duplicate logic in the route)", async () => {
        mocks.requireVerifiedUser.mockResolvedValue(USER)
        mocks.updateTicket.mockRejectedValue(new TicketClosedError())

        const res = await patchCall("5", { priority: "HIGH" })

        expect(res.status).toBe(409)
        expect((await res.json()).error.code).toBe("TICKET_CLOSED")
    })
})
