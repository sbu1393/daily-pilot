import { NextRequest, NextResponse } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { deleteTask, getTask, updateTask } from "@/app/lib/services/tasks.service"
import { updateTaskSchema } from "@/app/schema/taskSchema"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"

function parseTaskId(raw: string): number | null {
    const id = Number(raw)
    return Number.isInteger(id) && id > 0 ? id : null
}

// GET: خواندن تک تسک — Ownership در سرویس (findFirst با userId)
export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse()

        const { id } = await params
        const taskId = parseTaskId(id)
        if (taskId == null) {
            return errorResponse(400, "VALIDATION_ERROR", "شناسه نامعتبر است")
        }

        const task = await getTask(user.id, taskId)

        return okResponse(task)
    } catch (error) {
        const mapped = toServiceErrorResponse(error)
        if (mapped) return mapped
        console.error("GET TASK ERROR:", error)
        return errorResponse(500, "INTERNAL", "Server error")
    }
}

export async function DELETE(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse()

        const { id } = await params
        const taskId = parseTaskId(id)
        if (taskId == null) {
            return errorResponse(400, "VALIDATION_ERROR", "شناسه نامعتبر است")
        }

        const { id: deletedId, summary } = await deleteTask(user.id, taskId)

        return okResponse({ id: deletedId, summary }, { message: "تسک حذف شد" })
    } catch (error) {
        const mapped = toServiceErrorResponse(error)
        if (mapped) return mapped
        console.error("DELETE TASK ERROR:", error)
        return errorResponse(500, "INTERNAL", "Server error")
    }
}

// A1 — PATCH: ویرایش تسک (Content vs Planning-only — §6.3.5)
// C1: فیلدهای مجاز ویرایش = title، status (TODO/IN_PROGRESS)، scheduledDate، category
export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse()

        const { id } = await params
        const taskId = parseTaskId(id)
        if (taskId == null) {
            return errorResponse(400, "VALIDATION_ERROR", "شناسه نامعتبر است")
        }

        // Malformed JSON → 400 VALIDATION_ERROR (الگوی P2) نه 500
        const body = await req.json().catch(() => ({}))
        const parsed = updateTaskSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten())
        }

        const { task } = await updateTask(user.id, user.timezone, taskId, parsed.data)

        return okResponse(task, { message: "تسک به‌روزرسانی شد" })
    } catch (error) {
        const mapped = toServiceErrorResponse(error)
        if (mapped) return mapped
        console.error("UPDATE TASK ERROR:", error)
        return errorResponse(500, "INTERNAL", "Server error")
    }
}