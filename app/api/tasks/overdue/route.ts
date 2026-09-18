import { NextRequest } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { getOverdueTasks } from "@/app/lib/services/tasks.service"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
} from "@/app/lib/apiResponse"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

// GET /api/tasks/overdue → تسک‌های بازِ روزهای گذشته (کاندیدای انتقال به امروز)
// برخلاف GET /api/tasks که بدون dayKey فقط «امروز» را می‌دهد، این اندپوینت
// تمام تسک‌های ناتمامِ روزهای قبل را برمی‌گرداند تا بنر rollover واقعاً کار کند.
export async function GET(_req: NextRequest) {
    const context = createObservabilityContext("/api/tasks/overdue", "tasks")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        const tasks = await getOverdueTasks(user.id, user.timezone)

        return okResponse(tasks, { requestId: context.requestId })
    } catch (error) {
        recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}