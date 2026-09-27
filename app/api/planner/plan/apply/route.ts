import { NextRequest } from "next/server"

import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { planApplyRequestSchema } from "@/app/schema/plannerSchema"
import type { PlanProposal } from "@/app/lib/planner/planProposal"
import { applyPlan } from "@/app/lib/services/planApply.service"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

// Phase 3 — POST /api/planner/plan/apply: اعمال یک proposal گذرا.
//
// route نازک است (Parse → Auth → Validate → Service → Envelope):
//   auth → parse (Zod) → applyPlan(...) → ADR-04 response.
// هیچ business logic اینجا نیست. هیچ AI call / quota / analytics جدید هم اینجا نیست:
//   - Apply صفر واحد quota مصرف می‌کند (quota فقط برای Generate است).
//   - Analytics جدید در این فاز اضافه نشده (به Phase 5/6 موکول).
export async function POST(req: NextRequest) {
    const context = createObservabilityContext("/api/planner/plan/apply", "planner")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        // req.json() نامعتبر/غایب → null → schema رد می‌کند (400 VALIDATION_ERROR)
        const body = (await req.json().catch(() => null)) as unknown
        const parsed = planApplyRequestSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten(), undefined, context.requestId)
        }

        const { dayKey, expectedPlanVersion, proposal, moveUnfittedToTomorrow } = parsed.data

        const result = await applyPlan(user.id, {
            dayKey,
            expectedPlanVersion,
            proposal: proposal as PlanProposal,
            // timezone از session کاربر می‌آید (نه از body) — نیمه‌شب محلیِ روز مقصد
            // باید در همان منطقهٔ زمانی‌ای محاسبه شود که روزهای کاربر با آن تعریف شده‌اند.
            timezone: user.timezone,
            // Phase 4.4 — نبودِ فیلد = رفتار قبلیِ Apply
            moveUnfittedToTomorrow: moveUnfittedToTomorrow ?? false,
        })

        return okResponse(result, { requestId: context.requestId })
    } catch (error) {
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        await recordError(error, context)
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
