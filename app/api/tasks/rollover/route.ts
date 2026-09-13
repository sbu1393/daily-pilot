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

export async function POST(req: NextRequest) {
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse()

        const body = await req.json()
        const parsed = rolloverSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten())
        }

        // A1 Phase 4 — planVersion اختیاری: پاسخ ADR-04 بدون تغییر می‌ماند؛ فقط رد کهنه‌ها
        // با 409 PLAN_STALE (نقشه‌برداری موجود ServiceError در apiResponse).
        const { taskIds, planVersion } = parsed.data
        const { moved, summaries } = await rolloverTasks(user.id, user.timezone, taskIds, planVersion)

        return okResponse({ moved, summaries })
    } catch (error) {
        const mapped = toServiceErrorResponse(error)
        if (mapped) return mapped
        console.error("ROLLOVER TASKS ERROR:", error)
        return errorResponse(500, "INTERNAL", "Server error")
    }
}