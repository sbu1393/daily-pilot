import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
    fetchAdminErrors,
    fetchAdminOverview,
    fetchAdminTicket,
    fetchAdminTickets,
    fetchAdminUserAiUsage,
    fetchAdminUserActivity,
    fetchAdminUserDetail,
    fetchAdminUserErrors,
    fetchAdminUsers,
    replyAdminTicket,
    toAdminRequestError,
    toAdminErrorMessage,
    updateAdminTicket,
} from "./adminClient"
import { ApiClientError } from "@/app/lib/api/client"

/* ------------------------------------------------------------------ */
/* Step 7 — لایه‌ی داده‌ی Admin: endpointها + قرارداد ADR-04.            */
/* fetch سراسری mock می‌شود (محیط node بدون DOM — بدون dependency جدید). */
/* ------------------------------------------------------------------ */

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
    Promise.resolve(
        new Response(JSON.stringify({ ok: false, error: { code, message } }), { status }),
    )

describe("admin client — endpoint قراردادها", () => {
    it("fetchAdminOverview hits GET /api/admin/overview and unwraps data", async () => {
        const overview = {
            users: { dau: 1, wau: 2, mau: 3 },
            activity: { totalInWindow: 0, byEventName: [], byFeature: [], windowHours: 24 },
            aiQuota: null,
            errors: { totalInWindow: 0, bySeverity: [], topErrors: [], windowHours: 24 },
        }
        vi.mocked(fetch).mockReturnValue(ok(overview) as never)

        await expect(fetchAdminOverview()).resolves.toEqual(overview)
        expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/admin/overview", expect.anything())
    })

    it("fetchAdminUsers hits GET /api/admin/users?<query>", async () => {
        const page = { items: [], page: 1, limit: 20, total: 0, hasMore: false }
        vi.mocked(fetch).mockReturnValue(ok(page) as never)

        await expect(fetchAdminUsers("page=2&limit=20")).resolves.toEqual(page)
        expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/admin/users?page=2&limit=20", expect.anything())
    })

    it("per-user endpoints encode the id and append the query", async () => {
        vi.mocked(fetch).mockReturnValue(ok({}) as never)

        await fetchAdminUserDetail("42")
        expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/admin/users/42", expect.anything())

        await fetchAdminUserActivity("42", "page=1&limit=10")
        expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/admin/users/42/activity?page=1&limit=10", expect.anything())

        await fetchAdminUserAiUsage("42", "page=1&limit=10")
        expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/admin/users/42/ai-usage?page=1&limit=10", expect.anything())

        await fetchAdminUserErrors("42", "page=1&limit=10")
        expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/admin/users/42/errors?page=1&limit=10", expect.anything())
    })

    it("fetchAdminErrors hits GET /api/admin/errors?<query>", async () => {
        vi.mocked(fetch).mockReturnValue(ok({ items: [] }) as never)
        await fetchAdminErrors("severity=ERROR&page=1&limit=20")
        expect(vi.mocked(fetch)).toHaveBeenCalledWith(
            "/api/admin/errors?severity=ERROR&page=1&limit=20",
            expect.anything(),
        )
    })

    it("passes AbortSignal through to fetch (الگوی useDaySuggestion)", async () => {
        vi.mocked(fetch).mockReturnValue(ok({}) as never)
        const controller = new AbortController()
        await fetchAdminOverview(controller.signal)
        expect(vi.mocked(fetch)).toHaveBeenCalledWith(
            "/api/admin/overview",
            expect.objectContaining({ signal: controller.signal }),
        )
    })
})

describe("admin client — خطاها مطابق ADR-04", () => {
    it.each([
        [401, "UNAUTHORIZED", "Unauthorized"],
        [403, "ADMIN_FORBIDDEN", "دسترسی مدیریتی لازم است"],
        [404, "USER_NOT_FOUND", "کاربر یافت نشد"],
        [500, "INTERNAL", "Server error"],
    ])("maps HTTP %i %s to ApiClientError with status/code", async (status, code, message) => {
        vi.mocked(fetch).mockReturnValue(fail(status, code, message) as never)

        await expect(fetchAdminOverview()).rejects.toMatchObject({
            name: "ApiClientError",
            status,
            code,
            message,
        })
    })
})

// ---------- Ticketing (T5): صف و جزئیات تیکت ----------

describe("admin client — /admin/tickets", () => {
    const ticket = {
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

    it("fetchAdminTickets hits the ADMIN endpoint with the query", async () => {
        const page = { items: [ticket], page: 1, limit: 20, total: 1, hasMore: false }
        vi.mocked(fetch).mockReturnValue(ok(page) as never)

        await expect(fetchAdminTickets("page=1&limit=20")).resolves.toEqual(page)
        expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/admin/tickets?page=1&limit=20", expect.anything())
    })

    it("never falls back to the user endpoint (no role=ADMIN spoofing from the client)", async () => {
        vi.mocked(fetch).mockReturnValue(ok({ items: [] }) as never)

        await fetchAdminTickets("page=1")

        expect(String(vi.mocked(fetch).mock.calls[0][0]).startsWith("/api/admin/tickets")).toBe(true)
    })

    it("fetchAdminTicket unwraps { ticket, messagePage }", async () => {
        const messagePage = { page: 1, limit: 20, total: 0, hasMore: false }
        vi.mocked(fetch).mockReturnValue(
            ok({ ticket: { ...ticket, messages: [] }, messagePage }) as never,
        )

        const result = await fetchAdminTicket("5")

        expect(result.ticket.messages).toEqual([])
        expect(result.messagePage).toEqual(messagePage)
        expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/admin/tickets/5", expect.anything())
    })

    it("fetchAdminTicket appends the message-page query and never leaves the admin path", async () => {
        vi.mocked(fetch).mockReturnValue(
            ok({ ticket: { ...ticket, messages: [] }, messagePage: { page: 3, limit: 20, total: 55, hasMore: false } }) as never,
        )

        const result = await fetchAdminTicket("5", "messagesPage=3&messagesLimit=20")

        expect(String(vi.mocked(fetch).mock.calls[0][0])).toBe(
            "/api/admin/tickets/5?messagesPage=3&messagesLimit=20",
        )
        expect(result.messagePage.page).toBe(3)
    })

    it("updateAdminTicket sends a PATCH with exactly the staff payload", async () => {
        vi.mocked(fetch).mockReturnValue(ok({ ticket }) as never)

        await updateAdminTicket("5", { status: "CLOSED", priority: "URGENT" })

        const [url, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit]
        expect(url).toBe("/api/admin/tickets/5")
        expect(init.method).toBe("PATCH")
        expect(JSON.parse(String(init.body))).toEqual({ status: "CLOSED", priority: "URGENT" })
    })

    it("replyAdminTicket POSTs only the body to the messages endpoint", async () => {
        const message = { id: "m1", ticketId: 5, authorUserId: 1, body: "بررسی شد", isStaff: true, createdAt: "2026-01-01T00:00:00.000Z" }
        vi.mocked(fetch).mockReturnValue(ok({ message }) as never)

        await expect(replyAdminTicket("5", "بررسی شد")).resolves.toEqual(message)
        const [url, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit]
        expect(url).toBe("/api/admin/tickets/5/messages")
        expect(JSON.parse(String(init.body))).toEqual({ body: "بررسی شد" })
    })

    it.each([
        [401, "UNAUTHORIZED"],
        [403, "ADMIN_FORBIDDEN"],
        [404, "TICKET_NOT_FOUND"],
        [409, "TICKET_INVALID_TRANSITION"],
        [409, "TICKET_CLOSED"],
        [409, "TICKET_CONFLICT"],
    ])("maps HTTP %i %s from the ticket endpoints", async (status, code) => {
        vi.mocked(fetch).mockReturnValue(fail(status, code, "پیام") as never)

        await expect(fetchAdminTickets("page=1")).rejects.toMatchObject({ status, code })
    })
})

describe("admin client — مبدل‌های خطا", () => {
    it("preserves status/code from ApiClientError", () => {
        const err = new ApiClientError(403, "ADMIN_FORBIDDEN", "دسترسی مدیریتی لازم است")
        expect(toAdminRequestError(err)).toEqual({
            status: 403,
            code: "ADMIN_FORBIDDEN",
            message: "دسترسی مدیریتی لازم است",
        })
        expect(toAdminErrorMessage(err)).toBe("دسترسی مدیریتی لازم است")
    })

    it("maps unknown errors to a generic network error without leaking internals", () => {
        const mapped = toAdminRequestError(new Error("socket hang up"))
        expect(mapped.status).toBe(0)
        expect(mapped.code).toBe("NETWORK_ERROR")
        expect(toAdminErrorMessage("boom")).toBe("خطای ناشناخته")
    })
})
