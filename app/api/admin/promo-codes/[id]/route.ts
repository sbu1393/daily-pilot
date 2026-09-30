import { NextRequest } from "next/server"
import { z } from "zod"
import { requireAdmin } from "@/app/lib/requireAdmin"
import { getPrisma } from "@/app/lib/getPrisma"
import { setPromoCodeActive } from "@/app/lib/services/promoCode.service"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
} from "@/app/lib/apiResponse"

// Admin V2 — Promo Code toggle (Step: Admin > Promo Codes)
//
// PATCH — فقط `{ isActive: boolean }`. منبع حقیقت: `setPromoCodeActive` (سرویس موجود).
// audit `promo.updated` در خودِ سرویس ثبت می‌شود. update کامل عمداً وجود ندارد چون
// سرویس فعلی update واقعی ندارد.

const patchSchema = z.object({ isActive: z.boolean() }).strict()

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const context = createObservabilityContext("/api/admin/promo-codes/[id]", "admin")
    try {
        const admin = await requireAdmin()
        context.userId = admin.id

        const { id } = await params
        if (typeof id !== "string" || id.trim().length === 0) {
            return errorResponse(400, "VALIDATION_ERROR", "شناسه نامعتبر است", undefined, context.requestId)
        }

        let body: unknown
        try {
            body = await req.json()
        } catch {
            return errorResponse(400, "VALIDATION_ERROR", "بدنه‌ی درخواست نامعتبر است", undefined, context.requestId)
        }

        const parsed = patchSchema.safeParse(body)
        if (!parsed.success) {
            return errorResponse(
                400,
                "VALIDATION_ERROR",
                "اطلاعات نامعتبر است",
                parsed.error.issues,
                context.requestId,
            )
        }

        const ok = await setPromoCodeActive(getPrisma(), {
            promoCodeId: id,
            isActive: parsed.data.isActive,
            actorUserId: admin.id,
            requestId: context.requestId,
        })
        if (!ok) {
            return errorResponse(404, "NOT_FOUND", "کد هدیه پیدا نشد", undefined, context.requestId)
        }

        return okResponse({ id, isActive: parsed.data.isActive }, { requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
