import { NextRequest } from "next/server"
import { requireAdmin } from "@/app/lib/requireAdmin"
import { getUserDetail } from "@/app/lib/services/admin.query"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
} from "@/app/lib/apiResponse"

// فاز ۴ — Step 6: GET /api/admin/users/[id] — safe identity + summary (§15)
// کاملاً read-only؛ IDOR-safe (admin-only guard + server-side id parsing).

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const context = createObservabilityContext("/api/admin/users/[id]", "admin")
    try {
        const admin = await requireAdmin()
        context.userId = admin.id

        const { id } = await params
        const userId = Number(id)
        if (!Number.isInteger(userId) || userId <= 0) {
            return errorResponse(400, "VALIDATION_ERROR", "شناسه نامعتبر است", undefined, context.requestId)
        }

        const detail = await getUserDetail(userId)

        return okResponse(detail, { requestId: context.requestId })
    } catch (error) {
        // فاز ۲ §17 — الگوی outer boundary: recordError(i) قبل از mapping، سپس پاسخ map‌شده.
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
