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

// GET: اطلاعات حساب کاربری جاری
export async function GET() {
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse()
        return okResponse(user)
    } catch (error) {
        const mapped = toServiceErrorResponse(error)
        if (mapped) return mapped
        console.error("PROFILE GET ERROR:", error)
        return errorResponse(500, "INTERNAL", "خطای سرور")
    }
}

// PATCH: ویرایش اطلاعات حساب کاربری
export async function PATCH(req: NextRequest) {
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse()

        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
        if (!body) return validationErrorResponse(undefined)

        const parsed = profileSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten())
        }

        const updated = await updateProfile(user.id, user.username, parsed.data)

        return okResponse(updated, { message: "اطلاعات حساب با موفقیت ذخیره شد" })
    } catch (error) {
        const mapped = toServiceErrorResponse(error)
        if (mapped) return mapped
        console.error("PROFILE PATCH ERROR:", error)
        return errorResponse(500, "INTERNAL", "خطای سرور")
    }
}