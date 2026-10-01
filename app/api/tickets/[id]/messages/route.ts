import { NextRequest } from "next/server"
import { requireVerifiedUser } from "@/app/lib/requireVerifiedUser"
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
    unauthorizedResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"

/*
 * T4 — /api/tickets/[id]/messages — POST (پیام جدید)
 * ---------------------------------------------------------------
 * الگوی sub-resource در مخزن (`/api/tasks/[id]/analyze`، `/api/admin/users/[id]/ai-usage`).
 *
 * فقط `body` از کلاینت می‌آید. `authorUserId` و `isStaff` در سرویس از actor
 * تعیین می‌شوند و schema فاز T2 هرگز آن‌ها را نمی‌پذیرد (`.strict()`).
 *
 * route بررسی نمی‌کند تیکت بسته است یا مال چه کسی است — این‌ها در سرویس‌اند و
 * خطاهایشان (`TicketClosedError` / `TicketNotFoundError` / `TicketForbiddenError`)
 * بدون mapping تکراری از `toServiceErrorResponse` ترجمه می‌شوند.
 */

function toActor(user: { id: number; role: "USER" | "ADMIN" }) {
    return { id: user.id, role: user.role }
}

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const context = createObservabilityContext("/api/tickets/[id]/messages", "tickets")
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
        const parsed = addTicketMessageSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten(), undefined, context.requestId)
        }

        const message = await addTicketMessage(toActor(user), parsedId.data, parsed.data)

        return okResponse({ message }, { status: 201, requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
