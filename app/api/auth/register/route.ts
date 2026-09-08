import { NextRequest, NextResponse } from "next/server"
import { createSession } from "@/app/lib/createSession"
import { registerSchema } from "@/app/schema/formSchema"
import { isRateLimited, clientIp } from "@/app/lib/rateLimit"
import { registerUser } from "@/app/lib/services/auth.service"
import {
    errorResponse,
    toServiceErrorResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"

export async function POST(req: NextRequest) {
    try {
        // محدودیت نرخ: حداکثر چند ثبت‌نام از یک IP در یک بازه
        if (isRateLimited(`register:ip:${clientIp(req)}`, 5, 60 * 60 * 1000)) {
            return errorResponse(
                429,
                "RATE_LIMITED",
                "تعداد ثبت‌نام‌ها زیاد شده؛ کمی بعد دوباره تلاش کن",
            )
        }

        const body = await req.json()

        const validation = registerSchema.safeParse(body)
        if (!validation.success) {
            return validationErrorResponse(validation.error.flatten())
        }

        const { username, email, password } = validation.data

        const user = await registerUser({ username, email, password })

        const response = NextResponse.json(
            {
                ok: true,
                data: {
                    user: {
                        id: user.id,
                        email: user.email,
                    },
                },
            },
            { status: 201 },
        )

        return createSession(user, response)
    } catch (error) {
        const mapped = toServiceErrorResponse(error)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL_ERROR", "خطای سرور")
    }
}