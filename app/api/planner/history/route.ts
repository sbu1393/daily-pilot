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

// GET /api/planner/history?from=2026-01-01&to=2026-01-31
// کلیدهای روز صفر-پد هستند (canonical میلادی) → مقایسه‌ی رشته‌ای from/to درسته
export async function GET(req: NextRequest) {
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse()

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
            return errorResponse(400, "VALIDATION_ERROR", "بازه‌ی نامعتبر")
        }

        const markers = await getHistoryMarkers(user.id, from, to)
        return okResponse(markers)
    } catch (error) {
        const mapped = toServiceErrorResponse(error)
        if (mapped) return mapped
        console.error("HISTORY ERROR:", error)
        return errorResponse(500, "INTERNAL", "Server error")
    }
}