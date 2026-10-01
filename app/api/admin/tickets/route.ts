import { NextRequest } from "next/server"
import { requireAdmin } from "@/app/lib/requireAdmin"
import { listTickets } from "@/app/lib/services/ticket.service"
import { ticketListQuerySchema } from "@/app/schema/ticketSchema"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"

/*
 * T4 — GET /api/admin/tickets — صف پشتیبانی
 * ---------------------------------------------------------------
 * الگوی دقیق `app/api/admin/users/route.ts`: `requireAdmin` → validate params →
 * سرویس → envelope امن.
 *
 * تفاوت عمدی با آن فایل: به‌جای `Number(sp.get(...))` + `Number.isFinite`، از
 * `ticketListQuerySchema` فاز T2 استفاده می‌شود، چون T2 همین قرارداد را
 * (پیشفرض ۱/۲۰، سقف ۱۰۰، خطای ۴۰۰ برای ورودی بد) به‌صورت reusable تعریف کرده
 * است و بازنویسیِ موازی‌اش در route ممنوع است.
 *
 * scope داده در سرویس است: staff همهٔ تیکت‌ها را می‌بیند (بدون فیلتر userId).
 */

export async function GET(req: NextRequest) {
    const context = createObservabilityContext("/api/admin/tickets", "admin")
    try {
        const admin = await requireAdmin()
        context.userId = admin.id

        const parsed = ticketListQuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams))
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten(), undefined, context.requestId)
        }

        const result = await listTickets({ id: admin.id, role: admin.role }, parsed.data)

        return okResponse(
            {
                items: result.items,
                page: result.page,
                limit: result.limit,
                total: result.total,
                hasMore: result.hasMore,
            },
            { requestId: context.requestId },
        )
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
