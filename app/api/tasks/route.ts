import { NextRequest, NextResponse } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { createTask, getDayTasks } from "@/app/lib/services/tasks.service"
import { getCanonicalToday } from "@/app/lib/canonicalDay"
import { createTaskSchema } from "@/app/schema/taskSchema"
import {
    errorResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"

// POST: ساخت تسک → ذخیره → bump (A3) — مستقل از AI
// C1: بدنه { title, scheduledDate } — dayKey سمت سرور از user.timezone محاسبه می‌شود (§6.2.2.1)
export async function POST(req: NextRequest) {
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse()

        // Malformed JSON → 400 VALIDATION_ERROR (الگوی P2) نه 500
        const body = await req.json().catch(() => ({}))
        const parsed = createTaskSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten())
        }

        const { title, scheduledDate } = parsed.data
        const { task } = await createTask(user.id, user.timezone, { title, scheduledDate })

        // ADR-04: { ok, data } — aiSource حذف شد (همیشه null بود؛ A5/A6)
        return NextResponse.json({ ok: true, data: { task } }, { status: 201 })
    } catch (error) {
        const mapped = toServiceErrorResponse(error)
        if (mapped) return mapped
        console.error("CREATE TASK ERROR:", error)
        return errorResponse(500, "INTERNAL", "Server error")
    }
}

// GET: تسک‌های یک روز + خلاصه (پیش‌فرض: امروز)
export async function GET(req: NextRequest) {
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse()

        const dayKey = req.nextUrl.searchParams.get("dayKey") ?? getCanonicalToday(user.timezone)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
            return errorResponse(400, "VALIDATION_ERROR", "فرمت روز نامعتبر است")
        }

        const { tasks, summary } = await getDayTasks(user.id, dayKey)

        // ADR-04: { ok, data: { tasks, summary } }
        return NextResponse.json({ ok: true, data: { tasks, summary } }, { status: 200 })
    } catch (error) {
        const mapped = toServiceErrorResponse(error)
        if (mapped) return mapped
        console.error("GET TASKS ERROR:", error)
        return errorResponse(500, "INTERNAL", "Server error")
    }
}