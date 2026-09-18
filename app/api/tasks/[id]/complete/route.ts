import { NextRequest } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { completeTask } from "@/app/lib/services/tasks.service"
import { completeTaskSchema } from "@/app/schema/taskSchema"
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

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const context = createObservabilityContext("/api/tasks/[id]/complete", "tasks")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        const { id } = await params
        const taskId = Number(id)
        if (!Number.isInteger(taskId) || taskId <= 0) {
            return errorResponse(400, "VALIDATION_ERROR", "شناسه نامعتبر است", undefined, context.requestId)
        }

        const body = (await req.json().catch(() => null)) as unknown
        const parsed = completeTaskSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten(), undefined, context.requestId)
        }
        const { spentMinutes } = parsed.data

        const { task, result, summaries } = await completeTask(user.id, user.timezone, taskId, {
            spentMinutes,
        })

        // فاز ۳ — گام ۷: فقط بعد از first successful completion — سرویس گارد اتمیک
        // ضد double-completion دارد (TaskAlreadyDoneError → مسیر error، بدون event/touch).
        // خارج از business transaction؛ fail-open (§17).
        try {
            const prisma = getPrisma()
            await touchAuthenticatedActivity(user.id, new Date(), prisma)
            await recordProductEvent(
                user.id,
                "task.completed",
                // فقط allowlist گام ۳ — داده‌ی واقعاً موجود در نتیجه؛ هرگز title/content
                { taskId: task.id, category: task.category, status: task.status },
                {
                    requestId: context.requestId,
                    endpoint: "/api/tasks/[id]/complete",
                    feature: "tasks",
                },
            )
        } catch {
            // fail-open — analytics failure هرگز پاسخ را fail نمی‌کند
        }

        // ADR-04: { ok, data: { task, result, summaries } }
        return okResponse({ task, result, summaries }, { requestId: context.requestId })
    } catch (error) {
        recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}