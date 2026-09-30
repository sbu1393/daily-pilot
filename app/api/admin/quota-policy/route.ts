import { NextRequest } from "next/server"
import { requireAdmin } from "@/app/lib/requireAdmin"
import { getPrisma } from "@/app/lib/getPrisma"
import { listQuotaPolicies, updateQuotaPolicy } from "@/app/lib/services/quotaPolicy.service"
import { readCutoverAt, resolveCurrentQuotaMode } from "@/app/lib/services/aiQuotaCutover.service"
import { getMonthlyPeriod } from "@/app/lib/services/planPolicy.service"
import { updateQuotaPolicySchema } from "@/app/schema/aiQuotaSchema"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
} from "@/app/lib/apiResponse"

// Admin V2 — AI Quota Policy (Step: Admin > AI Quota)
//
// GET  — ۴ ردیف policy + context گذار (cutover/mode/periodStart). read-only.
// POST — تغییر یک (plan × feature). actorUserId/requestId فقط از context.
//
// هیچ عددی (۱۵/۲/۲۷۰/۵۰) اینجا نیست؛ همه از جدول خوانده و به جدول نوشته می‌شود.
// audit با before/after در خودِ سرویس `updateQuotaPolicy` ثبت می‌شود (منبع حقیقت).

export async function GET() {
    const context = createObservabilityContext("/api/admin/quota-policy", "admin")
    try {
        const admin = await requireAdmin()
        context.userId = admin.id

        const prisma = getPrisma()
        const policies = await listQuotaPolicies(prisma)
        const cutoverAt = await readCutoverAt(prisma)
        const now = new Date()
        const mode = resolveCurrentQuotaMode(now, cutoverAt, "UTC")
        const periodStart = getMonthlyPeriod(now, "UTC").periodStart.toISOString()

        return okResponse(
            { policies, cutoverAt: cutoverAt.toISOString(), mode, periodStart },
            { requestId: context.requestId },
        )
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}

export async function POST(req: NextRequest) {
    const context = createObservabilityContext("/api/admin/quota-policy", "admin")
    try {
        const admin = await requireAdmin()
        context.userId = admin.id

        let body: unknown
        try {
            body = await req.json()
        } catch {
            return errorResponse(400, "VALIDATION_ERROR", "بدنه‌ی درخواست نامعتبر است", undefined, context.requestId)
        }

        const parsed = updateQuotaPolicySchema.safeParse(body)
        if (!parsed.success) {
            return errorResponse(
                400,
                "VALIDATION_ERROR",
                "اطلاعات نامعتبر است",
                parsed.error.issues,
                context.requestId,
            )
        }

        const updated = await updateQuotaPolicy(getPrisma(), {
            plan: parsed.data.plan,
            feature: parsed.data.feature,
            allowedUnits: parsed.data.allowedUnits,
            actorUserId: admin.id,
            requestId: context.requestId,
        })

        return okResponse(updated, { requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
