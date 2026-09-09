import { NextRequest, NextResponse } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { completeTask } from "@/app/lib/services/tasks.service"
import { completeTaskSchema } from "@/app/schema/taskSchema"
import {
    errorResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"

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

        const body = (await req.json().catch(() => null)) as unknown
        const parsed = completeTaskSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten())
        }
        const { spentMinutes } = parsed.data

        const { task, result, summaries } = await completeTask(user.id, user.timezone, taskId, {
            spentMinutes,
        })

        // ADR-04: { ok, data: { task, result, summaries } }
        return NextResponse.json({ ok: true, data: { task, result, summaries } }, { status: 200 })
    } catch (error) {
        const mapped = toServiceErrorResponse(error)
        if (mapped) return mapped
        console.error("COMPLETE TASK ERROR:", error)
        return errorResponse(500, "INTERNAL_ERROR", "Server error")
    }
}