import { NextRequest } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
} from "@/app/lib/apiResponse"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

// GET /api/push/vapid-public-key — کلید عمومی VAPID برای subscribe سمت client.
// فقط کلید عمومی برمی‌گردد؛ کلید خصوصی هرگز این‌جا خوانده/برگردانده نمی‌شود.
// اگر env تنظیم نشده باشد، publicKey = null برمی‌گردد (200) تا client بی‌صدا رد شود.
export async function GET(_req: NextRequest) {
    const context = createObservabilityContext("/api/push/vapid-public-key", "push")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() || null

        return okResponse({ publicKey }, { requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
