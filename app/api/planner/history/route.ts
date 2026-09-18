import { NextRequest } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { getHistoryMarkers } from "@/app/lib/services/planner.service"
import { isValidCanonicalDayKey } from "@/app/lib/canonicalDay"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
} from "@/app/lib/apiResponse"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import { getPrisma } from "@/app/lib/getPrisma"
import { touchAuthenticatedActivity } from "@/app/lib/services/userActivity.service"
import { recordProductEvent } from "@/app/lib/services/productEvent.service"

// GET /api/planner/history?from=2026-01-01&to=2026-01-31
// کلیدهای روز صفر-پد هستند (canonical میلادی) → مقایسه‌ی رشته‌ای from/to درسته
export async function GET(req: NextRequest) {
    const context = createObservabilityContext("/api/planner/history", "planner")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        const from = req.nextUrl.searchParams.get("from")
        const to = req.nextUrl.searchParams.get("to")
        // M4/M10: هر دو سر بازه باید کلید canonical معتبر باشند (قالب + تقویم واقعی)
        // قبل از هر کوئری؛ مقایسه‌ی رشته‌ای from/to فقط روی کلیدهای صفر-پد معنا دارد.
        if (
            !from ||
            !to ||
            !isValidCanonicalDayKey(from) ||
            !isValidCanonicalDayKey(to) ||
            from > to
        ) {
            return errorResponse(400, "VALIDATION_ERROR", "بازه‌ی نامعتبر", undefined, context.requestId)
        }

        const markers = await getHistoryMarkers(user.id, from, to)

        // فاز ۳ — گام ۱۰: planner.history_viewed فقط بعد از verified successful view؛
        // touch + event خارج از business operation؛ fail-open (§17). properties خالی (allowlist گام ۳).
        try {
            const prisma = getPrisma()
            await touchAuthenticatedActivity(user.id, new Date(), prisma)
            await recordProductEvent(
                user.id,
                "planner.history_viewed",
                // allowlist گام ۳ این event خالی است — هیچ history/date-range/content (§8)
                undefined,
                { requestId: context.requestId, endpoint: "/api/planner/history", feature: "planner" },
            )
        } catch {
            // fail-open — analytics failure هرگز پاسخ را fail نمی‌کند
        }

        return okResponse(markers, { requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}