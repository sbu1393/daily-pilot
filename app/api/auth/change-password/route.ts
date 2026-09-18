import { NextRequest } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { changePasswordSchema } from "@/app/schema/formSchema"
import { changePassword } from "@/app/lib/services/auth.service"
import {
    errorResponse,
    okMessageResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

export async function POST(req: NextRequest) {
    const context = createObservabilityContext("/api/auth/change-password", "auth")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
        if (!body) return validationErrorResponse(undefined, undefined, context.requestId)

        const parsed = changePasswordSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten(), undefined, context.requestId)
        }

        const { currentPassword, newPassword } = parsed.data

        await changePassword(user.id, currentPassword, newPassword)

        return okMessageResponse("رمز عبور با موفقیت تغییر یافت ✅", 200, context.requestId)
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "خطای سرور", undefined, context.requestId)
    }
}