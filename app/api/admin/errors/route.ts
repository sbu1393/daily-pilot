import { NextRequest } from "next/server"
import { requireAdmin } from "@/app/lib/requireAdmin"
import { getAdminErrorLogs } from "@/app/lib/services/admin.query"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
} from "@/app/lib/apiResponse"

// فاز ۴ — Step 6: GET /api/admin/errors — global ErrorLog list (§10)
// (code, category, severity, endpoint, userId, from, to, page, limit).

export async function GET(req: NextRequest) {
    const context = createObservabilityContext("/api/admin/errors", "admin")
    try {
        const admin = await requireAdmin()
        context.userId = admin.id

        const sp = req.nextUrl.searchParams
        const userId = Number(sp.get("userId") ?? undefined)
        const page = Number(sp.get("page") ?? undefined)
        const pageSize = Number(sp.get("limit") ?? undefined)

        const result = await getAdminErrorLogs({
            userId: Number.isInteger(userId) && userId > 0 ? userId : undefined,
            errorCode: sp.get("code") ?? undefined,
            category: sp.get("category") ?? undefined,
            severity: sp.get("severity") ?? undefined,
            endpoint: sp.get("endpoint") ?? undefined,
            from: parseDate(sp.get("from")),
            to: parseDate(sp.get("to")),
            page: Number.isFinite(page) ? page : undefined,
            pageSize: Number.isFinite(pageSize) ? pageSize : undefined,
        })

        return okResponse(
            {
                items: result.logs,
                page: result.page,
                limit: result.pageSize,
                total: result.total,
                hasMore: result.page * result.pageSize < result.total,
            },
            { requestId: context.requestId },
        )
    } catch (error) {
        // فاز ۲ §17 — الگوی outer boundary: recordError(i) قبل از mapping، سپس پاسخ map‌شده.
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}

function parseDate(value: string | null): Date | undefined {
    if (value === null) return undefined
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? undefined : date
}
