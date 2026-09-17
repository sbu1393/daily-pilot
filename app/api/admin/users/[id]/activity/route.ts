import { NextRequest } from "next/server"
import { requireAdmin } from "@/app/lib/requireAdmin"
import { getAdminActivity } from "@/app/lib/services/admin.query"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
} from "@/app/lib/apiResponse"

// فاز ۴ — Step 6: GET /api/admin/users/[id]/activity — per-user ProductEvent history
// (§10: event, from, to, page, limit). Delegation به getAdminActivity (فاز ۳ primitive).

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const context = createObservabilityContext("/api/admin/users/[id]/activity", "admin")
    try {
        const admin = await requireAdmin()
        context.userId = admin.id

        const { id } = await params
        const userId = Number(id)
        if (!Number.isInteger(userId) || userId <= 0) {
            return errorResponse(400, "VALIDATION_ERROR", "شناسه نامعتبر است", undefined, context.requestId)
        }

        const sp = req.nextUrl.searchParams
        const since = parseDate(sp.get("from"))
        const until = parseDate(sp.get("to"))
        const page = Number(sp.get("page") ?? undefined)
        const pageSize = Number(sp.get("limit") ?? undefined)

        const result = await getAdminActivity({
            userId,
            eventName: sp.get("event") ?? undefined,
            since,
            until,
            page: Number.isFinite(page) ? page : undefined,
            pageSize: Number.isFinite(pageSize) ? pageSize : undefined,
        })

        return okResponse(
            {
                items: result.events,
                page: result.page,
                limit: result.pageSize,
                total: result.total,
                hasMore: result.page * result.pageSize < result.total,
            },
            { requestId: context.requestId },
        )
    } catch (error) {
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        recordError(error, context)
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}

function parseDate(value: string | null): Date | undefined {
    if (value === null) return undefined
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? undefined : date
}
