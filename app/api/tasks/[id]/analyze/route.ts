import { NextRequest, NextResponse } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { reanalyzeTask } from "@/app/lib/services/tasks.service"
import { reanalyzeTaskSchema } from "@/app/schema/plannerSchema"
import {
    errorResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"

// این route هوش مصنوعی را صدا می‌زند؛ روی Vercel وقت بیشتری لازم دارد (روی self-host بی‌اثر است)
export const maxDuration = 60

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse()

        const { id } = await params
        const taskId = Number(id)
        if (!Number.isInteger(taskId) || taskId <= 0) {
            return errorResponse(400, "VALIDATION_ERROR", "شناسه نامعتبر است")
        }

        const body = await req.json().catch(() => ({}))
        const parsed = reanalyzeTaskSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten())
        }
        const { text: textOverride } = parsed.data

        const { task, aiSource } = await reanalyzeTask(
            user.id,
            user.timezone,
            taskId,
            textOverride,
        )

        // ADR-04: { ok, data: { task, aiSource } } — summary حذف شد (A3/A6)
        return NextResponse.json({ ok: true, data: { task, aiSource } }, { status: 200 })
    } catch (error) {
        const mapped = toServiceErrorResponse(error)
        if (mapped) return mapped
        console.error("RE-ANALYZE TASK ERROR:", error)
        return errorResponse(500, "INTERNAL_ERROR", "Server error")
    }
}