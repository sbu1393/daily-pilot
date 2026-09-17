import { NextRequest, NextResponse } from "next/server"
import { createSession } from "@/app/lib/createSession"
import { loginSchema } from "@/app/schema/formSchema"
import { isRateLimited, clientIp } from "@/app/lib/rateLimit"
import { authenticate } from "@/app/lib/services/auth.service"
import {
    errorResponse,
    toServiceErrorResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { getPrisma } from "@/app/lib/getPrisma"
import { touchAuthenticatedActivity } from "@/app/lib/services/userActivity.service"
import { recordProductEvent } from "@/app/lib/services/productEvent.service"

export async function POST(req: NextRequest) {
    try {
        // محدودیت نرخ: به ازای IP (قبل از خواندن بدنه) و به ازای ایمیل (بعد از اعتبارسنجی)
        if (isRateLimited(`login:ip:${clientIp(req)}`)) {
            return errorResponse(
                429,
                "RATE_LIMITED",
                "تلاش‌های زیادی انجام شده؛ کمی بعد دوباره تلاش کن",
            )
        }

        // M3: بدنه‌ی نامعتبر/غیر-JSON نباید ۵۰۰ بسازد → همان ۴۰۰ استاندارد ADR-04
        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
        if (!body) return validationErrorResponse(undefined)

        const validation = loginSchema.safeParse(body)

        if (!validation.success) {
            return validationErrorResponse(validation.error.flatten())
        }

        const { email, password } = validation.data

        if (isRateLimited(`login:email:${email}`, 5)) {
            return errorResponse(
                429,
                "RATE_LIMITED",
                "تلاش‌های زیادی برای این حساب انجام شده؛ کمی بعد دوباره تلاش کن",
            )
        }

        const user = await authenticate(email, password)

        // فاز ۳ — گام ۷: auth.login_succeeded فقط بعد از موفقیت واقعی authentication،
        // قبل از ساخت session (مرز موفقیت auth)؛ خارج از business transaction؛
        // fail-open — هرگز نتیجه‌ی login را تغییر نمی‌دهد (سند §17).
        try {
            const context = createObservabilityContext("/api/auth/login", "auth")
            context.userId = user.id
            const prisma = getPrisma()
            await touchAuthenticatedActivity(user.id, new Date(), prisma)
            await recordProductEvent(
                user.id,
                "auth.login_succeeded",
                undefined, // بدون properties (§8)
                { requestId: context.requestId, endpoint: "/api/auth/login", feature: "auth" },
            )
        } catch {
            // fail-open — analytics failure هرگز login را fail نمی‌کند
        }

        const response = NextResponse.json(
            {
                ok: true,
                data: {
                    user: {
                        id: user.id,
                        username: user.username,
                        email: user.email,
                    },
                },
            },
            { status: 200 },
        )

        return createSession(user, response)
    } catch (error) {
        const mapped = toServiceErrorResponse(error)
        if (mapped) return mapped
        console.error("LOGIN ERROR:", error)
        return errorResponse(500, "INTERNAL", "خطای سرور")
    }
}