import { NextRequest } from "next/server"
import { z } from "zod"

import { requireVerifiedUser } from "@/app/lib/requireVerifiedUser"
import { isRateLimited } from "@/app/lib/rateLimit"
import { deleteUserAccount } from "@/app/lib/services/userData.service"
import {
    errorResponse,
    okMessageResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

/* مثل تغییر رمز: هر تلاش یک bcrypt.compare است → سقف سخت‌گیرانه per-user. */
const DELETE_MAX_ATTEMPTS = 5
const DELETE_WINDOW_MS = 15 * 60 * 1000

const deleteAccountSchema = z
    .object({
        password: z
            .string()
            .min(1, "رمز عبور را وارد کنید")
            .max(128, "رمز عبور بسیار طولانی است"),
    })
    .strict()

/**
 * DELETE /api/user/delete-account
 *
 * تأیید هویت با رمز عبور جاری انجام می‌شود (نه فقط نشست). پس از حذف، کوکی
 * نشست همین دستگاه هم منقضی می‌شود؛ سایر دستگاه‌ها در اولین درخواست با نبودِ
 * ردیف User به‌صورت خودکار بی‌اعتبار می‌شوند.
 */
export async function DELETE(req: NextRequest) {
    const context = createObservabilityContext("/api/user/delete-account", "account")
    try {
        const user = await requireVerifiedUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        if (isRateLimited(`delete-account:user:${user.id}`, DELETE_MAX_ATTEMPTS, DELETE_WINDOW_MS)) {
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

        const parsed = deleteAccountSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten(), undefined, context.requestId)
        }

        await deleteUserAccount(user.id, parsed.data.password)

        const response = okMessageResponse("حساب کاربری با موفقیت حذف شد", 200, context.requestId)

        // همان گزینه‌های logout — کوکی باید با همان path/attributes پاک شود.
        response.cookies.set("token", "", {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            maxAge: 0,
            path: "/",
        })

        return response
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "خطای سرور", undefined, context.requestId)
    }
}
