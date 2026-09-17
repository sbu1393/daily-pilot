import { NextRequest } from "next/server"
import { requireAdmin } from "@/app/lib/requireAdmin"
import { searchUsers } from "@/app/lib/services/admin.query"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
} from "@/app/lib/apiResponse"

// فاز ۴ — Step 6: GET /api/admin/users — user list + search (§10/§14)
// auth(ADMIN) → validate params → admin.service (bounded) → safe envelope. فقط read.

export async function GET(req: NextRequest) {
    const context = createObservabilityContext("/api/admin/users", "admin")
    try {
        const admin = await requireAdmin()
        context.userId = admin.id

        const sp = req.nextUrl.searchParams
        const page = Number(sp.get("page") ?? undefined)
        const limit = Number(sp.get("limit") ?? undefined)
        const plan = sp.get("plan")
        const role = sp.get("role")
        const sort = sp.get("sort")

        const result = await searchUsers({
            q: sp.get("q") ?? undefined,
            plan: plan === "FREE" || plan === "PRO" ? plan : undefined,
            role: role === "USER" || role === "ADMIN" ? role : undefined,
            page: Number.isFinite(page) ? page : undefined,
            limit: Number.isFinite(limit) ? limit : undefined,
            sort: sort === "id_asc" || sort === "id_desc" ? sort : "id_desc",
        })

        return okResponse(
            {
                items: result.users,
                page: result.page,
                limit: result.pageSize,
                total: result.total,
                hasMore: result.page * result.pageSize < result.total,
            },
            { requestId: context.requestId },
        )
    } catch (error) {
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        recordError(error, context)
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
