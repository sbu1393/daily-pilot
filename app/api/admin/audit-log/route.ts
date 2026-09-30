import { NextRequest } from "next/server"
import { requireAdmin } from "@/app/lib/requireAdmin"
import { getPrisma } from "@/app/lib/getPrisma"
import { listAdminAuditLogs } from "@/app/lib/services/adminAudit.query"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
} from "@/app/lib/apiResponse"

// Admin V2 — GET /api/admin/audit-log
//
// فهرست read-only رویدادهای `AdminAuditLog` با فیلتر/صفحه‌بندی.
// redaction و projection allowlist در سرویس `adminAudit.query` انجام می‌شود؛ اینجا
// هیچ مقدار خام JSON render نمی‌شود.

function parseDate(raw: string | null): Date | undefined {
    if (!raw) return undefined
    const d = new Date(raw)
    return Number.isNaN(d.getTime()) ? undefined : d
}

export async function GET(req: NextRequest) {
    const context = createObservabilityContext("/api/admin/audit-log", "admin")
    try {
        const admin = await requireAdmin()
        context.userId = admin.id

        const sp = req.nextUrl.searchParams
        const page = Number(sp.get("page") ?? undefined)
        const limit = Number(sp.get("limit") ?? undefined)
        const actorRaw = Number(sp.get("actorUserId") ?? undefined)

        const result = await listAdminAuditLogs(getPrisma(), {
            action: sp.get("action")?.trim() || undefined,
            targetType: sp.get("targetType")?.trim() || undefined,
            targetId: sp.get("targetId")?.trim() || undefined,
            actorUserId: Number.isInteger(actorRaw) && actorRaw > 0 ? actorRaw : undefined,
            from: parseDate(sp.get("from")),
            to: parseDate(sp.get("to")),
            page: Number.isFinite(page) ? page : undefined,
            pageSize: Number.isFinite(limit) ? limit : undefined,
        })

        return okResponse(
            {
                items: result.items,
                page: result.page,
                limit: result.pageSize,
                total: result.total,
                hasMore: result.page * result.pageSize < result.total,
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
