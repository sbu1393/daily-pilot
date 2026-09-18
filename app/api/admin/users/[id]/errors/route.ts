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

// فاز ۴ — Step 6: GET /api/admin/users/[id]/errors — per-user ErrorLog (§10)
// (code, category, severity, from, to, page, limit). redaction فاز ۲ bypass نمی‌شود.

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const context = createObservabilityContext("/api/admin/users/[id]/errors", "admin")
    try {
        const admin = await requireAdmin()
        context.userId = admin.id

        const { id } = await params
        const userId = Number(id)
        if (!Number.isInteger(userId) || userId <= 0) {
            return errorResponse(400, "VALIDATION_ERROR", "شناسه نامعتبر است", undefined, context.requestId)
        }

        const sp = req.nextUrl.searchParams
        const page = Number(sp.get("page") ?? undefined)
        const pageSize = Number(sp.get("limit") ?? undefined)

        const result = await getAdminErrorLogs({
            userId,
            errorCode: sp.get("code") ?? undefined,
            category: sp.get("category") ?? undefined,
            severity: sp.get("severity") ?? undefined,
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
