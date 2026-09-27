// یادآورها — تریگر زمان‌بندی‌شده (Vercel Cron / هر زمان‌بند بیرونی)
//
// امنیت (مهم‌ترین بخش این route):
// - این مسیر **هیچ نشستی** ندارد، پس تنها محافظش رازِ مشترک است: هدر
//   `Authorization: Bearer $CRON_SECRET`. Vercel Cron وقتی متغیر CRON_SECRET
//   تنظیم باشد همین هدر را خودکار می‌فرستد.
// - عمداً به هدر `x-vercel-cron` به‌تنهایی اعتماد **نمی‌شود**: آن هدر یک
//   claim قابل جعل توسط هر کلاینتی است و اگر مبنای احراز هویت باشد، هر کسی
//   می‌تواند این مسیر را صدا بزند و برای همه‌ی کاربران Push اسپم بفرستد.
//   این هدر فقط به‌عنوان نشانه‌ی منبع در پاسخ echo می‌شود (اطلاعاتی، نه امنیتی).
// - اگر CRON_SECRET روی سرور تنظیم نشده باشد → 503 (fail-closed)، نه اجرای آزاد.
// - مقایسه‌ی راز به‌صورت constant-time (hash + timingSafeEqual) انجام می‌شود.
//
// این route هیچ ورودی‌ای از کلاینت نمی‌پذیرد: زمان، کاربران و payload همه
// سمت سرور تعیین می‌شوند. خروجی فقط شمارنده‌های تجمیعی است (بدون userId/ایمیل).

import { NextRequest } from "next/server"

import { createHash, timingSafeEqual } from "node:crypto"

import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
} from "@/app/lib/apiResponse"
import { CRON_ENV, readCronSecret } from "@/app/lib/cron/config"
import { CronNotConfiguredError } from "@/app/lib/services/errors"
import { runReminderCron } from "@/app/lib/services/reminderCron.service"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

// web-push + node:crypto → اجرای Node (نه Edge)
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** مقایسه‌ی constant-time روی هش (طول ثابت) — بدون نشت زمان. */
function secretMatches(provided: string, expected: string): boolean {
    const a = createHash("sha256").update(provided).digest()
    const b = createHash("sha256").update(expected).digest()
    return timingSafeEqual(a, b)
}

function bearerToken(req: NextRequest): string | null {
    const header = req.headers.get("authorization")
    if (!header) return null

    const [scheme, token] = header.split(" ")
    if (scheme?.toLowerCase() !== "bearer" || !token) return null

    return token
}

async function handle(req: NextRequest) {
    const context = createObservabilityContext("/api/cron/reminders", "notifications")
    try {
        const secret = readCronSecret()

        if (!secret) throw new CronNotConfiguredError()

        const token = bearerToken(req)
        if (!token || !secretMatches(token, secret)) {
            return unauthorizedResponse(context.requestId)
        }

        const summary = await runReminderCron(new Date())

        return okResponse(
            {
                ...summary,
                trigger: req.headers.get(CRON_ENV.vercelHeader) ? "vercel-cron" : "external",
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

/** Vercel Cron با GET صدا می‌زند. */
export async function GET(req: NextRequest) {
    return handle(req)
}

/** زمان‌بندهای دیگر (یا اجرای دستی) می‌توانند POST بزنند. */
export async function POST(req: NextRequest) {
    return handle(req)
}
