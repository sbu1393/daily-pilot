import { NextRequest } from "next/server"
import { requireAdmin } from "@/app/lib/requireAdmin"
import { getAdminGlobalActivity, getAdminActivityStats } from "@/app/lib/services/admin.query"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
} from "@/app/lib/apiResponse"

// فاز ۴ — Step 6: GET /api/admin/activity — global ProductEvent view (§10/§18)
// (event, from, to, page, limit) + stats سراسری usage رویداد. فقط read؛ fail-open stats.

export async function GET(req: NextRequest) {
    const context = createObservabilityContext("/api/admin/activity", "admin")
    try {
        const admin = await requireAdmin()
        context.userId = admin.id

        const sp = req.nextUrl.searchParams
        const page = Number(sp.get("page") ?? undefined)
        const pageSize = Number(sp.get("limit") ?? undefined)

        const [list, stats] = await Promise.all([
            getAdminGlobalActivity({
                eventName: sp.get("event") ?? undefined,
                since: parseDate(sp.get("from")),
                until: parseDate(sp.get("to")),
                page: Number.isFinite(page) ? page : undefined,
                pageSize: Number.isFinite(pageSize) ? pageSize : undefined,
            }),
            getAdminActivityStats(),
        ])

        return okResponse(
            {
                items: list.events,
                page: list.page,
                limit: list.pageSize,
                total: list.total,
                hasMore: list.page * list.pageSize < list.total,
                stats,
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
