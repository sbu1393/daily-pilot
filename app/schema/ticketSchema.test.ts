import { describe, expect, it } from "vitest"

/* ------------------------------------------------------------------ */
/* مرز ورودی Ticketing (T2) — فقط اعتبارسنجی ساختاری                  */
/*                                                                     */
/* این تست‌ها عمداً به هیچ DB/سرویس/روتی وابسته نیستند: هدف قفل‌کردن    */
/* قواعد فیلدها، enumها، سقف طول‌ها و ردِ فیلدهای سرورکنترل‌شده است.   */
/* ------------------------------------------------------------------ */

import {
    TICKET_BODY_MAX_LENGTH,
    TICKET_CATEGORY_KEYS,
    TICKET_DEFAULT_PAGE_SIZE,
    TICKET_MAX_PAGE_SIZE,
    TICKET_MESSAGE_DEFAULT_PAGE_SIZE,
    TICKET_MESSAGE_MAX_PAGE_SIZE,
    TICKET_NO_CHANGES_MESSAGE,
    TICKET_SUBJECT_MAX_LENGTH,
    addTicketMessageSchema,
    createTicketSchema,
    isTicketCategoryKey,
    ticketIdSchema,
    ticketListQuerySchema,
    ticketMessagePageQuerySchema,
    updateTicketSchema,
} from "./ticketSchema"

const at = (n: number) => "ا".repeat(n)

const validCreate = { subject: "خطا در ثبت تسک", body: "وقتی تسک می‌سازم صفحه سفید می‌شود." }

describe("createTicketSchema", () => {
    it("accepts a minimal valid ticket (subject + body only)", () => {
        const r = createTicketSchema.safeParse(validCreate)
        expect(r.success).toBe(true)
        if (r.success) {
            expect(r.data.category).toBeUndefined()
            expect(r.data.priority).toBeUndefined()
        }
    })

    it("trims subject and body", () => {
        const r = createTicketSchema.safeParse({
            subject: "  موضوع  ",
            body: "  متن پیام  ",
        })
        expect(r.success).toBe(true)
        if (r.success) {
            expect(r.data.subject).toBe("موضوع")
            expect(r.data.body).toBe("متن پیام")
        }
    })

    it.each([
        ["missing subject", { body: validCreate.body }],
        ["empty subject", { ...validCreate, subject: "" }],
        ["whitespace-only subject", { ...validCreate, subject: "   " }],
        ["non-string subject", { ...validCreate, subject: 5 }],
        ["missing body", { subject: validCreate.subject }],
        ["empty body", { ...validCreate, body: "" }],
        ["whitespace-only body", { ...validCreate, body: "\t \n " }],
        ["non-string body", { ...validCreate, body: 5 }],
    ])("rejects %s", (_label, payload) => {
        expect(createTicketSchema.safeParse(payload).success).toBe(false)
    })

    it("accepts an over-limit subject of exactly the max length and rejects one more", () => {
        expect(
            createTicketSchema.safeParse({ ...validCreate, subject: at(TICKET_SUBJECT_MAX_LENGTH) }).success,
        ).toBe(true)
        expect(
            createTicketSchema.safeParse({ ...validCreate, subject: at(TICKET_SUBJECT_MAX_LENGTH + 1) }).success,
        ).toBe(false)
    })

    it("accepts an over-limit body of exactly the max length and rejects one more", () => {
        expect(
            createTicketSchema.safeParse({ ...validCreate, body: at(TICKET_BODY_MAX_LENGTH) }).success,
        ).toBe(true)
        expect(
            createTicketSchema.safeParse({ ...validCreate, body: at(TICKET_BODY_MAX_LENGTH + 1) }).success,
        ).toBe(false)
    })

    it.each(TICKET_CATEGORY_KEYS)("accepts the ticket category %s", (category) => {
        const r = createTicketSchema.safeParse({ ...validCreate, category })
        expect(r.success).toBe(true)
        if (r.success) expect(r.data.category).toBe(category)
    })

    it("rejects an unknown or malformed category", () => {
        for (const category of ["HOME", "other ", "urgent", "unknown", "", 5, null]) {
            expect(createTicketSchema.safeParse({ ...validCreate, category }).success).toBe(false)
        }
    })

    it.each(["LOW", "MEDIUM", "HIGH"])("accepts the user priority %s", (priority) => {
        const r = createTicketSchema.safeParse({ ...validCreate, priority })
        expect(r.success).toBe(true)
        if (r.success) expect(r.data.priority).toBe(priority)
    })

    it("rejects URGENT on user create (support-controlled escalation)", () => {
        expect(createTicketSchema.safeParse({ ...validCreate, priority: "URGENT" }).success).toBe(false)
    })

    it("rejects an invalid priority value", () => {
        expect(createTicketSchema.safeParse({ ...validCreate, priority: "CRITICAL" }).success).toBe(false)
    })

    it("is strict — rejects server-controlled / unknown fields", () => {
        for (const extra of [
            { userId: 1 },
            { status: "OPEN" },
            { isStaff: true },
            { closedAt: null },
            { lastMessageAt: "2026-01-01" },
            { authorUserId: 1 },
        ]) {
            expect(createTicketSchema.safeParse({ ...validCreate, ...extra }).success).toBe(false)
        }
    })
})

describe("addTicketMessageSchema", () => {
    it("accepts a valid body", () => {
        const r = addTicketMessageSchema.safeParse({ body: "پیگیری: هنوز مشکل باقی است." })
        expect(r.success).toBe(true)
        if (r.success) expect(r.data.body).toBe("پیگیری: هنوز مشکل باقی است.")
    })

    it("trims the body", () => {
        const r = addTicketMessageSchema.safeParse({ body: "  سلام  " })
        expect(r.success).toBe(true)
        if (r.success) expect(r.data.body).toBe("سلام")
    })

    it.each([
        ["missing body", {}],
        ["empty body", { body: "" }],
        ["whitespace-only body", { body: "   " }],
        ["non-string body", { body: 5 }],
        ["body over the limit", { body: at(TICKET_BODY_MAX_LENGTH + 1) }],
    ])("rejects %s", (_label, payload) => {
        expect(addTicketMessageSchema.safeParse(payload).success).toBe(false)
    })

    it("is strict — rejects the server-controlled fields of TicketMessage", () => {
        for (const extra of [
            { authorUserId: 1 },
            { isStaff: true },
            { ticketId: 1 },
            { status: "CLOSED" },
            { closedAt: null },
        ]) {
            expect(addTicketMessageSchema.safeParse({ body: "ok", ...extra }).success).toBe(false)
        }
    })
})

describe("ticketListQuerySchema", () => {
    it("applies the repository defaults when page/limit are omitted", () => {
        const r = ticketListQuerySchema.safeParse({})
        expect(r.success).toBe(true)
        if (r.success) {
            expect(r.data.page).toBe(1)
            expect(r.data.limit).toBe(TICKET_DEFAULT_PAGE_SIZE)
        }
    })

    it("coerces numeric query strings", () => {
        const r = ticketListQuerySchema.safeParse({ page: "3", limit: "50" })
        expect(r.success).toBe(true)
        if (r.success) {
            expect(r.data.page).toBe(3)
            expect(r.data.limit).toBe(50)
        }
    })

    it.each([
        ["page=0", { page: "0" }],
        ["negative page", { page: "-1" }],
        ["non-numeric page", { page: "abc" }],
        ["non-integer page", { page: "1.5" }],
        ["limit=0", { limit: "0" }],
        ["non-numeric limit", { limit: "abc" }],
        ["limit over the max", { limit: String(TICKET_MAX_PAGE_SIZE + 1) }],
    ])("rejects %s", (_label, payload) => {
        expect(ticketListQuerySchema.safeParse(payload).success).toBe(false)
    })

    it("accepts the max page size and rejects an invalid status", () => {
        expect(ticketListQuerySchema.safeParse({ limit: String(TICKET_MAX_PAGE_SIZE) }).success).toBe(true)
        expect(ticketListQuerySchema.safeParse({ status: "OPEN" }).success).toBe(true)
        expect(ticketListQuerySchema.safeParse({ status: "ARCHIVED" }).success).toBe(false)
    })
})

describe("ticketMessagePageQuerySchema", () => {
    it("applies the repository defaults when the query is empty", () => {
        const r = ticketMessagePageQuerySchema.safeParse({})
        expect(r.success).toBe(true)
        if (r.success) {
            expect(r.data.messagesPage).toBe(1)
            expect(r.data.messagesLimit).toBe(TICKET_MESSAGE_DEFAULT_PAGE_SIZE)
        }
    })

    it("coerces numeric query strings", () => {
        const r = ticketMessagePageQuerySchema.safeParse({ messagesPage: "2", messagesLimit: "50" })
        expect(r.success).toBe(true)
        if (r.success) {
            expect(r.data.messagesPage).toBe(2)
            expect(r.data.messagesLimit).toBe(50)
        }
    })

    it.each([
        ["page=0", { messagesPage: "0" }],
        ["negative page", { messagesPage: "-1" }],
        ["non-numeric page", { messagesPage: "abc" }],
        ["non-integer page", { messagesPage: "1.5" }],
        ["limit=0", { messagesLimit: "0" }],
        ["non-numeric limit", { messagesLimit: "abc" }],
        ["limit over the max", { messagesLimit: String(TICKET_MESSAGE_MAX_PAGE_SIZE + 1) }],
    ])("rejects %s — a thread read is never unbounded", (_label, payload) => {
        expect(ticketMessagePageQuerySchema.safeParse(payload).success).toBe(false)
    })

    it("accepts exactly the max page size", () => {
        expect(
            ticketMessagePageQuerySchema.safeParse({
                messagesLimit: String(TICKET_MESSAGE_MAX_PAGE_SIZE),
            }).success,
        ).toBe(true)
    })

    it("ignores unrelated query params instead of failing the whole request", () => {
        // پارامترهای ناشناخته از querystring نویز هستند؛ schema آن‌ها را حذف
        // می‌کند (zod پیش‌فرض) و به سرویس نمی‌رسند.
        const r = ticketMessagePageQuerySchema.safeParse({
            messagesPage: "1",
            messagesLimit: "20",
            userId: "999",
            role: "ADMIN",
        })
        expect(r.success).toBe(true)
        if (r.success) expect(r.data).toEqual({ messagesPage: 1, messagesLimit: 20 })
    })

    it("shares the repository pagination policy with the ticket list", () => {
        expect(TICKET_MESSAGE_DEFAULT_PAGE_SIZE).toBe(TICKET_DEFAULT_PAGE_SIZE)
        expect(TICKET_MESSAGE_MAX_PAGE_SIZE).toBe(TICKET_MAX_PAGE_SIZE)
    })
})

describe("ticketIdSchema", () => {
    it("accepts a positive integer and its numeric-string form", () => {
        expect(ticketIdSchema.safeParse(42).success).toBe(true)
        const r = ticketIdSchema.safeParse("42")
        expect(r.success).toBe(true)
        if (r.success) expect(r.data).toBe(42)
    })

    it.each([0, -1, 1.5, "0", "-3", "", "abc", null, undefined, {}])("rejects %p", (value) => {
        expect(ticketIdSchema.safeParse(value).success).toBe(false)
    })
})

describe("updateTicketSchema", () => {
    it("accepts each supported field", () => {
        expect(updateTicketSchema.safeParse({ status: "PENDING" }).success).toBe(true)
        expect(updateTicketSchema.safeParse({ priority: "URGENT" }).success).toBe(true)
        expect(updateTicketSchema.safeParse({ category: "billing" }).success).toBe(true)
        expect(updateTicketSchema.safeParse({ category: null }).success).toBe(true)
    })

    it("permits the full priority enum, including URGENT", () => {
        for (const priority of ["LOW", "MEDIUM", "HIGH", "URGENT"]) {
            expect(updateTicketSchema.safeParse({ priority }).success).toBe(true)
        }
    })

    it("rejects invalid enum values", () => {
        expect(updateTicketSchema.safeParse({ status: "RESOLVED" }).success).toBe(false)
        expect(updateTicketSchema.safeParse({ priority: "CRITICAL" }).success).toBe(false)
        expect(updateTicketSchema.safeParse({ category: "HOME" }).success).toBe(false)
    })

    it("rejects an empty patch (no-change guard)", () => {
        const r = updateTicketSchema.safeParse({})
        expect(r.success).toBe(false)
        if (!r.success) {
            expect(JSON.stringify(r.error.flatten())).toContain(TICKET_NO_CHANGES_MESSAGE)
        }
    })

    it("is strict — rejects ownership / author / assignment fields", () => {
        for (const extra of [
            { userId: 1 },
            { authorUserId: 1 },
            { assignedToUserId: 1 },
            { isStaff: true },
            { ticketId: 1 },
            { subject: "x" },
            { body: "x" },
            { closedAt: null },
        ]) {
            expect(updateTicketSchema.safeParse({ ...extra, status: "CLOSED" }).success).toBe(false)
        }
    })
})

describe("isTicketCategoryKey", () => {
    it("is a total guard that never throws", () => {
        expect(isTicketCategoryKey("bug")).toBe(true)
        for (const value of ["BUG", "", null, undefined, 5, {}]) {
            expect(isTicketCategoryKey(value)).toBe(false)
        }
    })
})
