// اعلان‌های زمان‌بندی‌شده‌ی تسک‌ها — تریگر Vercel Cron
//
// امنیت:
// - این مسیر نشست ندارد؛ تنها محافظش `Authorization: Bearer $CRON_SECRET` است.
//   Vercel Cron وقتی `CRON_SECRET` تنظیم باشد همین هدر را خودکار می‌فرستد.
// - به هدر `x-vercel-cron` به‌تنهایی اعتماد نمی‌شود (قابل جعل است)؛ فقط برای
//   گزارش منبع در پاسخ استفاده می‌شود.
// - نبودِ `CRON_SECRET` → 503 (fail-closed)، نه اجرای آزاد.
//
// نوع اجرا از `?type=morning|night|overdue` خوانده می‌شود. اگر query param
// موجود نباشد (مثلاً زمانی که چند cron هم‌مسیر باشند)، از هدر
// `x-vercel-cron-schedule` نگاشت می‌شود.
//
// این مسیر هیچ ورودی‌ای از کلاینت نمی‌پذیرد: کاربران، تسک‌ها و متن پیام‌ها
// همه سمت سرور تعیین می‌شوند. خروجی فقط شمارنده‌های تجمیعی است.

import { NextRequest } from "next/server"

import { createHash, timingSafeEqual } from "node:crypto"

import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"
import { CRON_ENV, readCronSecret } from "@/app/lib/cron/config"
import { CronNotConfiguredError } from "@/app/lib/services/errors"
import {
    isTaskDigestKind,
    runTaskDigestCron,
    type TaskDigestKind,
} from "@/app/lib/services/taskDigestCron.service"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

// web-push + node:crypto → اجرای Node (نه Edge)
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** نگاشت زمان‌بندی‌های vercel.json → نوع اعلان (fallback وقتی query param نیست). */
const KIND_BY_SCHEDULE: Record<string, TaskDigestKind> = {
    // 08:00 / 22:00 / 09:00 تهران (UTC+3:30)
    "30 4 * * *": "morning",
    "30 18 * * *": "night",
    "30 5 * * *": "overdue",
    // مقادیر قبلی (UTC) — برای سازگاری در طول rollout
    "0 8 * * *": "morning",
    "0 22 * * *": "night",
    "0 9 * * *": "overdue",
}

/** مقایسه‌ی constant-time روی هش (طول ثابت) — بدون نشت زمان. */
function secretMatches(provided: string, expected: string): boolean {
    const a = createHash("sha256").update(provided).digest()
    const b = createHash("sha256").update(expected).digest()
    return timingSafeEqual(a, b)
}

/**
 * فقط قالب دقیق `Authorization: Bearer <CRON_SECRET>` پذیرفته می‌شود.
 * - نام scheme دقیقاً `Bearer` است (حساس به حروف).
 * - توکن نباید فاصله داشته باشد؛ هدرهای چندبخشی رد می‌شوند.
 */
function bearerToken(req: NextRequest): string | null {
    const header = req.headers.get("authorization")
    if (!header) return null

    const prefix = "Bearer "
    if (!header.startsWith(prefix)) return null

    const token = header.slice(prefix.length)
    if (token === "" || /\s/.test(token)) return null

    return token
}

function resolveKind(req: NextRequest): TaskDigestKind | null {
    const fromQuery = req.nextUrl.searchParams.get("type")
    if (isTaskDigestKind(fromQuery)) return fromQuery
    if (fromQuery !== null) return null

    const schedule = req.headers.get("x-vercel-cron-schedule")?.trim()
    return schedule ? KIND_BY_SCHEDULE[schedule] ?? null : null
}

async function handle(req: NextRequest) {
    const context = createObservabilityContext("/api/notifications/cron", "notifications")
    try {
        const secret = readCronSecret()

        if (!secret) throw new CronNotConfiguredError()

        const token = bearerToken(req)
        if (!token || !secretMatches(token, secret)) {
            return unauthorizedResponse(context.requestId)
        }

        const kind = resolveKind(req)
        if (!kind) {
            return validationErrorResponse(
                { type: "expected one of: morning, night, overdue" },
                "نوع اعلان نامعتبر است",
                context.requestId,
            )
        }

        const summary = await runTaskDigestCron(kind, new Date())

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
