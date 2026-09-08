import { NextRequest } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { setAvatar, removeAvatar } from "@/app/lib/services/auth.service"
import {
    errorResponse,
    okMessageResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
} from "@/app/lib/apiResponse"

const MAX_BYTES = 800 * 1024 // حداکثر حجم payload کدشده (~۶۰۰KB عکس اصلی)

// بررسی ساختار Base64 بدون کتابخانه (فقط کاراکترها و طول — نه محتوای واقعی عکس)
const BASE64_PAYLOAD_RE = /^[A-Za-z0-9+/]*={0,2}$/
function isValidBase64Payload(payload: string): boolean {
    return payload.length % 4 === 0 && BASE64_PAYLOAD_RE.test(payload)
}

// POST: ذخیره عکس پروفایل — عکس سمت کلاینت به data-URL فشرده تبدیل می‌شود
export async function POST(req: NextRequest) {
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse()

        const body = (await req.json().catch(() => null)) as { image?: unknown } | null
        const image = typeof body?.image === "string" ? body.image : null

        if (!image) {
            return errorResponse(400, "VALIDATION_ERROR", "عکسی ارسال نشده است")
        }

        if (!/^data:image\/(png|jpeg|jpg|webp);base64,/.test(image)) {
            return errorResponse(400, "VALIDATION_ERROR", "فرمت عکس معتبر نیست (PNG، JPG یا WebP)")
        }

        const base64Payload = image.slice(image.indexOf(",") + 1)
        if (!isValidBase64Payload(base64Payload)) {
            return errorResponse(400, "VALIDATION_ERROR", "محتوای عکس نامعتبر است")
        }

        if (image.length > MAX_BYTES) {
            return errorResponse(413, "VALIDATION_ERROR", "حجم عکس زیاد است؛ عکس کوچک‌تری انتخاب کنید")
        }

        const updated = await setAvatar(user.id, image)

        return okResponse(updated, { message: "عکس پروفایل به‌روزرسانی شد ✅" })
    } catch (error) {
        const mapped = toServiceErrorResponse(error)
        if (mapped) return mapped
        console.error("AVATAR POST ERROR:", error)
        return errorResponse(500, "INTERNAL_ERROR", "خطای سرور")
    }
}

// DELETE: بازگشت به آواتار پیش‌فرض (حروف اول نام)
export async function DELETE() {
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse()

        await removeAvatar(user.id)

        return okMessageResponse("عکس پروفایل حذف شد")
    } catch (error) {
        const mapped = toServiceErrorResponse(error)
        if (mapped) return mapped
        console.error("AVATAR DELETE ERROR:", error)
        return errorResponse(500, "INTERNAL_ERROR", "خطای سرور")
    }
}