import { okMessageResponse } from "@/app/lib/apiResponse"
import { createObservabilityContext } from "@/src/lib/observability/context"

// POST /api/auth/logout → حذف کوکی سشن
export async function POST() {
    const context = createObservabilityContext("/api/auth/logout", "auth")
    const response = okMessageResponse("خروج انجام شد", 200, context.requestId)

    response.cookies.set("token", "", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 0,
        path: "/",
    })

    return response
}