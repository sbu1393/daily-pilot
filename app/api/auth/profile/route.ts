import { NextRequest } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { profileSchema } from "@/app/schema/formSchema"
import { updateProfile } from "@/app/lib/services/auth.service"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import { getPrisma } from "@/app/lib/getPrisma"
import { touchAuthenticatedActivity } from "@/app/lib/services/userActivity.service"
import { recordProductEvent } from "@/app/lib/services/productEvent.service"

// GET: اطلاعات حساب کاربری جاری
export async function GET() {
    const context = createObservabilityContext("/api/auth/profile", "auth")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id
        return okResponse(user, { requestId: context.requestId })
    } catch (error) {
        recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "خطای سرور", undefined, context.requestId)
    }
}

// PATCH: ویرایش اطلاعات حساب کاربری
export async function PATCH(req: NextRequest) {
    const context = createObservabilityContext("/api/auth/profile", "auth")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
        if (!body) return validationErrorResponse(undefined, undefined, context.requestId)

        const parsed = profileSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten(), undefined, context.requestId)
        }

        const updated = await updateProfile(user.id, user.username, parsed.data)

        // فاز ۳ — گام ۸: profile.updated فقط بعد از mutation موفق؛ خارج از business
        // transaction؛ fail-open — هرگز پاسخ را تغییر نمی‌دهد (§17).
        try {
            // changedFields فقط نام فیلدهای واقعاً تغییرکرده — هرگز مقدار (§8).
            // مبنای مقایسه: snapshot سمت سرور کاربر (getCurrentUser)؛ نه بدنه‌ی کلاینت.
            const changedFields = [
                ...(parsed.data.username !== user.username ? ["username"] : []),
                ...(parsed.data.firstName !== undefined &&
                (parsed.data.firstName ?? null) !== (user.firstName ?? null)
                    ? ["firstName"]
                    : []),
                ...(parsed.data.lastName !== undefined &&
                (parsed.data.lastName ?? null) !== (user.lastName ?? null)
                    ? ["lastName"]
                    : []),
                ...(parsed.data.phone !== undefined &&
                (parsed.data.phone ?? null) !== (user.phone ?? null)
                    ? ["phone"]
                    : []),
                ...(parsed.data.birthDate !== undefined &&
                (parsed.data.birthDate ?? null) !== birthDateInput(user.birthDate)
                    ? ["birthDate"]
                    : []),
            ]

            const prisma = getPrisma()
            await touchAuthenticatedActivity(user.id, new Date(), prisma)
            await recordProductEvent(
                user.id,
                "profile.updated",
                { changedFields }, // فقط allowlist گام ۳ — هرگز email/phone/مقدار (§8)
                { requestId: context.requestId, endpoint: "/api/auth/profile", feature: "auth" },
            )
        } catch {
            // fail-open — analytics failure هرگز پاسخ را fail نمی‌کند
        }

        return okResponse(updated, { message: "اطلاعات حساب با موفقیت ذخیره شد", requestId: context.requestId })
    } catch (error) {
        recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "خطای سرور", undefined, context.requestId)
    }
}

/**
 * نرمال‌سازی birthDate ذخیره‌شده به رشته‌ی ورودی ISO-سازگار برای مقایسه‌ی no-op (گام ۸).
 * snapshot سمت سرور (User.birthDate as Date) در مقابل رشته‌ی ISO ارسالی کلاینت مقایسه می‌شود.
 */
function birthDateInput(stored: Date | string | null): string | null {
    if (stored === null || stored === undefined) return null
    if (typeof stored === "string") return stored
    return stored.toISOString()
}