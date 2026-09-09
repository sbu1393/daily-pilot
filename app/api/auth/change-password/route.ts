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

export async function POST(req: NextRequest) {
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse()

        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
        if (!body) return validationErrorResponse(undefined)

        const parsed = changePasswordSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten())
        }

        const { currentPassword, newPassword } = parsed.data

        await changePassword(user.id, currentPassword, newPassword)

        return okMessageResponse("رمز عبور با موفقیت تغییر یافت ✅")
    } catch (error) {
        const mapped = toServiceErrorResponse(error)
        if (mapped) return mapped
        console.error("CHANGE PASSWORD ERROR:", error)
        return errorResponse(500, "INTERNAL", "خطای سرور")
    }
}