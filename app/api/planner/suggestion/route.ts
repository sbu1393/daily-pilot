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

// ADR-006 (Phase S2) — GET /api/planner/suggestion?date=YYYY-MM-DD
// فقط خواندنی: هیچ mutation، هیچ persist، هیچ AI (موتور pure suggestDay).
// date اختیاری است؛ پیش‌فرض «امروزِ» کاربر بر اساس timezone سرور-محور (§6.2.2.1).
export async function GET(req: NextRequest) {
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse()

        const dateParam = req.nextUrl.searchParams.get("date")
        const dayKey = dateParam ?? getCanonicalToday(user.timezone)

        // Phase 2A (M10): اعتبارسنجی سخت‌گیرانه‌ی مشترک — قالب + تقویم واقعی،
        // یکسان با /api/planner/day و /api/planner/history
        if (!isValidCanonicalDayKey(dayKey)) {
            return errorResponse(400, "VALIDATION_ERROR", "فرمت روز نامعتبر است")
        }

        // A1 Phase 1 — پاسخ شامل basis (planVersion/rebalancedVersion/availableMinutes/taskCount)
        // و state ("fresh" | "stale") است؛ route عمداً thin می‌ماند و آن‌ها را عبور می‌دهد (ADR-02).
        const suggestion = await getDaySuggestion(user.id, dayKey)

        // ADR-04: { ok, data: suggestion }
        return okResponse(suggestion)
    } catch (error) {
        const mapped = toServiceErrorResponse(error)
        if (mapped) return mapped
        console.error("GET DAY SUGGESTION ERROR:", error)
        return errorResponse(500, "INTERNAL", "Server error")
    }
}
