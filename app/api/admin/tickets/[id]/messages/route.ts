import { NextRequest } from "next/server"
import { requireAdmin } from "@/app/lib/requireAdmin"
import { addTicketMessage } from "@/app/lib/services/ticket.service"
import {
    TICKET_ID_INVALID_MESSAGE,
    addTicketMessageSchema,
    ticketIdSchema,
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
 * T4 — /api/admin/tickets/[id]/messages — POST (پاسخ کارمند)
 * ---------------------------------------------------------------
 * این مسیر همان چیزی است که در سرویس فاز T3 به‌صورت خودکار `OPEN → PENDING`
 * («در انتظار پاسخ کاربر») را فعال می‌کند، پس بدون آن آن transition از طریق
 * HTTP اصلاً در دسترس نبود.
 *
 * فقط `body` از کلاینت می‌آید؛ `isStaff = true` و `authorUserId` در سرویس از
 * نقش DB-backed کارمند تعیین می‌شوند (و در پیام snapshot می‌مانند).
 */

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const context = createObservabilityContext("/api/admin/tickets/[id]/messages", "admin")
    try {
        const admin = await requireAdmin()
        context.userId = admin.id

        const { id } = await params
        const parsedId = ticketIdSchema.safeParse(id)
        if (!parsedId.success) {
            return errorResponse(400, "VALIDATION_ERROR", TICKET_ID_INVALID_MESSAGE, undefined, context.requestId)
        }

        const body = await req.json().catch(() => ({}))
        const parsed = addTicketMessageSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten(), undefined, context.requestId)
        }

        const message = await addTicketMessage({ id: admin.id, role: admin.role }, parsedId.data, parsed.data)

        return okResponse({ message }, { status: 201, requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
