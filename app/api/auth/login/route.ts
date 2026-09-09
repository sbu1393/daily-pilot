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

        const body = await req.json()

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