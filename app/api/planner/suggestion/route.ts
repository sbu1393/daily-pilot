import { NextRequest } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { getDaySuggestion } from "@/app/lib/services/planner.service"
import { getCanonicalToday, isValidCanonicalDayKey } from "@/app/lib/canonicalDay"
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

// ADR-006 (Phase S2) — GET /api/planner/suggestion?date=YYYY-MM-DD
// فقط خواندنی: هیچ mutation، هیچ persist، هیچ AI (موتور pure suggestDay).
// date اختیاری است؛ پیش‌فرض «امروزِ» کاربر بر اساس timezone سرور-محور (§6.2.2.1).
export async function GET(req: NextRequest) {
    const context = createObservabilityContext("/api/planner/suggestion", "planner")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        const dateParam = req.nextUrl.searchParams.get("date")
        const dayKey = dateParam ?? getCanonicalToday(user.timezone)

        // Phase 2A (M10): اعتبارسنجی سخت‌گیرانه‌ی مشترک — قالب + تقویم واقعی،
        // یکسان با /api/planner/day و /api/planner/history
        if (!isValidCanonicalDayKey(dayKey)) {
            return errorResponse(400, "VALIDATION_ERROR", "فرمت روز نامعتبر است", undefined, context.requestId)
        }

        // A1 Phase 1 — پاسخ شامل basis (planVersion/rebalancedVersion/availableMinutes/taskCount)
        // و state ("fresh" | "stale") است؛ route عمداً thin می‌ماند و آن‌ها را عبور می‌دهد (ADR-02).
        const suggestion = await getDaySuggestion(user.id, dayKey)

        // فاز ۳ — گام ۱۰: planner.suggestion_viewed فقط بعد از verified successful view؛
        // touch + event خارج از business operation؛ fail-open (§17). properties خالی (allowlist گام ۳).
        try {
            const prisma = getPrisma()
            await touchAuthenticatedActivity(user.id, new Date(), prisma)
            await recordProductEvent(
                user.id,
                "planner.suggestion_viewed",
                // allowlist گام ۳ این event خالی است — هیچ suggestion/task content (§8)
                undefined,
                { requestId: context.requestId, endpoint: "/api/planner/suggestion", feature: "planner" },
            )
        } catch {
            // fail-open — analytics failure هرگز پاسخ را fail نمی‌کند
        }

        // ADR-04: { ok, data: suggestion }
        return okResponse(suggestion, { requestId: context.requestId })
    } catch (error) {
        recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
