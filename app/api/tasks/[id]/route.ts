import { NextRequest } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { deleteTask, getTask, updateTask } from "@/app/lib/services/tasks.service"
import { makeUpdateTaskSchema } from "@/app/schema/taskSchema"
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

function parseTaskId(raw: string): number | null {
    const id = Number(raw)
    return Number.isInteger(id) && id > 0 ? id : null
}

// GET: خواندن تک تسک — Ownership در سرویس (findFirst با userId)
export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const context = createObservabilityContext("/api/tasks/[id]", "tasks")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        const { id } = await params
        const taskId = parseTaskId(id)
        if (taskId == null) {
            return errorResponse(400, "VALIDATION_ERROR", "شناسه نامعتبر است", undefined, context.requestId)
        }

        const task = await getTask(user.id, taskId)

        return okResponse(task, { requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}

export async function DELETE(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const context = createObservabilityContext("/api/tasks/[id]", "tasks")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        const { id } = await params
        const taskId = parseTaskId(id)
        if (taskId == null) {
            return errorResponse(400, "VALIDATION_ERROR", "شناسه نامعتبر است", undefined, context.requestId)
        }

        const { id: deletedId, summary } = await deleteTask(user.id, taskId)

        // فاز ۳ — گام ۷: فقط بعد از delete موفق (not-found → مسیر error، بدون event/touch).
        // خارج از business transaction؛ fail-open (§17).
        try {
            const prisma = getPrisma()
            await touchAuthenticatedActivity(user.id, new Date(), prisma)
            await recordProductEvent(
                user.id,
                "task.deleted",
                { taskId: deletedId }, // فقط allowlist گام ۳
                { requestId: context.requestId, endpoint: "/api/tasks/[id]", feature: "tasks" },
            )
        } catch {
            // fail-open — analytics failure هرگز پاسخ را fail نمی‌کند
        }

        return okResponse({ id: deletedId, summary }, { message: "تسک حذف شد", requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}

// A1 — PATCH: ویرایش تسک (Content vs Planning-only — §6.3.5)
// C1: فیلدهای مجاز ویرایش = title، status (TODO/IN_PROGRESS)، scheduledDate، category
export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const context = createObservabilityContext("/api/tasks/[id]", "tasks")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        const { id } = await params
        const taskId = parseTaskId(id)
        if (taskId == null) {
            return errorResponse(400, "VALIDATION_ERROR", "شناسه نامعتبر است", undefined, context.requestId)
        }

        // Malformed JSON → 400 VALIDATION_ERROR (الگوی P2) نه 500
        const body = await req.json().catch(() => ({}))
        const parsed = makeUpdateTaskSchema(user.timezone).safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten(), undefined, context.requestId)
        }

        const { task, changed, changedFields } = await updateTask(user.id, user.timezone, taskId, parsed.data)

        // فاز ۳ — گام ۸: task.updated فقط برای mutation واقعی (changed === true).
        // no-op → بدون event و بدون touch. خارج از business transaction؛ fail-open (§17).
        if (changed) {
            try {
                // context اصلی handler استفاده می‌شود — هیچ context/requestId دومی این‌جا ساخته نمی‌شود
                const prisma = getPrisma()
                await touchAuthenticatedActivity(user.id, new Date(), prisma)
                await recordProductEvent(
                    user.id,
                    "task.updated",
                    // فقط allowlist گام ۳: taskId + نام فیلدها؛ هرگز title/description/content (§8)
                    { taskId, changedFields },
                    { requestId: context.requestId, endpoint: "/api/tasks/[id]", feature: "tasks" },
                )
            } catch {
                // fail-open — analytics failure هرگز پاسخ را fail نمی‌کند
            }
        }

        return okResponse(task, { message: "تسک به‌روزرسانی شد", requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}