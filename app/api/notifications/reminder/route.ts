// یادآورها — آینه‌کردن برنامه‌ی یادآور کاربر روی سرور
//
// چرا لازم است؟ تنظیمات یادآور در localStorage (دستگاه) است، ولی تریگر
// زمان‌بندی‌شده‌ی سرور باید بداند هر کاربر چه ساعتی را انتخاب کرده تا در زمان
// بسته بودن اپ هم Push بفرستد. این مسیر فقط همان دو فیلد را آینه می‌کند:
// `reminderEnabled` و `reminderTime` (به وقت محلی کاربر).
//
// مرزها:
// - کاربر همیشه از نشست (`getCurrentUser`) — هیچ userId از بدنه خوانده نمی‌شود.
// - `reminderTime` فقط "HH:MM" معتبر (regex)؛ مقدار آزاد هرگز ذخیره نمی‌شود.
// - این مسیر هیچ Push نمی‌فرستد و `reminderSentOn` را دست نمی‌زند
//   (ضد-تکرار روزانه فقط توسط cron بعد از ارسال موفق ست می‌شود).
// - وجود کلیدهای VAPID لازم **نیست**: کاربر باید بتواند انتخابش را ثبت کند
//   حتی وقتی Push روی سرور فعال نیست (پاسخ فقط آینه‌ی وضعیت ذخیره‌شده است).

import { NextRequest } from "next/server"

import { z } from "zod"

import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { getPrisma } from "@/app/lib/getPrisma"
import { isRateLimited } from "@/app/lib/rateLimit"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

const RATE_LIMIT_MAX = 60
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000

const reminderScheduleSchema = z.object({
    enabled: z.boolean(),
    time: z
        .string()
        .trim()
        .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "زمان باید در قالب HH:MM باشد"),
})

export async function POST(req: NextRequest) {
    const context = createObservabilityContext("/api/notifications/reminder", "notifications")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        if (isRateLimited(`push:reminder:user:${user.id}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS)) {
            return errorResponse(429, "RATE_LIMITED", "تعداد درخواست‌ها زیاد است؛ کمی بعد تلاش کن", undefined, context.requestId)
        }

        const body = await req.json().catch(() => ({}))
        const parsed = reminderScheduleSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten(), undefined, context.requestId)
        }

        const prisma = getPrisma()
        const updated = await prisma.user.update({
            where: { id: user.id },
            data: {
                reminderEnabled: parsed.data.enabled,
                reminderTime: parsed.data.time,
            },
            select: { reminderEnabled: true, reminderTime: true },
        })

        return okResponse(updated, { requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
