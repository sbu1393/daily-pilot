import { NextRequest } from "next/server"
import { requireVerifiedUser } from "@/app/lib/requireVerifiedUser"
import { getTicket, updateTicket } from "@/app/lib/services/ticket.service"
import {
    TICKET_ID_INVALID_MESSAGE,
    ticketIdSchema,
    ticketMessagePageQuerySchema,
    updateTicketSchema,
} from "@/app/schema/ticketSchema"
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
 * T4 — /api/tickets/[id] — GET (detail) + PATCH (update)
 * ---------------------------------------------------------------
 * الگوی همان `app/api/tasks/[id]/route.ts`: شناسه از `params` خوانده و با
 * schema فاز T2 اعتبارسنجی می‌شود (به‌جای `Number.isInteger` دستیِ آن فایل، چون
 * T2 همین guard را به‌صورت reusable ساخته است).
 *
 * route **هیچ‌کدام** از policyهای دامنه را تکرار نمی‌کند:
 *   • «تیکت مال من نیست» → سرویس (`getTicket`/`updateTicket` با `findFirst`)
 *   • «کاربر نمی‌تواند status را عوض کند» / «URGENT فقط staff» → سرویس
 *   • «CLOSED پایانی است» و «closedAt سرورکنترل‌شده» → سرویس
 */

function toActor(user: { id: number; role: "USER" | "ADMIN" }) {
    return { id: user.id, role: user.role }
}

// GET: خواندن یک تیکت + **صفحهٔ جاری** پیام‌هایش. مالکیت را route فرض نمی‌کند و
// چک نمی‌کند؛ سرویس تصمیم می‌گیرد و برای تیکتِ کاربرِ دیگر 404 (نه 403) می‌دهد تا
// وجودش افشا نشود.
//
// `messagesPage`/`messagesLimit` فقط **سقفِ خواندن** را تعیین می‌کنند؛ هیچ قاعدهٔ
// دسترسی‌ای از query نمی‌آید. پاسخ هم supersetِ قبلی است: `ticket` سر جایش مانده و
// `messagePage = {page, limit, total, hasMore}` اضافه شده (R1).
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const context = createObservabilityContext("/api/tickets/[id]", "tickets")
    try {
        const user = await requireVerifiedUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        const { id } = await params
        const parsedId = ticketIdSchema.safeParse(id)
        if (!parsedId.success) {
            return errorResponse(400, "VALIDATION_ERROR", TICKET_ID_INVALID_MESSAGE, undefined, context.requestId)
        }

        const parsedQuery = ticketMessagePageQuerySchema.safeParse(
            Object.fromEntries(req.nextUrl.searchParams),
        )
        if (!parsedQuery.success) {
            return validationErrorResponse(parsedQuery.error.flatten(), undefined, context.requestId)
        }

        const { ticket, messagePage } = await getTicket(toActor(user), parsedId.data, parsedQuery.data)

        return okResponse({ ticket, messagePage }, { requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}

// PATCH: ویرایش تیکت خودِ کاربر.
export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const context = createObservabilityContext("/api/tickets/[id]", "tickets")
    try {
        const user = await requireVerifiedUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        const { id } = await params
        const parsedId = ticketIdSchema.safeParse(id)
        if (!parsedId.success) {
            return errorResponse(400, "VALIDATION_ERROR", TICKET_ID_INVALID_MESSAGE, undefined, context.requestId)
        }

        const body = await req.json().catch(() => ({}))
        const parsed = updateTicketSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten(), undefined, context.requestId)
        }

        const ticket = await updateTicket(toActor(user), parsedId.data, parsed.data)

        return okResponse({ ticket }, { requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
