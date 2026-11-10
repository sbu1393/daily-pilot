import { NextRequest } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { isRateLimited } from "@/app/lib/rateLimit"
import { createSession } from "@/app/lib/createSession"
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

/* تغییر رمز عملیات حساس است (هر تلاش یک bcrypt cost 12) → سقف per-user. */
const CHANGE_PASSWORD_MAX_ATTEMPTS = 5
const CHANGE_PASSWORD_WINDOW_MS = 15 * 60 * 1000

export async function POST(req: NextRequest) {
    const context = createObservabilityContext("/api/auth/change-password", "auth")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        if (
            isRateLimited(
                `changepw:user:${user.id}`,
                CHANGE_PASSWORD_MAX_ATTEMPTS,
                CHANGE_PASSWORD_WINDOW_MS,
            )
        ) {
            return errorResponse(
                429,
                "RATE_LIMITED",
                "تعداد تلاش‌ها زیاد است؛ کمی بعد دوباره تلاش کن",
                undefined,
                context.requestId,
            )
        }

        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
        if (!body) return validationErrorResponse(undefined, undefined, context.requestId)

        const parsed = changePasswordSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten(), undefined, context.requestId)
        }

        const { currentPassword, newPassword } = parsed.data

        const passwordHash = await changePassword(user.id, currentPassword, newPassword)

        /*
         * کوکی همین دستگاه باید بازصدور شود: توکن فعلی claim `sv` قدیمی دارد و
         * بعد از تغییر رمز در اولین درخواست باطل می‌شد. بقیهٔ دستگاه‌ها عمداً
         * بازصدور نمی‌شوند — همان‌ها باید logout شوند.
         */
        const response = okMessageResponse("رمز عبور با موفقیت تغییر یافت ✅", 200, context.requestId)

        return createSession(
            {
                id: user.id,
                email: user.email,
                mustChangePassword: false,
                resetTokenId: null,
            },
            response,
            { passwordHash },
        )
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "خطای سرور", undefined, context.requestId)
    }
}