import { NextRequest } from "next/server"
import { requireAdmin } from "@/app/lib/requireAdmin"
import { getUserAiUsage } from "@/app/lib/services/admin.query"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
} from "@/app/lib/apiResponse"

// فاز ۴ — Step 6: GET /api/admin/users/[id]/ai-usage — نمای §16 (کاملاً read-only)
// (§10: period, status, page, limit). هیچ reserve/complete/release از این مسیر.

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const context = createObservabilityContext("/api/admin/users/[id]/ai-usage", "admin")
    try {
        const admin = await requireAdmin()
        context.userId = admin.id

        const { id } = await params
        const userId = Number(id)
        if (!Number.isInteger(userId) || userId <= 0) {
            return errorResponse(400, "VALIDATION_ERROR", "شناسه نامعتبر است", undefined, context.requestId)
        }

        const sp = req.nextUrl.searchParams
        const status = sp.get("status")
        const page = Number(sp.get("page") ?? undefined)
        const limit = Number(sp.get("limit") ?? undefined)

        const result = await getUserAiUsage(
            userId,
            {
                period: "MONTHLY",
                status:
                    status === "RESERVED" || status === "CONSUMED" || status === "RELEASED"
                        ? status
                        : undefined,
                page: Number.isFinite(page) ? page : undefined,
                limit: Number.isFinite(limit) ? limit : undefined,
            },
        )

        return okResponse(
            {
                plan: result.plan,
                period: result.period,
                allowedUnits: result.allowedUnits,
                reservedUnits: result.reservedUnits,
                consumedUnits: result.consumedUnits,
                utilization: result.utilization,
                items: result.events,
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
