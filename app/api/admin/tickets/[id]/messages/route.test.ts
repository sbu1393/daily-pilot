import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* T4 — route test برای POST /api/admin/tickets/[id]/messages            */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    requireAdmin: vi.fn(),
    addTicketMessage: vi.fn(),
}))

vi.mock("@/app/lib/requireAdmin", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/requireAdmin")>()),
    requireAdmin: mocks.requireAdmin,
}))
vi.mock("@/app/lib/services/ticket.service", () => ({ addTicketMessage: mocks.addTicketMessage }))

import { POST } from "./route"
import { AdminForbiddenError } from "@/app/lib/requireAdmin"
import { ServiceError } from "@/app/lib/services/errors"

const ADMIN = { id: 1, username: "root", email: "root@x.com", plan: "PRO", role: "ADMIN", timezone: "Asia/Tehran" }

const call = (id: string, body: unknown) =>
    POST(
        new NextRequest(`http://localhost/api/admin/tickets/${id}/messages`, {
            method: "POST",
            body: typeof body === "string" ? body : JSON.stringify(body),
            headers: { "content-type": "application/json" },
        }),
        { params: Promise.resolve({ id }) },
    )

beforeEach(() => {
    vi.clearAllMocks()
})

describe("POST /api/admin/tickets/[id]/messages — authorization", () => {
    it("401 when unauthenticated", async () => {
        mocks.requireAdmin.mockRejectedValue(new ServiceError(401, "UNAUTHORIZED", "Unauthorized"))

        const res = await call("5", { body: "بررسی شد" })

        expect(res.status).toBe(401)
        expect(mocks.addTicketMessage).not.toHaveBeenCalled()
    })

    it("403 for a non-admin — a normal user cannot staff-reply through this route", async () => {
        mocks.requireAdmin.mockRejectedValue(new AdminForbiddenError())

        const res = await call("5", { body: "بررسی شد" })

        expect(res.status).toBe(403)
        expect((await res.json()).error.code).toBe("ADMIN_FORBIDDEN")
        expect(mocks.addTicketMessage).not.toHaveBeenCalled()
    })
})

describe("POST /api/admin/tickets/[id]/messages — delegation", () => {
    it("201 and forwards the session actor (isStaff comes from the service, not the body)", async () => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        mocks.addTicketMessage.mockResolvedValue({ id: "m1", body: "بررسی شد" })

        const res = await call("5", { body: "  بررسی شد  " })

        expect(res.status).toBe(201)
        expect(mocks.addTicketMessage).toHaveBeenCalledWith({ id: ADMIN.id, role: "ADMIN" }, 5, {
            body: "بررسی شد",
        })
    })

    it.each([
        ["missing body", {}],
        ["whitespace-only body", { body: "  " }],
        ["malformed JSON", "nope"],
        ["invalid id", { body: "ok" }],
    ])("400 for %s", async (_label, body) => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)

        const res = await call(_label === "invalid id" ? "abc" : "5", body)

        expect(res.status).toBe(400)
        expect(mocks.addTicketMessage).not.toHaveBeenCalled()
    })

    it.each([{ isStaff: false }, { authorUserId: 999 }, { ticketId: 9 }, { status: "CLOSED" }])(
        "400 — rejects server-controlled field %o",
        async (extra) => {
            mocks.requireAdmin.mockResolvedValue(ADMIN)

            const res = await call("5", { body: "بررسی شد", ...extra })

            expect(res.status).toBe(400)
            expect(mocks.addTicketMessage).not.toHaveBeenCalled()
        },
    )

    it.each([
        ["closed ticket", new ServiceError(409, "TICKET_CLOSED", "بسته شده"), 409, "TICKET_CLOSED"],
        ["not found", new ServiceError(404, "TICKET_NOT_FOUND", "پیدا نشد"), 404, "TICKET_NOT_FOUND"],
        ["conflict", new ServiceError(409, "TICKET_CONFLICT", "تعارض"), 409, "TICKET_CONFLICT"],
    ])("maps a service %s", async (_label, error, status, code) => {
        mocks.requireAdmin.mockResolvedValue(ADMIN)
        mocks.addTicketMessage.mockRejectedValue(error)

        const res = await call("5", { body: "بررسی شد" })

        expect(res.status).toBe(status)
        expect((await res.json()).error.code).toBe(code)
    })
})
