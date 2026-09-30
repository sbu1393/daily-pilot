import { NextRequest } from "next/server"
import { requireAdmin } from "@/app/lib/requireAdmin"
import { getAdminUserQuotaDetail } from "@/app/lib/services/admin.query"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
} from "@/app/lib/apiResponse"

// Admin V2 — GET /api/admin/users/[id]/quota
//
// نمای V2-aware سهمیه یک کاربر: effective plan (از Entitlement) + mode (LEGACY/NEW)
// + periodStart + تفکیک BASE/PROMO برای ANALYZE و PLAN.
//
// کاملاً read-only. مسیر قدیمی `/ai-usage` دست‌نخورده برای history باقی می‌ماند.

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const context = createObservabilityContext("/api/admin/users/[id]/quota", "admin")
    try {
        const admin = await requireAdmin()
        context.userId = admin.id

        const { id } = await params
        const userId = Number(id)
        if (!Number.isInteger(userId) || userId <= 0) {
            return errorResponse(400, "VALIDATION_ERROR", "شناسه نامعتبر است", undefined, context.requestId)
        }

        const detail = await getAdminUserQuotaDetail(userId)

        return okResponse(detail, { requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
