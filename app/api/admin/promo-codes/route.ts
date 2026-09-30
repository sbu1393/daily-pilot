import { NextRequest } from "next/server"
import { requireAdmin } from "@/app/lib/requireAdmin"
import { getPrisma } from "@/app/lib/getPrisma"
import { createPromoCode, listPromoCodes } from "@/app/lib/services/promoCode.service"
import { createPromoCodeSchema } from "@/app/schema/aiQuotaSchema"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
} from "@/app/lib/apiResponse"

// Admin V2 — Promo Codes (Step: Admin > Promo Codes)
//
// GET  — فهرست کدها (منبع حقیقت: `listPromoCodes` سرویس موجود).
// POST — ساخت کد (منبع حقیقت: `createPromoCode` + schema موجود سرویس).
//
// `actorUserId`/`requestId` فقط از context می‌آیند. audit `promo.created` در خودِ
// سرویس ثبت می‌شود. update کامل وجود ندارد (سرویس update ندارد) — فقط toggle در [id].

export async function GET() {
    const context = createObservabilityContext("/api/admin/promo-codes", "admin")
    try {
        const admin = await requireAdmin()
        context.userId = admin.id

        const items = await listPromoCodes(getPrisma())

        return okResponse({ items }, { requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}

export async function POST(req: NextRequest) {
    const context = createObservabilityContext("/api/admin/promo-codes", "admin")
    try {
        const admin = await requireAdmin()
        context.userId = admin.id

        let body: unknown
        try {
            body = await req.json()
        } catch {
            return errorResponse(400, "VALIDATION_ERROR", "بدنه‌ی درخواست نامعتبر است", undefined, context.requestId)
        }

        const parsed = createPromoCodeSchema.safeParse(body)
        if (!parsed.success) {
            return errorResponse(
                400,
                "VALIDATION_ERROR",
                "اطلاعات نامعتبر است",
                parsed.error.issues,
                context.requestId,
            )
        }

        const created = await createPromoCode(getPrisma(), {
            code: parsed.data.code,
            isActive: parsed.data.isActive,
            validFrom: new Date(parsed.data.validFrom),
            expiresAt: new Date(parsed.data.expiresAt),
            maxRedemptions: parsed.data.maxRedemptions ?? null,
            bonusAnalyzeUnits: parsed.data.bonusAnalyzeUnits,
            bonusPlanUnits: parsed.data.bonusPlanUnits,
            actorUserId: admin.id,
            requestId: context.requestId,
        })

        return okResponse(
            {
                id: created.id,
                code: created.code,
                isActive: created.isActive,
                validFrom: created.validFrom,
                expiresAt: created.expiresAt,
                maxRedemptions: created.maxRedemptions,
                bonusAnalyzeUnits: created.bonusAnalyzeUnits,
                bonusPlanUnits: created.bonusPlanUnits,
                redeemedCount: created.redeemedCount,
                createdAt: created.createdAt,
            },
            { requestId: context.requestId },
        )
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
