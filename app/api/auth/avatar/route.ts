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
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

const MAX_BYTES = 800 * 1024 // حداکثر حجم payload کدشده (~۶۰۰KB عکس اصلی)

// بررسی ساختار Base64 بدون کتابخانه (فقط کاراکترها و طول — نه محتوای واقعی عکس)
const BASE64_PAYLOAD_RE = /^[A-Za-z0-9+/]*={0,2}$/
function isValidBase64Payload(payload: string): boolean {
    return payload.length % 4 === 0 && BASE64_PAYLOAD_RE.test(payload)
}

// POST: ذخیره عکس پروفایل — عکس سمت کلاینت به data-URL فشرده تبدیل می‌شود
export async function POST(req: NextRequest) {
    const context = createObservabilityContext("/api/auth/avatar", "auth")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        const body = (await req.json().catch(() => null)) as { image?: unknown } | null
        const image = typeof body?.image === "string" ? body.image : null

        if (!image) {
            return errorResponse(400, "VALIDATION_ERROR", "عکسی ارسال نشده است", undefined, context.requestId)
        }

        if (!/^data:image\/(png|jpeg|jpg|webp);base64,/.test(image)) {
            return errorResponse(400, "VALIDATION_ERROR", "فرمت عکس معتبر نیست (PNG، JPG یا WebP)", undefined, context.requestId)
        }

        const base64Payload = image.slice(image.indexOf(",") + 1)
        if (!isValidBase64Payload(base64Payload)) {
            return errorResponse(400, "VALIDATION_ERROR", "محتوای عکس نامعتبر است", undefined, context.requestId)
        }

        if (image.length > MAX_BYTES) {
            return errorResponse(413, "VALIDATION_ERROR", "حجم عکس زیاد است؛ عکس کوچک‌تری انتخاب کنید", undefined, context.requestId)
        }

        const updated = await setAvatar(user.id, image)

        return okResponse(updated, { message: "عکس پروفایل به‌روزرسانی شد ✅", requestId: context.requestId })
    } catch (error) {
        recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "خطای سرور", undefined, context.requestId)
    }
}

// DELETE: بازگشت به آواتار پیش‌فرض (حروف اول نام)
export async function DELETE() {
    const context = createObservabilityContext("/api/auth/avatar", "auth")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        await removeAvatar(user.id)

        return okMessageResponse("عکس پروفایل حذف شد", 200, context.requestId)
    } catch (error) {
        recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "خطای سرور", undefined, context.requestId)
    }
}