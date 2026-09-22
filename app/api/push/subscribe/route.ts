import { NextRequest } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { removePushSubscription, savePushSubscription } from "@/app/lib/services/push.service"
import { pushSubscribeSchema, pushUnsubscribeSchema } from "@/app/schema/pushSchema"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

// POST /api/push/subscribe — ثبت اشتراک Web Push کاربر جاری.
// userId هرگز از body خوانده نمی‌شود؛ ownership از session می‌آید.
// endpoint یکتا: ثبت دوباره رکورد تکراری نمی‌سازد و lastSeenAt را تازه می‌کند.
export async function POST(req: NextRequest) {
    const context = createObservabilityContext("/api/push/subscribe", "push")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        // Payload نامعتبر/malformed → 400، نه 500
        const body = await req.json().catch(() => ({}))
        const parsed = pushSubscribeSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten(), undefined, context.requestId)
        }

        const subscription = await savePushSubscription(user.id, parsed.data)

        // فقط فیلدهای غیرحساس برمی‌گردند؛ کلیدهای auth/p256dh هرگز echo نمی‌شوند.
        return okResponse(
            { id: subscription.id, endpoint: subscription.endpoint, lastSeenAt: subscription.lastSeenAt },
            { status: 201, message: "اشتراک اعلان ثبت شد", requestId: context.requestId },
        )
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}

// DELETE /api/push/subscribe?endpoint=... — حذف اشتراک متعلق به کاربر جاری.
// endpoint به‌عنوان identifier استفاده می‌شود (URL-encoded). حذف فقط در محدوده‌ی
// userId انجام می‌شود؛ نتیجه idempotent است و وجود/عدم‌وجود اشتراک دیگری را لو نمی‌دهد.
export async function DELETE(req: NextRequest) {
    const context = createObservabilityContext("/api/push/subscribe", "push")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        const endpoint = req.nextUrl.searchParams.get("endpoint")
        const parsed = pushUnsubscribeSchema.safeParse({ endpoint })
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten(), undefined, context.requestId)
        }

        const { removed } = await removePushSubscription(user.id, parsed.data.endpoint)

        return okResponse({ removed }, { message: "اشتراک اعلان حذف شد", requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
