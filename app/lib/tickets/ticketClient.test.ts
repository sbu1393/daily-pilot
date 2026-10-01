import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* T5 — لایهٔ دادهٔ تیکت: endpointها + قرارداد ADR-04                     */
/* fetch سراسری mock می‌شود (محیط node بدون DOM — بدون dependency جدید). */
/* الگوی همان `app/lib/admin/adminClient.test.ts`.                        */
/* ------------------------------------------------------------------ */

import {
    createTicket,
    fetchTicket,
    fetchTickets,
    sendTicketMessage,
    toTicketRequestError,
    updateTicket,
} from "./ticketClient"
import { ApiClientError } from "@/app/lib/api/client"

beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn())
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

const ok = (data: unknown) =>
    Promise.resolve(new Response(JSON.stringify({ ok: true, data }), { status: 200 }))

const fail = (status: number, code: string, message: string) =>
    Promise.resolve(new Response(JSON.stringify({ ok: false, error: { code, message } }), { status }))

const lastCall = () => vi.mocked(fetch).mock.calls[0] as [string, RequestInit]
const lastBody = () => JSON.parse(String(lastCall()[1].body))

const sampleTicket = {
    id: 5,
    userId: 1,
    subject: "خطا در ثبت تسک",
    status: "OPEN",
    priority: "MEDIUM",
    category: null,
    lastMessageAt: null,
    closedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
}

describe("GET /api/tickets", () => {
    it("hits the endpoint with the query and unwraps data", async () => {
        const page = { items: [sampleTicket], page: 1, limit: 20, total: 1, hasMore: false }
        vi.mocked(fetch).mockReturnValue(ok(page) as never)

        await expect(fetchTickets("page=1&limit=20")).resolves.toEqual(page)
        expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/tickets?page=1&limit=20", expect.anything())
    })

    it("passes the AbortSignal through", async () => {
        vi.mocked(fetch).mockReturnValue(ok({ items: [] }) as never)
        const controller = new AbortController()

        await fetchTickets("page=1", controller.signal)

        expect(lastCall()[1].signal).toBe(controller.signal)
    })

    it("surfaces a 401 as an ApiClientError with the envelope code", async () => {
        vi.mocked(fetch).mockImplementation(() => fail(401, "UNAUTHORIZED", "Unauthorized") as never)

        // یک‌بار await: همان Response دوباره مصرف‌شدنی نیست.
        const error = await fetchTickets("page=1").catch((e: unknown) => e)

        expect(error).toBeInstanceOf(ApiClientError)
        expect(error).toMatchObject({ status: 401, code: "UNAUTHORIZED" })
    })
})

describe("POST /api/tickets", () => {
    it("unwraps { ticket } and sends exactly the payload it was given", async () => {
        vi.mocked(fetch).mockReturnValue(ok({ ticket: sampleTicket }) as never)

        const created = await createTicket({ subject: "s", body: "b", priority: "HIGH" })

        expect(created).toEqual(sampleTicket)
        const [url, init] = lastCall()
        expect(url).toBe("/api/tickets")
        expect(init.method).toBe("POST")
        expect(lastBody()).toEqual({ subject: "s", body: "b", priority: "HIGH" })
    })

    it("maps a validation error to 400 VALIDATION_ERROR", async () => {
        vi.mocked(fetch).mockReturnValue(fail(400, "VALIDATION_ERROR", "اطلاعات نامعتبر است") as never)

        await expect(createTicket({ subject: "", body: "" })).rejects.toMatchObject({
            status: 400,
            code: "VALIDATION_ERROR",
        })
    })
})

describe("GET /api/tickets/[id]", () => {
    it("unwraps { ticket, messagePage } and encodes the id", async () => {
        const messagePage = { page: 1, limit: 20, total: 0, hasMore: false }
        vi.mocked(fetch).mockReturnValue(
            ok({ ticket: { ...sampleTicket, messages: [] }, messagePage }) as never,
        )

        const detail = await fetchTicket(5)

        expect(detail.ticket.messages).toEqual([])
        expect(detail.messagePage).toEqual(messagePage)
        expect(lastCall()[0]).toBe("/api/tickets/5")
    })

    it("appends the message-page query when one is given", async () => {
        vi.mocked(fetch).mockReturnValue(
            ok({ ticket: { ...sampleTicket, messages: [] }, messagePage: { page: 2, limit: 10, total: 25, hasMore: true } }) as never,
        )

        const detail = await fetchTicket(5, "messagesPage=2&messagesLimit=10")

        expect(lastCall()[0]).toBe("/api/tickets/5?messagesPage=2&messagesLimit=10")
        expect(detail.messagePage.hasMore).toBe(true)
    })

    it("forwards the AbortSignal next to the query", async () => {
        vi.mocked(fetch).mockReturnValue(
            ok({ ticket: { ...sampleTicket, messages: [] }, messagePage: { page: 1, limit: 20, total: 0, hasMore: false } }) as never,
        )
        const controller = new AbortController()

        await fetchTicket(5, "messagesPage=1&messagesLimit=20", controller.signal)

        expect(lastCall()[1].signal).toBe(controller.signal)
    })

    it("propagates TICKET_NOT_FOUND (the service hides other users' tickets as 404)", async () => {
        vi.mocked(fetch).mockReturnValue(fail(404, "TICKET_NOT_FOUND", "تیکت پیدا نشد") as never)

        await expect(fetchTicket(7)).rejects.toMatchObject({ status: 404, code: "TICKET_NOT_FOUND" })
    })

    it("propagates a rejected page size as VALIDATION_ERROR (the cap is not a client concern)", async () => {
        vi.mocked(fetch).mockReturnValue(fail(400, "VALIDATION_ERROR", "بیشتر از ۱۰۰") as never)

        await expect(fetchTicket(5, "messagesLimit=100000")).rejects.toMatchObject({
            status: 400,
            code: "VALIDATION_ERROR",
        })
    })
})

describe("PATCH /api/tickets/[id]", () => {
    it("sends a PATCH to the ticket endpoint", async () => {
        vi.mocked(fetch).mockReturnValue(ok({ ticket: sampleTicket }) as never)

        await updateTicket(5, { priority: "LOW", category: null })

        const [url, init] = lastCall()
        expect(url).toBe("/api/tickets/5")
        expect(init.method).toBe("PATCH")
        expect(lastBody()).toEqual({ priority: "LOW", category: null })
    })

    it("maps TICKET_FORBIDDEN (e.g. user trying to escalate) to 403", async () => {
        vi.mocked(fetch).mockReturnValue(fail(403, "TICKET_FORBIDDEN", "اجازه ندارید") as never)

        await expect(updateTicket(5, { priority: "URGENT" })).rejects.toMatchObject({
            status: 403,
            code: "TICKET_FORBIDDEN",
        })
    })

    it("maps TICKET_CONFLICT to 409", async () => {
        vi.mocked(fetch).mockReturnValue(fail(409, "TICKET_CONFLICT", "تعارض") as never)

        await expect(updateTicket(5, { priority: "LOW" })).rejects.toMatchObject({
            status: 409,
            code: "TICKET_CONFLICT",
        })
    })
})

describe("POST /api/tickets/[id]/messages", () => {
    it("unwraps { message }", async () => {
        const message = { id: "m1", ticketId: 5, authorUserId: 1, body: "سلام", isStaff: false, createdAt: "2026-01-01T00:00:00.000Z" }
        vi.mocked(fetch).mockReturnValue(ok({ message }) as never)

        await expect(sendTicketMessage(5, { body: "سلام" })).resolves.toEqual(message)
        expect(lastCall()[0]).toBe("/api/tickets/5/messages")
        expect(lastBody()).toEqual({ body: "سلام" })
    })

    it("maps TICKET_CLOSED to 409", async () => {
        vi.mocked(fetch).mockReturnValue(fail(409, "TICKET_CLOSED", "بسته شده") as never)

        await expect(sendTicketMessage(5, { body: "دیر شد" })).rejects.toMatchObject({
            status: 409,
            code: "TICKET_CLOSED",
        })
    })
})

describe("toTicketRequestError", () => {
    it("normalises an ApiClientError into { status, code, message }", () => {
        expect(toTicketRequestError(new ApiClientError(403, "ADMIN_FORBIDDEN", "نیست"))).toEqual({
            status: 403,
            code: "ADMIN_FORBIDDEN",
            message: "نیست",
        })
    })

    it("maps a non-API failure to NETWORK_ERROR", () => {
        expect(toTicketRequestError(new TypeError("Failed to fetch"))).toEqual({
            status: 0,
            code: "NETWORK_ERROR",
            message: "Failed to fetch",
        })
        expect(toTicketRequestError("boom")).toEqual({
            status: 0,
            code: "NETWORK_ERROR",
            message: "خطای ناشناخته",
        })
    })
})
