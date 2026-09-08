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

        const { taskIds } = parsed.data
        const { moved, summaries } = await rolloverTasks(user.id, user.timezone, taskIds)

        return okResponse({ moved, summaries })
    } catch (error) {
        const mapped = toServiceErrorResponse(error)
        if (mapped) return mapped
        console.error("ROLLOVER TASKS ERROR:", error)
        return errorResponse(500, "INTERNAL_ERROR", "Server error")
    }
}