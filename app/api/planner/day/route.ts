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
import { createObservabilityContext } from "@/src/lib/observability/context"
import { getPrisma } from "@/app/lib/getPrisma"
import { touchAuthenticatedActivity } from "@/app/lib/services/userActivity.service"
import { recordProductEvent } from "@/app/lib/services/productEvent.service"

// GET: خلاصه‌ی روز (بودجه / تخصیص / وقت آزاد / سیو شده) — ADR-04: { ok, data: summary }
// فاز ۳ — گام ۱۰: planner.day_viewed فقط بعد از verified successful day view؛
// touch + event خارج از business operation؛ fail-open (§17). properties خالی (allowlist گام ۳).
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

        // فاز ۳ — گام ۱۰: analytics فقط بعد از verified success — خارج از business operation.
        try {
            const context = createObservabilityContext("/api/planner/day", "planner")
            context.userId = user.id
            const prisma = getPrisma()
            await touchAuthenticatedActivity(user.id, new Date(), prisma)
            await recordProductEvent(
                user.id,
                "planner.day_viewed",
                // allowlist گام ۳ این event خالی است — هیچ dayKey/تاریخ/timezone/content (§8)
                undefined,
                { requestId: context.requestId, endpoint: "/api/planner/day", feature: "planner" },
            )
        } catch {
            // fail-open — analytics failure هرگز پاسخ را fail نمی‌کند
        }

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