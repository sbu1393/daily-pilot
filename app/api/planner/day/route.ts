import { NextRequest, NextResponse } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { getDaySummary, setDayPlan } from "@/app/lib/services/planner.service"
import { getCanonicalToday, isValidCanonicalDayKey } from "@/app/lib/canonicalDay"
import { dayPlanSchema } from "@/app/schema/plannerSchema"
import {
    errorResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"

// GET: خلاصه‌ی روز (بودجه / تخصیص / وقت آزاد / سیو شده) — ADR-04: { ok, data: summary }
export async function GET(req: NextRequest) {
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse()

        const dayKey = req.nextUrl.searchParams.get("dayKey") ?? getCanonicalToday(user.timezone)
        // M10: اعتبارسنجی سخت‌گیرانه — قالب + تقویم (مثلاً «2026-13-99» یا «2026-02-30» رد می‌شوند)
        if (!isValidCanonicalDayKey(dayKey)) {
            return errorResponse(400, "VALIDATION_ERROR", "فرمت روز نامعتبر است")
        }

        const summary = await getDaySummary(user.id, dayKey)
        return NextResponse.json({ ok: true, data: summary }, { status: 200 })
    } catch (error) {
        const mapped = toServiceErrorResponse(error)
        if (mapped) return mapped
        console.error("GET DAY SUMMARY ERROR:", error)
        return errorResponse(500, "INTERNAL", "Server error")
    }
}

// POST: تنظیم/ویرایش بودجه‌ی روز — mutation مؤثر بر برنامه → bump (A3)
export async function POST(req: NextRequest) {
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse()

        const body = await req.json()
        const parsed = dayPlanSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten())
        }

        const { dayKey, availableMinutes } = parsed.data

        const { plan, summary } = await setDayPlan(user.id, dayKey, availableMinutes)

        return NextResponse.json({ ok: true, data: { plan, summary } }, { status: 200 })
    } catch (error) {
        const mapped = toServiceErrorResponse(error)
        if (mapped) return mapped
        console.error("SET DAY PLAN ERROR:", error)
        return errorResponse(500, "INTERNAL", "Server error")
    }
}