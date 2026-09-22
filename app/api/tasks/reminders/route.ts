import { NextRequest } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { getDueReminders } from "@/app/lib/services/tasks.service"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
} from "@/app/lib/apiResponse"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

// GET /api/tasks/reminders → یادآوری‌های «due» برای Taskهای بازِ همین کاربر.
// یادآوری per-task است و محدود به یک روز نیست، پس نمی‌تواند از GET /api/tasks (یک روز)
// پاسخ بگیرد؛ این endpoint کوچک همان قابلیت را فراهم می‌کند.
// فقط reminderAt در بازه‌ی [now - grace, now] برگردانده می‌شود تا یادآوری‌های کهنه
// با باز شدن دیرهنگام تب، اعلان اشتباهی نسازند (§12). Ownership در سرویس با userId.
export async function GET(_req: NextRequest) {
    const context = createObservabilityContext("/api/tasks/reminders", "tasks")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        const tasks = await getDueReminders(user.id)

        return okResponse(tasks, { requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
