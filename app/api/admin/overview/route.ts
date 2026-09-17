import { requireAdmin } from "@/app/lib/requireAdmin"
import { getAdminOverview } from "@/app/lib/services/admin.query"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
} from "@/app/lib/apiResponse"

// فاز ۴ — Step 6: GET /api/admin/overview — چهار widget مستقل (§12)
// users/activity/aiQuota/errors — شکست هر widget فقط همان widget را unavailable می‌کند.

export async function GET() {
    const context = createObservabilityContext("/api/admin/overview", "admin")
    try {
        const admin = await requireAdmin()
        context.userId = admin.id

        const overview = await getAdminOverview()

        return okResponse(overview, { requestId: context.requestId })
    } catch (error) {
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        recordError(error, context)
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
