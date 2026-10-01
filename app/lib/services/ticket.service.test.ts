import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* T3 — تست‌های لایهٔ سرویس تیکت                                     */
/*                                                                     */
/* Prisma کاملاً mock است (بدون DB زنده). این فایل سه مرز امنیتی را    */
/* قفل می‌کند: ownership/IDOR، RBAC، و state machine — به‌علاوهٔ       */
/* رفتار atomic (compare-and-set) و `closedAt` سرورکنترل‌شده.          */
/* ------------------------------------------------------------------ */

const { prismaMock, getPrismaMock } = vi.hoisted(() => {
    const prismaMock = {
        ticket: {
            create: vi.fn(),
            findFirst: vi.fn(),
            findUnique: vi.fn(),
            findMany: vi.fn(),
            count: vi.fn(),
            updateMany: vi.fn(),
        },
        ticketMessage: {
            create: vi.fn(),
            count: vi.fn(),
        },
        $transaction: vi.fn(async (arg: unknown) => {
            // فرم تعاملی: tx = همان prismaMock (فراخوانی‌ها ثبت می‌شوند)
            if (typeof arg === "function") return (arg as (tx: unknown) => unknown)(prismaMock)
            if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[])
            return arg
        }),
    }
    return { prismaMock, getPrismaMock: vi.fn(() => prismaMock) }
})

vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: getPrismaMock }))

import {
    TICKET_STATUS_TRANSITIONS,
    addTicketMessage,
    canTransitionTicketStatus,
    createTicket,
    getTicket,
    isTicketStaff,
    listTickets,
    updateTicket,
} from "./ticket.service"
import {
    TicketClosedError,
    TicketConflictError,
    TicketForbiddenError,
    TicketInvalidTransitionError,
    TicketNotFoundError,
} from "./errors"

const USER_A = { id: 1, role: "USER" as const }
const USER_B = { id: 2, role: "USER" as const }
const STAFF = { id: 9, role: "ADMIN" as const }

const INJECTED_CLOSED_AT = new Date("2000-01-01T00:00:00.000Z")

function makeTicket(overrides: Record<string, unknown> = {}) {
    return {
        id: 5,
        userId: USER_A.id,
        subject: "خطا در ثبت تسک",
        status: "OPEN",
        priority: "MEDIUM",
        category: null,
        lastMessageAt: null,
        closedAt: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        ...overrides,
    }
}

/** مسیر موفق CAS: یک ردیف آپدیت شد و نسخهٔ جدید خوانده می‌شود. */
function mockCasSuccess(updated: Record<string, unknown> = {}) {
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.ticket.findUnique.mockResolvedValue(makeTicket(updated))
}

/** مسیر شکست CAS: وضعیت هم‌زمان عوض شده ⇒ صفر ردیف. */
function mockCasConflict() {
    prismaMock.ticket.updateMany.mockResolvedValue({ count: 0 })
}

function casCall() {
    return prismaMock.ticket.updateMany.mock.calls[0][0]
}

beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.ticket.findMany.mockResolvedValue([])
    prismaMock.ticket.count.mockResolvedValue(0)
    prismaMock.ticketMessage.count.mockResolvedValue(0)
    mockCasSuccess()
})

// ───────────────────────── Ownership / IDOR ─────────────────────────

describe("ownership — user", () => {
    it("reads the user's own ticket", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket({ messages: [] }))

        const { ticket } = await getTicket(USER_A, 5)

        expect(ticket.id).toBe(5)
        // مالکیت داخل همان query اعمال می‌شود (نه بعد از خواندن)
        expect(prismaMock.ticket.findFirst.mock.calls[0][0].where).toEqual({ id: 5, userId: USER_A.id })
    })

    it("does not reveal another user's ticket (404, identical to 'missing')", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(null)

        await expect(getTicket(USER_A, 5)).rejects.toBeInstanceOf(TicketNotFoundError)
    })

    it("adds a message to the user's own ticket with server-controlled author fields", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket())
        const message = { id: "m1", ticketId: 5, authorUserId: USER_A.id, body: "سلام", isStaff: false }
        prismaMock.ticketMessage.create.mockResolvedValue(message)

        const result = await addTicketMessage(USER_A, 5, { body: "سلام" })

        expect(result.id).toBe("m1")
        const data = prismaMock.ticketMessage.create.mock.calls[0][0].data
        expect(data).toMatchObject({ ticketId: 5, authorUserId: USER_A.id, body: "سلام", isStaff: false })
    })
})

describe("IDOR — user A must not touch user B's ticket", () => {
    beforeEach(() => {
        // تیکت کاربر B فقط وقتی «id تنها» سرچ شود پیدا می‌شود؛ با فیلتر مالکیت null است
        prismaMock.ticket.findFirst.mockImplementation(async ({ where }: { where: { userId?: number } }) =>
            where.userId === USER_B.id ? makeTicket({ id: 7, userId: USER_B.id }) : null,
        )
    })

    it("rejects read and scopes the query to the actor's own id", async () => {
        await expect(getTicket(USER_A, 7)).rejects.toBeInstanceOf(TicketNotFoundError)
        // mock بالا فقط وقتی رکورد را برمی‌گرداند که فیلتر مالکیت در query باشد
        expect(prismaMock.ticket.findFirst.mock.calls[0][0].where).toEqual({ id: 7, userId: USER_A.id })
    })

    it("rejects update and performs no write", async () => {
        await expect(updateTicket(USER_A, 7, { priority: "HIGH" })).rejects.toBeInstanceOf(TicketNotFoundError)
        expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled()
    })

    it("rejects add-message and performs no write", async () => {
        await expect(addTicketMessage(USER_A, 7, { body: "دستکاری" })).rejects.toBeInstanceOf(TicketNotFoundError)
        expect(prismaMock.ticketMessage.create).not.toHaveBeenCalled()
        expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled()
    })

    it("lets the real owner reach it", async () => {
        const { ticket } = await getTicket(USER_B, 7)
        expect(ticket.userId).toBe(USER_B.id)
    })
})

// ───────────────────────────── RBAC ─────────────────────────────

describe("RBAC — staff/admin", () => {
    it("treats ADMIN as staff and USER as not staff", () => {
        expect(isTicketStaff(STAFF)).toBe(true)
        expect(isTicketStaff(USER_A)).toBe(false)
    })

    it("reads any ticket without an ownership filter", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket({ userId: USER_B.id }))

        await getTicket(STAFF, 5)

        expect(prismaMock.ticket.findFirst.mock.calls[0][0].where).toEqual({ id: 5 })
    })

    it("can set priority = URGENT", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket())
        mockCasSuccess({ priority: "URGENT" })

        await updateTicket(STAFF, 5, { priority: "URGENT" })

        expect(casCall().data).toMatchObject({ priority: "URGENT" })
    })

    it("can change category and status", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket())

        await updateTicket(STAFF, 5, { category: "billing", status: "PENDING" })

        expect(casCall().data).toMatchObject({ category: "billing", status: "PENDING" })
    })

    it("can reply with isStaff = true and flips OPEN → PENDING", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket({ status: "OPEN" }))
        prismaMock.ticketMessage.create.mockResolvedValue({ id: "m2" })

        await addTicketMessage(STAFF, 5, { body: "بررسی شد" })

        expect(prismaMock.ticketMessage.create.mock.calls[0][0].data.isStaff).toBe(true)
        expect(casCall().data).toMatchObject({ status: "PENDING" })
    })
})

describe("RBAC — normal user restrictions", () => {
    it("cannot create with priority URGENT (no escalation path)", async () => {
        await expect(
            createTicket(USER_A, { subject: "s", body: "b", priority: "URGENT" } as never),
        ).rejects.toBeInstanceOf(TicketForbiddenError)
        expect(prismaMock.ticket.create).not.toHaveBeenCalled()
    })

    it.each(["LOW", "MEDIUM", "HIGH"])("can create with priority %s", async (priority) => {
        prismaMock.ticket.create.mockResolvedValue(makeTicket({ priority }))
        prismaMock.ticketMessage.create.mockResolvedValue({ id: "m3" })

        await createTicket(USER_A, { subject: "s", body: "b", priority: priority as never })

        expect(prismaMock.ticket.create.mock.calls[0][0].data).toMatchObject({ priority })
    })

    it("cannot set priority URGENT on update", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket())

        await expect(updateTicket(USER_A, 5, { priority: "URGENT" })).rejects.toBeInstanceOf(TicketForbiddenError)
        expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled()
    })

    it("cannot change status", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket())

        await expect(updateTicket(USER_A, 5, { status: "CLOSED" })).rejects.toBeInstanceOf(TicketForbiddenError)
        expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled()
    })

    it("cannot supply server-controlled fields (mass-assignment is impossible)", async () => {
        prismaMock.ticket.create.mockResolvedValue(makeTicket())
        prismaMock.ticketMessage.create.mockResolvedValue({ id: "m4" })

        await createTicket(USER_A, {
            subject: "s",
            body: "b",
            userId: USER_B.id,
            status: "CLOSED",
            isStaff: true,
        } as never)

        const ticketData = prismaMock.ticket.create.mock.calls[0][0].data
        expect(ticketData.userId).toBe(USER_A.id)
        expect(ticketData).not.toHaveProperty("status")
        expect(prismaMock.ticketMessage.create.mock.calls[0][0].data.isStaff).toBe(false)
    })

    it("rejects a client-supplied closedAt and writes only the server value", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket())

        await updateTicket(STAFF, 5, { status: "CLOSED", closedAt: INJECTED_CLOSED_AT } as never)

        const closedAt = casCall().data.closedAt as Date
        expect(closedAt).toBeInstanceOf(Date)
        expect(closedAt).not.toEqual(INJECTED_CLOSED_AT)
    })

    it("rejects an out-of-vocabulary priority or category (defensive)", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket())

        await expect(updateTicket(USER_A, 5, { priority: "CRITICAL" } as never)).rejects.toMatchObject({
            status: 400,
            code: "VALIDATION_ERROR",
        })
        await expect(updateTicket(USER_A, 5, { category: "HOME" } as never)).rejects.toMatchObject({
            status: 400,
        })
    })

    it("rejects an empty patch", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket())

        await expect(updateTicket(USER_A, 5, {})).rejects.toMatchObject({ status: 400 })
        expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled()
    })
})

// ─────────────────────────── State machine ───────────────────────────

describe("ticket state machine", () => {
    it.each([
        ["OPEN", "PENDING"],
        ["OPEN", "CLOSED"],
        ["PENDING", "OPEN"],
        ["PENDING", "CLOSED"],
    ] as const)("allows %s → %s for staff", async (from, to) => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket({ status: from }))

        await updateTicket(STAFF, 5, { status: to })

        expect(casCall().data).toMatchObject({ status: to })
    })

    it.each([
        ["CLOSED", "OPEN"],
        ["CLOSED", "PENDING"],
    ] as const)("rejects %s → %s and writes nothing", async (from, to) => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket({ status: from, closedAt: new Date() }))

        await expect(updateTicket(STAFF, 5, { status: to })).rejects.toBeInstanceOf(TicketInvalidTransitionError)
        expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled()
    })

    it("exposes CLOSED as terminal and allows identity (no-op)", () => {
        expect(TICKET_STATUS_TRANSITIONS.CLOSED).toEqual([])
        expect(canTransitionTicketStatus("CLOSED", "OPEN")).toBe(false)
        expect(canTransitionTicketStatus("OPEN", "PENDING")).toBe(true)
        expect(canTransitionTicketStatus("PENDING", "PENDING")).toBe(true)
    })

    it("leaves an already-closed ticket's closedAt untouched on a no-op", async () => {
        const closedAt = new Date("2026-02-01T00:00:00.000Z")
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket({ status: "CLOSED", closedAt }))

        await updateTicket(STAFF, 5, { status: "CLOSED" })

        expect(casCall().data).not.toHaveProperty("closedAt")
    })
})

describe("server-controlled status transitions on reply", () => {
    it("a user reply on PENDING returns the ticket to OPEN", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket({ status: "PENDING" }))
        prismaMock.ticketMessage.create.mockResolvedValue({ id: "m5" })

        await addTicketMessage(USER_A, 5, { body: "پاسخ کاربر" })

        expect(casCall().data).toMatchObject({ status: "OPEN" })
    })

    it("a staff reply on PENDING keeps it PENDING (no redundant write field)", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket({ status: "PENDING" }))
        prismaMock.ticketMessage.create.mockResolvedValue({ id: "m6" })

        await addTicketMessage(STAFF, 5, { body: "پیگیری" })

        expect(casCall().data).not.toHaveProperty("status")
    })

    it("refuses to write a message on a CLOSED ticket", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket({ status: "CLOSED" }))

        await expect(addTicketMessage(STAFF, 5, { body: "دیر شد" })).rejects.toBeInstanceOf(TicketClosedError)
        expect(prismaMock.ticketMessage.create).not.toHaveBeenCalled()
        expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled()
    })
})

describe("closedAt", () => {
    it("is set by the server when a ticket is closed", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket({ status: "OPEN" }))

        await updateTicket(STAFF, 5, { status: "CLOSED" })

        expect(casCall().data.closedAt).toBeInstanceOf(Date)
    })

    it("is not set by a transition that is merely a priority/category change", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket())

        await updateTicket(STAFF, 5, { priority: "URGENT" })

        expect(casCall().data).not.toHaveProperty("closedAt")
    })

    it("is untouched when the transition is invalid", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket({ status: "CLOSED", closedAt: new Date() }))

        await expect(updateTicket(STAFF, 5, { status: "OPEN" })).rejects.toBeInstanceOf(
            TicketInvalidTransitionError,
        )
        expect(prismaMock.ticket.updateMany).not.toHaveBeenCalled()
    })
})

// ───────────────────── Concurrency / atomicity ─────────────────────

describe("atomicity / concurrency", () => {
    it("creates the ticket and its first message inside one transaction", async () => {
        prismaMock.ticket.create.mockResolvedValue(makeTicket())
        prismaMock.ticketMessage.create.mockResolvedValue({ id: "m7" })

        const { ticket, message } = await createTicket(USER_A, { subject: "s", body: "b" })

        expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
        expect(ticket.id).toBe(5)
        expect(message.id).toBe("m7")
        // lastMessageAt هم‌زمان با پیام اول، سمت سرور
        expect(prismaMock.ticket.create.mock.calls[0][0].data.lastMessageAt).toBeInstanceOf(Date)
    })

    it("guards the write with the observed status (compare-and-set)", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket({ status: "PENDING" }))

        await updateTicket(STAFF, 5, { status: "CLOSED" })

        expect(casCall().where).toEqual({ id: 5, status: "PENDING" })
    })

    it("fails the update when the status changed concurrently", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket({ status: "OPEN" }))
        mockCasConflict()

        await expect(updateTicket(STAFF, 5, { status: "CLOSED" })).rejects.toBeInstanceOf(TicketConflictError)
        expect(prismaMock.ticket.findUnique).not.toHaveBeenCalled()
    })

    it("rolls back the message when the compare-and-set fails", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket({ status: "OPEN" }))
        prismaMock.ticketMessage.create.mockResolvedValue({ id: "m8" })
        mockCasConflict()

        await expect(addTicketMessage(USER_A, 5, { body: "هم‌زمان" })).rejects.toBeInstanceOf(TicketConflictError)
        // خطا داخل callback تراکنش throw شده ⇒ در DB واقعی هیچ پیامی باقی نمی‌ماند
        expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    })
})

// ──────────────────────────── Listing ────────────────────────────

describe("listTickets", () => {
    it("scopes a user list to their own tickets and paginates", async () => {
        prismaMock.ticket.findMany.mockResolvedValue([makeTicket()])
        prismaMock.ticket.count.mockResolvedValue(25)

        const result = await listTickets(USER_A, { page: 2, limit: 10 })

        const where = prismaMock.ticket.findMany.mock.calls[0][0].where
        expect(where).toEqual({ userId: USER_A.id })
        expect(prismaMock.ticket.findMany.mock.calls[0][0]).toMatchObject({ skip: 10, take: 10 })
        expect(result).toMatchObject({ page: 2, limit: 10, total: 25, hasMore: true })
    })

    it("does not scope a staff list by userId and orders the queue by updatedAt", async () => {
        await listTickets(STAFF, { page: 1, limit: 20 })

        const call = prismaMock.ticket.findMany.mock.calls[0][0]
        expect(call.where).toEqual({})
        expect(call.orderBy).toEqual([{ updatedAt: "desc" }, { id: "desc" }])
    })

    it("applies the optional status filter to both roles", async () => {
        await listTickets(USER_A, { page: 1, limit: 20, status: "CLOSED" })
        expect(prismaMock.ticket.findMany.mock.calls[0][0].where).toEqual({ userId: USER_A.id, status: "CLOSED" })

        await listTickets(STAFF, { page: 1, limit: 20, status: "OPEN" })
        expect(prismaMock.ticket.findMany.mock.calls[1][0].where).toEqual({ status: "OPEN" })
    })

    it("orders a user list by newest first", async () => {
        await listTickets(USER_A, { page: 1, limit: 20 })

        expect(prismaMock.ticket.findMany.mock.calls[0][0].orderBy).toEqual([
            { createdAt: "desc" },
            { id: "desc" },
        ])
    })

    // T8: ترتیبِ صفحه‌بندی باید **قطعی** باشد. یک ستونِ timestamp به‌تنهایی کافی
    // نیست (دو تیکت می‌توانند در یک میلی‌ثانیه ساخته شوند) و در آن حالت
    // `skip/take` می‌تواند ردیفی را تکرار کند یا از قلم بیندازد. بدون tiebreaker
    // این تست‌ها شکست می‌خورند، چون ترتیبِ برگشتیِ DB تعریف‌نشده است.
    it.each([
        ["user", USER_A, [{ createdAt: "desc" }, { id: "desc" }]],
        ["staff", STAFF, [{ updatedAt: "desc" }, { id: "desc" }]],
    ] as const)("breaks %s-list ties on id so paging is deterministic", async (_label, actor, expected) => {
        await listTickets(actor, { page: 2, limit: 10 })

        const call = prismaMock.ticket.findMany.mock.calls[0][0]
        expect(call.orderBy).toEqual(expected)
        expect(call.skip).toBe(10)
        expect(call.take).toBe(10)
    })
})

// ────────────────── Message-thread pagination (R1) ──────────────────

describe("getTicket — bounded message read", () => {
    /** قفلِ تست روی query: `include.messages` باید همیشه سقف داشته باشد. */
    function messageInclude() {
        return prismaMock.ticket.findFirst.mock.calls[0][0].include.messages
    }

    it("defaults to the T2 page size and page 1 when no query is given", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket({ messages: [] }))

        const { messagePage } = await getTicket(USER_A, 5)

        expect(messageInclude()).toMatchObject({
            skip: 0,
            take: 20,
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })
        expect(messagePage).toEqual({ page: 1, limit: 20, total: 0, hasMore: false })
    })

    it("translates page/limit into skip/take and reports total/hasMore", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket({ messages: [{ id: "m1" }] }))
        prismaMock.ticketMessage.count.mockResolvedValue(45)

        const { messagePage } = await getTicket(USER_A, 5, { messagesPage: 3, messagesLimit: 20 })

        expect(messageInclude()).toMatchObject({ skip: 40, take: 20 })
        // count کلِ گفتگوست، نه طولِ صفحهٔ جاری
        expect(prismaMock.ticketMessage.count.mock.calls[0][0].where).toEqual({ ticketId: 5 })
        expect(messagePage).toEqual({ page: 3, limit: 20, total: 45, hasMore: false })
    })

    it("sets hasMore only while pages remain", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket({ messages: [] }))
        prismaMock.ticketMessage.count.mockResolvedValue(21)

        const first = await getTicket(USER_A, 5, { messagesPage: 1, messagesLimit: 20 })
        expect(first.messagePage.hasMore).toBe(true)

        const second = await getTicket(USER_A, 5, { messagesPage: 2, messagesLimit: 20 })
        expect(second.messagePage.hasMore).toBe(false)
    })

    it("counts only after ownership was proven — never counts a foreign ticket", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(null)

        await expect(getTicket(USER_A, 7, { messagesPage: 1, messagesLimit: 20 })).rejects.toBeInstanceOf(
            TicketNotFoundError,
        )
        expect(prismaMock.ticketMessage.count).not.toHaveBeenCalled()
    })

    it("keeps the ownership filter inside the paged read for staff too (no userId scope)", async () => {
        prismaMock.ticket.findFirst.mockResolvedValue(makeTicket({ userId: USER_B.id, messages: [] }))

        await getTicket(STAFF, 5, { messagesPage: 2, messagesLimit: 5 })

        expect(prismaMock.ticket.findFirst.mock.calls[0][0].where).toEqual({ id: 5 })
        expect(messageInclude()).toMatchObject({ skip: 5, take: 5 })
    })
})
