import { NextRequest } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { getOverdueTasks } from "@/app/lib/services/tasks.service"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
} from "@/app/lib/apiResponse"

// GET /api/tasks/overdue → تسک‌های بازِ روزهای گذشته (کاندیدای انتقال به امروز)
// برخلاف GET /api/tasks که بدون dayKey فقط «امروز» را می‌دهد، این اندپوینت
// تمام تسک‌های ناتمامِ روزهای قبل را برمی‌گرداند تا بنر rollover واقعاً کار کند.
export async function GET(_req: NextRequest) {
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse()

        const tasks = await getOverdueTasks(user.id, user.timezone)

        return okResponse(tasks)
    } catch (error) {
        const mapped = toServiceErrorResponse(error)
        if (mapped) return mapped
        console.error("GET OVERDUE TASKS ERROR:", error)
        return errorResponse(500, "INTERNAL", "Server error")
    }
}