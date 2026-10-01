import { describe, expect, it } from "vitest"

/* ------------------------------------------------------------------ */
/* T5 — تست‌های لایهٔ نمایش تیکت (pure، بدون DOM — الگوی رسمی مخزن:    */
/* adminViewModels.test.ts / aiQuotaView.test.ts)                       */
/*                                                                     */
/* تمرکز اصلی: (۱) واژگان از schema فاز T2 مشتق می‌شود، (۲) payloadها   */
/* allowlist‌اند و هیچ فیلد سرورکنترل‌شده‌ای نشت نمی‌کند، (۳) خطاهای    */
/* داخلی به کاربر نمایش داده نمی‌شوند.                                  */
/* ------------------------------------------------------------------ */

import { ApiClientError } from "@/app/lib/api/client"
import {
    TICKET_BODY_MAX,
    TICKET_CATEGORY_OPTIONS,
    TICKET_MESSAGE_PAGE_LIMIT,
    TICKET_STATUS_OPTIONS,
    TICKET_SUBJECT_MAX,
    TICKET_USER_PRIORITY_OPTIONS,
    buildCreateTicketPayload,
    buildMessageThreadLabel,
    buildStaffTicketUpdatePayload,
    buildTicketListQuery,
    buildTicketMessagePayload,
    buildTicketMessages,
    buildTicketMessagesQuery,
    buildTicketPagination,
    buildTicketRow,
    buildUserTicketUpdatePayload,
    canReplyToTicket,
    formatTicketTime,
    isRetryableTicketError,
    resolveTicketListStatus,
    ticketCategoryLabel,
    ticketErrorMessage,
    ticketPriorityLabel,
    ticketStatusHint,
    ticketStatusLabel,
} from "./ticketViewModels"
import type { TicketView } from "./ticketTypes"

const ticket = (overrides: Partial<TicketView> = {}): TicketView => ({
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
    ...overrides,
})

// ───────────────────── vocabulary comes from T2 ─────────────────────

describe("گزینه‌های فرم از schema فاز T2 مشتق می‌شوند", () => {
    it("user priority options never include URGENT", () => {
        expect(TICKET_USER_PRIORITY_OPTIONS).toEqual(["LOW", "MEDIUM", "HIGH"])
        expect(TICKET_USER_PRIORITY_OPTIONS).not.toContain("URGENT")
    })

    it("staff sees the full priority vocabulary, including URGENT", () => {
        expect(TICKET_USER_PRIORITY_OPTIONS.length).toBe(3)
    })

    it("status/category options mirror the API enums", () => {
        expect(TICKET_STATUS_OPTIONS).toEqual(["OPEN", "PENDING", "CLOSED"])
        expect(TICKET_CATEGORY_OPTIONS).toEqual(["bug", "billing", "account", "feature", "question", "other"])
    })

    it("exposes the T2 length limits so the UI mirrors them", () => {
        expect(TICKET_SUBJECT_MAX).toBe(120)
        expect(TICKET_BODY_MAX).toBe(5000)
    })
})

// ───────────────────────────── labels ─────────────────────────────

describe("برچسب‌های فارسی", () => {
    it("maps every enum value to a label", () => {
        expect(ticketStatusLabel("OPEN")).toBe("باز")
        expect(ticketStatusLabel("PENDING")).toBe("در انتظار")
        expect(ticketStatusLabel("CLOSED")).toBe("بسته")
        expect(ticketPriorityLabel("URGENT")).toBe("فوری")
        expect(ticketCategoryLabel("bug")).toBe("اشکال فنی")
    })

    it("falls back gracefully for a missing/unknown category", () => {
        expect(ticketCategoryLabel(null)).toBe("بدون دسته")
        expect(ticketCategoryLabel("")).toBe("بدون دسته")
        expect(ticketCategoryLabel("WEIRD")).toBe("WEIRD")
    })

    it("explains PENDING from each perspective (per the T1 definition)", () => {
        expect(ticketStatusHint("PENDING", "user")).toContain("شما")
        expect(ticketStatusHint("PENDING", "staff")).toContain("کاربر")
    })
})

// ───────────────────────────── time ─────────────────────────────

describe("formatTicketTime", () => {
    const now = Date.parse("2026-01-01T12:00:00.000Z")

    it("renders relative times with Persian digits", () => {
        expect(formatTicketTime("2026-01-01T11:30:00.000Z", now)).toBe("۳۰ دقیقه پیش")
        expect(formatTicketTime("2026-01-01T09:00:00.000Z", now)).toBe("۳ ساعت پیش")
    })

    it("falls back to an absolute date for older than a day", () => {
        const label = formatTicketTime("2025-12-20T09:00:00.000Z", now)
        expect(label).not.toBeNull()
        expect(label).not.toContain("پیش")
    })

    it("never throws on invalid input", () => {
        expect(formatTicketTime(null)).toBeNull()
        expect(formatTicketTime(undefined)).toBeNull()
        expect(formatTicketTime("not-a-date")).toBeNull()
    })
})

// ─────────────────── list status & pagination ───────────────────

describe("resolveTicketListStatus", () => {
    it("follows loading → error → empty → data", () => {
        expect(resolveTicketListStatus(true, null, 0)).toBe("loading")
        expect(resolveTicketListStatus(false, "خطا", 0)).toBe("error")
        expect(resolveTicketListStatus(false, null, 0)).toBe("empty")
        expect(resolveTicketListStatus(false, null, 3)).toBe("data")
    })
})

describe("buildTicketPagination", () => {
    it("derives nav state from the API's hasMore", () => {
        expect(buildTicketPagination(2, 20, 45, true)).toEqual({
            page: 2,
            totalPages: 3,
            hasPrev: true,
            hasNext: true,
        })
        expect(buildTicketPagination(3, 20, 45, false)).toMatchObject({ hasPrev: true, hasNext: false })
        expect(buildTicketPagination(1, 20, 45, false)).toMatchObject({ hasPrev: false, hasNext: false })
    })

    it("never renders 'صفحهٔ ۱ از ۰'", () => {
        expect(buildTicketPagination(1, 20, 0, false).totalPages).toBe(1)
    })
})

describe("buildTicketListQuery", () => {
    it("serializes only allowlisted params", () => {
        expect(buildTicketListQuery({ page: 2, limit: 10, status: "OPEN" })).toBe(
            "status=OPEN&page=2&limit=10",
        )
    })

    it("drops an unknown status instead of forwarding it", () => {
        expect(buildTicketListQuery({ page: 1, limit: 20, status: "RESOLVED" as never })).toBe("page=1&limit=20")
    })

    it("clamps page/limit to at least 1", () => {
        expect(buildTicketListQuery({ page: 0, limit: -5 })).toBe("page=1&limit=1")
    })
})

// ───────────── message-thread pagination (R1) ─────────────

describe("buildTicketMessagesQuery", () => {
    it("serializes only the two params the T2 schema reads", () => {
        expect(buildTicketMessagesQuery({ page: 3, limit: 25 })).toBe("messagesPage=3&messagesLimit=25")
    })

    it("defaults to page 1 and the T2 page size", () => {
        expect(buildTicketMessagesQuery()).toBe("messagesPage=1&messagesLimit=20")
        expect(TICKET_MESSAGE_PAGE_LIMIT).toBe(20)
    })

    it("clamps to at least 1 so the URL is never malformed", () => {
        expect(buildTicketMessagesQuery({ page: 0, limit: -5 })).toBe("messagesPage=1&messagesLimit=1")
        expect(buildTicketMessagesQuery({ page: 2.9 })).toBe("messagesPage=2&messagesLimit=20")
    })

    it("forwards nothing else — no identity or ownership param can be smuggled in", () => {
        const query = buildTicketMessagesQuery({ page: 1, limit: 20 } as never)
        expect(query).not.toMatch(/userId|role|isStaff|ticketId|status/)
    })
})

describe("buildMessageThreadLabel", () => {
    it("shows the visible range of a full first page with Persian digits", () => {
        expect(buildMessageThreadLabel(1, 20, 50)).toBe("نمایش ۱ تا ۲۰ از ۵۰ پیام")
    })

    it("clamps the end of a short last page to the total", () => {
        expect(buildMessageThreadLabel(3, 20, 45)).toBe("نمایش ۴۱ تا ۴۵ از ۴۵ پیام")
    })

    it("never shows a range beyond the total on an out-of-range page", () => {
        expect(buildMessageThreadLabel(99, 20, 45)).toBe("نمایش ۴۵ تا ۴۵ از ۴۵ پیام")
    })

    it("degrades gracefully for a thread with no messages", () => {
        expect(buildMessageThreadLabel(1, 20, 0)).toBe("بدون پیام")
    })

    it("never throws or prints NaN on hostile numbers", () => {
        expect(buildMessageThreadLabel(0, 0, -5)).toBe("بدون پیام")
        expect(buildMessageThreadLabel(Number.NaN, 20, 10)).toBe("نمایش ۱ تا ۱۰ از ۱۰ پیام")
        expect(buildMessageThreadLabel(2, Number.POSITIVE_INFINITY, Number.NaN)).toBe("بدون پیام")
    })
})

// ────────────────────────── error mapping ──────────────────────────

describe("ticketErrorMessage", () => {
    it.each([
        ["TICKET_NOT_FOUND", "تعلق ندارد"],
        ["TICKET_FORBIDDEN", "دسترسی ندارید"],
        ["TICKET_CLOSED", "بسته شده"],
        ["TICKET_INVALID_TRANSITION", "وضعیت"],
        ["TICKET_CONFLICT", "هم‌زمان"],
        ["VALIDATION_ERROR", "معتبر نیست"],
        ["UNAUTHORIZED", "وارد شوید"],
    ])("maps %s to a friendly Persian message", (code, fragment) => {
        expect(ticketErrorMessage(new ApiClientError(400, code, "raw server text"))).toContain(fragment)
    })

    it("never leaks the internal code or raw server text to the user", () => {
        const message = ticketErrorMessage(new ApiClientError(409, "TICKET_CONFLICT", "stack trace here"))

        expect(message).not.toContain("TICKET_CONFLICT")
        expect(message).not.toContain("stack trace")
    })

    it("falls back for an unknown code, a plain Error, and a non-error value", () => {
        expect(ticketErrorMessage({ code: "WEIRD_THING" })).toBe("خطای ناشناخته؛ دوباره تلاش کنید.")
        expect(ticketErrorMessage(new Error("شبکه قطع شد"))).toBe("شبکه قطع شد")
        expect(ticketErrorMessage(undefined)).toBe("خطای ناشناخته؛ دوباره تلاش کنید.")
    })

    it("flags only conflict/internal as retryable", () => {
        expect(isRetryableTicketError({ code: "TICKET_CONFLICT" })).toBe(true)
        expect(isRetryableTicketError({ code: "INTERNAL" })).toBe(true)
        expect(isRetryableTicketError({ code: "TICKET_NOT_FOUND" })).toBe(false)
        expect(isRetryableTicketError({ code: "TICKET_FORBIDDEN" })).toBe(false)
    })
})

// ─────────────────── composer availability (UX only) ───────────────────

describe("canReplyToTicket", () => {
    it("is disabled only for CLOSED", () => {
        expect(canReplyToTicket("OPEN")).toBe(true)
        expect(canReplyToTicket("PENDING")).toBe(true)
        expect(canReplyToTicket("CLOSED")).toBe(false)
    })
})

// ─────────────────────── row & message mapping ───────────────────────

describe("buildTicketRow", () => {
    it("maps a ticket to display labels", () => {
        const row = buildTicketRow(ticket({ status: "PENDING", priority: "URGENT", category: "billing" }))

        expect(row).toMatchObject({
            id: 5,
            subject: "خطا در ثبت تسک",
            statusLabel: "در انتظار",
            priorityLabel: "فوری",
            categoryLabel: "پرداخت و اشتراک",
        })
    })

    it("falls back to lastMessageAt for the row timestamp", () => {
        const row = buildTicketRow(ticket({ lastMessageAt: null, updatedAt: "2026-01-01T00:00:00.000Z" }))
        expect(row.updatedLabel).not.toBeNull()
    })
})

describe("buildTicketMessages", () => {
    const now = Date.parse("2026-01-01T12:00:00.000Z")

    it("labels staff vs user from the server-provided isStaff snapshot", () => {
        const rows = buildTicketMessages(
            [
                { id: "a", ticketId: 5, authorUserId: 1, body: "سلام", isStaff: false, createdAt: "2026-01-01T11:50:00.000Z" },
                { id: "b", ticketId: 5, authorUserId: 9, body: "بررسی شد", isStaff: true, createdAt: "2026-01-01T11:55:00.000Z" },
            ],
            now,
        )

        expect(rows.map((r) => r.authorLabel)).toEqual(["شما", "پشتیبانی"])
        expect(rows[0].timeLabel).toBe("۱۰ دقیقه پیش")
    })
})

// ───────────────── payload allowlist (security) ─────────────────

describe("buildCreateTicketPayload", () => {
    it("trims and sends only subject/body plus valid optionals", () => {
        expect(buildCreateTicketPayload({ subject: "  عنوان  ", body: "  متن  ", category: "bug", priority: "HIGH" })).toEqual({
            subject: "عنوان",
            body: "متن",
            category: "bug",
            priority: "HIGH",
        })
    })

    it("omits optional fields when not provided", () => {
        expect(buildCreateTicketPayload({ subject: "s", body: "b" })).toEqual({ subject: "s", body: "b" })
    })

    it("drops an out-of-vocabulary category and priority", () => {
        const payload = buildCreateTicketPayload({ subject: "s", body: "b", category: "HOME", priority: "URGENT" })

        expect(payload).not.toHaveProperty("category")
        expect(payload).not.toHaveProperty("priority")
    })

    it.each(["userId", "authorUserId", "isStaff", "ticketId", "status", "closedAt", "assignedToUserId", "role"])(
        "never forwards the server-controlled field %s",
        (field) => {
            const payload = buildCreateTicketPayload({
                subject: "s",
                body: "b",
                [field]: field === "isStaff" ? true : 999,
            } as never)

            expect(payload).not.toHaveProperty(field)
            expect(Object.keys(payload).sort()).toEqual(["body", "subject"])
        },
    )
})

describe("buildUserTicketUpdatePayload", () => {
    it("sends only priority and category", () => {
        expect(buildUserTicketUpdatePayload({ priority: "LOW", category: "account" })).toEqual({
            priority: "LOW",
            category: "account",
        })
    })

    it("supports clearing the category with an empty string → null", () => {
        expect(buildUserTicketUpdatePayload({ category: "" })).toEqual({ category: null })
    })

    it("drops URGENT for a user (staff-only escalation cannot be built from the user UI)", () => {
        expect(buildUserTicketUpdatePayload({ priority: "URGENT" })).toEqual({})
    })

    it("never forwards status/ownership fields", () => {
        const payload = buildUserTicketUpdatePayload({
            status: "CLOSED",
            userId: 999,
            closedAt: "2026-01-01",
        } as never)

        expect(payload).toEqual({})
    })
})

describe("buildStaffTicketUpdatePayload", () => {
    it("allows status, URGENT priority and category", () => {
        expect(buildStaffTicketUpdatePayload({ status: "CLOSED", priority: "URGENT", category: "bug" })).toEqual({
            status: "CLOSED",
            priority: "URGENT",
            category: "bug",
        })
    })

    it("clears the category with an empty string", () => {
        expect(buildStaffTicketUpdatePayload({ category: "" })).toEqual({ category: null })
    })

    it("drops invalid enum values instead of forwarding them", () => {
        expect(buildStaffTicketUpdatePayload({ status: "RESOLVED", priority: "CRITICAL", category: "X" })).toEqual({})
    })

    it("never forwards server-controlled identity fields", () => {
        const payload = buildStaffTicketUpdatePayload({
            status: "PENDING",
            userId: 999,
            assignedToUserId: 4,
            authorUserId: 4,
            isStaff: true,
            closedAt: "2026-01-01",
        } as never)

        expect(payload).toEqual({ status: "PENDING" })
    })
})

describe("buildTicketMessagePayload", () => {
    it("trims and sends only the body", () => {
        expect(buildTicketMessagePayload("  سلام  ")).toEqual({ body: "سلام" })
    })

    it("never forwards author or ticket identity", () => {
        const payload = buildTicketMessagePayload("سلام") as unknown as Record<string, unknown>

        expect(Object.keys(payload)).toEqual(["body"])
    })
})
