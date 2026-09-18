import { NextRequest } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { rolloverTasks } from "@/app/lib/services/tasks.service"
import { rolloverSchema } from "@/app/schema/plannerSchema"
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

export async function POST(req: NextRequest) {
    const context = createObservabilityContext("/api/tasks/rollover", "tasks")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        const body = await req.json()
        const parsed = rolloverSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten(), undefined, context.requestId)
        }

        // A1 Phase 4 — planVersion اختیاری: پاسخ ADR-04 بدون تغییر می‌ماند؛ فقط رد کهنه‌ها
        // با 409 PLAN_STALE (نقشه‌برداری موجود ServiceError در apiResponse).
        const { taskIds, planVersion } = parsed.data
        const { moved, summaries } = await rolloverTasks(user.id, user.timezone, taskIds, planVersion)

        // فاز ۳ — گام ۷: granularity per-task (تصمیم مهدی) — فقط برای taskهایی که
        // واقعاً moved شده‌اند؛ moved=[] → هیچ event. touch تک‌بار در boundary موفقیت.
        // خارج از business transaction؛ fail-open (§17).
        try {
            const prisma = getPrisma()
            await touchAuthenticatedActivity(user.id, new Date(), prisma)
            for (const item of moved) {
                await recordProductEvent(
                    user.id,
                    "task.rolled_over",
                    // فقط allowlist گام ۳: taskId + toDayKey (from در قرارداد قفل نشده)
                    { taskId: item.id, toDayKey: item.to },
                    {
                        requestId: context.requestId,
                        endpoint: "/api/tasks/rollover",
                        feature: "tasks",
                    },
                )
            }
        } catch {
            // fail-open — analytics failure هرگز پاسخ را fail نمی‌کند
        }

        return okResponse({ moved, summaries }, { requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}