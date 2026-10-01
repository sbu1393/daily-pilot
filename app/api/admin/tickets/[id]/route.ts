import { NextRequest } from "next/server"
import { requireAdmin } from "@/app/lib/requireAdmin"
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
    validationErrorResponse,
} from "@/app/lib/apiResponse"

/*
 * T4 — /api/admin/tickets/[id] — GET (detail) + PATCH (update)
 * ---------------------------------------------------------------
 * الگوی `app/api/admin/promo-codes/[id]/route.ts` با این تفاوت که به‌جای یک
 * schema inline، از `updateTicketSchema` فاز T2 استفاده می‌شود.
 *
 * تفاوت با مسیر کاربر (`/api/tickets/[id]`) فقط **گارد** است؛ منطق یکسان است و
 * هر دو به همان متدهای سرویس فاز T3 می‌روند. یعنی staff هم نمی‌تواند از مسیر
 * HTTP چیزی را دور بزند که سرویس بسته است (`CLOSED` پایانی، `closedAt`
 * سرورکنترل‌شده، CAS/atomic).
 */

// GET: همان سرویس و همان سقفِ خواندنِ مسیر کاربر (R1) — فقط گارد فرق دارد
// (`requireAdmin`). `messagesPage`/`messagesLimit` صرفاً pagination گفتگوست.
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const context = createObservabilityContext("/api/admin/tickets/[id]", "admin")
    try {
        const admin = await requireAdmin()
        context.userId = admin.id

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

        const { ticket, messagePage } = await getTicket(
            { id: admin.id, role: admin.role },
            parsedId.data,
            parsedQuery.data,
        )

        return okResponse({ ticket, messagePage }, { requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const context = createObservabilityContext("/api/admin/tickets/[id]", "admin")
    try {
        const admin = await requireAdmin()
        context.userId = admin.id

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

        const ticket = await updateTicket({ id: admin.id, role: admin.role }, parsedId.data, parsed.data)

        return okResponse({ ticket }, { requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
