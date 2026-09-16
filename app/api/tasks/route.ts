import { NextRequest } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { createTask, getDayTasks } from "@/app/lib/services/tasks.service"
import { getCanonicalToday, isValidCanonicalDayKey } from "@/app/lib/canonicalDay"
import { makeCreateTaskSchema } from "@/app/schema/taskSchema"
import { buildAdvisor, type AdvisorResult } from "@/app/lib/planner/advisor"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"

// POST: ساخت تسک → ذخیره → bump (A3) — مستقل از AI
// C1: بدنه { title, scheduledDate } — dayKey سمت سرور از user.timezone محاسبه می‌شود (§6.2.2.1)
export async function POST(req: NextRequest) {
    // فاز صفر Observability — requestId فقط سمت سرور تولید می‌شود (هرگز از کلاینت خوانده نمی‌شود)
    const context = createObservabilityContext("/api/tasks")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        // Malformed JSON → 400 VALIDATION_ERROR (الگوی P2) نه 500
        const body = await req.json().catch(() => ({}))
        const parsed = makeCreateTaskSchema(user.timezone).safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten(), undefined, context.requestId)
        }

        const { title, scheduledDate } = parsed.data
        const { task } = await createTask(user.id, user.timezone, { title, scheduledDate })

        // ADR-04: { ok, data } — aiSource حذف شد (همیشه null بود؛ A5/A6)
        return okResponse({ task }, { status: 201, requestId: context.requestId })
    } catch (error) {
        recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}

// GET: تسک‌های یک روز + خلاصه + مشاور شروع (پیش‌فرض: امروز)
export async function GET(req: NextRequest) {
    const context = createObservabilityContext("/api/tasks")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        const dayKey = req.nextUrl.searchParams.get("dayKey") ?? getCanonicalToday(user.timezone)
        if (!isValidCanonicalDayKey(dayKey)) {
            return errorResponse(
                400,
                "VALIDATION_ERROR",
                "فرمت روز نامعتبر است",
                undefined,
                context.requestId,
            )
        }

        const { tasks, summary } = await getDayTasks(user.id, dayKey)

        // Advisor (Part 2/3) — «الان با چه کاری شروع کنم؟»: محاسبه‌ی خواندنی روی همان داده‌ها.
        // - ترتیب آرایه‌ی tasks عمداً دست‌نخورده می‌ماند (buildAdvisor ورودی را clone می‌کند،
        //   نه sort) — نمای روز نباید به‌خاطر مشاور جابه‌جا شود.
        // - اجرای امن: هر خطای غیرمنتظره‌ی advisor فقط ثبت ساختاریافته می‌شود؛ مسیر GET هرگز 500 نمی‌دهد.
        const displayName = user.firstName?.trim() || user.username
        let advisor: AdvisorResult | null = null
        try {
            advisor = buildAdvisor(tasks, {
                displayName,
                availableMinutes: summary.openBudgetMinutes,
            })
        } catch (error) {
            recordError(error, context, { category: "INTERNAL", severity: "WARNING" })
            advisor = null
        }

        // ADR-04: { ok, data: { tasks, summary, advisor } } — tasks با ترتیب اصلی سرویس
        return okResponse({ tasks, summary, advisor }, { requestId: context.requestId })
    } catch (error) {
        recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
