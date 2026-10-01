import { NextRequest } from "next/server"
import { requireVerifiedUser } from "@/app/lib/requireVerifiedUser"
import { createTicket, listTickets } from "@/app/lib/services/ticket.service"
import { createTicketSchema, ticketListQuerySchema } from "@/app/schema/ticketSchema"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"

/*
 * T4 — Ticket routes (user surface): GET (list) + POST (create)
 * ---------------------------------------------------------------
 * این routeها عمداً **thin** هستند و هیچ business logic ندارند. ترتیب لایه‌ها
 * دقیقاً همان convention مخزن است:
 *
 *   createObservabilityContext → requireVerifiedUser → schema.safeParse (T2)
 *   → ticket.service (T3) → okResponse
 *   → catch: recordError → toServiceErrorResponse → 500 INTERNAL
 *
 * آنچه اینجا **عمداً** نیست:
 *   • ownership / IDOR  → در `ticket.service` و داخل خودِ query
 *   • state transition  → `ticket.service`
 *   • priority policy   → `ticket.service`
 *   • `closedAt`        → سمت سرور در `ticket.service`
 *
 * `actor` فقط از identity احراز‌شده ساخته می‌شود (`user.id` + `user.role` که
 * DB-backed است). هرگز `body.userId` یا `body.role` خوانده نمی‌شود؛ schemaهای
 * T2 هم `.strict()` هستند و این کلیدها را پیش از رسیدن به سرویس رد می‌کنند.
 *
 * هم‌ارز با `/api/tasks/route.ts` و `/api/admin/users/route.ts`.
 */

/** actor از session؛ `role` از DB (`User.role`) — همان منبعی که requireAdmin رویش تکیه می‌کند. */
function toActor(user: { id: number; role: "USER" | "ADMIN" }) {
    return { id: user.id, role: user.role }
}

// GET: فهرست تیکت‌های خودِ کاربر — scope در سرویس (کاربر فقط مالک خودش را می‌بیند).
// pagination همان قرارداد مخزن: `page`/`limit` → `{items, page, limit, total, hasMore}`
// (الگوی GET /api/admin/users).
export async function GET(req: NextRequest) {
    const context = createObservabilityContext("/api/tickets", "tickets")
    try {
        const user = await requireVerifiedUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        const parsed = ticketListQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten(), undefined, context.requestId)
        }

        const result = await listTickets(toActor(user), parsed.data)

        return okResponse(
            {
                items: result.items,
                page: result.page,
                limit: result.limit,
                total: result.total,
                hasMore: result.hasMore,
            },
            { requestId: context.requestId },
        )
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}

// POST: ساخت تیکت — subject + body اجباری. `userId`/`status`/`closedAt`/`isStaff`
// هرگز از بدنه پذیرفته نمی‌شوند (schema فاز T2 + سرویس فاز T3).
export async function POST(req: NextRequest) {
    const context = createObservabilityContext("/api/tickets", "tickets")
    try {
        const user = await requireVerifiedUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        // Malformed JSON → 400 VALIDATION_ERROR (الگوی P2) نه 500
        const body = await req.json().catch(() => ({}))
        const parsed = createTicketSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten(), undefined, context.requestId)
        }

        const { ticket } = await createTicket(toActor(user), parsed.data)

        return okResponse({ ticket }, { status: 201, requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
