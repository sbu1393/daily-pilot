import { NextRequest } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { getPrisma } from "@/app/lib/getPrisma"
import { isRateLimited } from "@/app/lib/rateLimit"
import { reanalyzeTask } from "@/app/lib/services/tasks.service"
import { reanalyzeTaskSchema } from "@/app/schema/plannerSchema"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import { resolvePlanPolicy, getMonthlyPeriod } from "@/app/lib/services/planPolicy.service"
import { touchAuthenticatedActivity } from "@/app/lib/services/userActivity.service"
import { reserveQuota, completeQuota, releaseQuota } from "@/app/lib/services/aiQuota.service"
import { QuotaUnavailableError } from "@/app/lib/services/errors"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"

// این route هوش مصنوعی را صدا می‌زند؛ روی Vercel وقت بیشتری لازم دارد (روی self-host بی‌اثر است)
export const maxDuration = 60

// فاز ۱ — ترتیب LOCKED سند §23:
// context → auth → validation → rate limit → user activity → plan policy → quota reserve
// → AI call (خارج از هر transaction کووتا) → complete/release → response

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    const context = createObservabilityContext("/api/tasks/[id]/analyze", "analyze")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        const { id } = await params
        const taskId = Number(id)
        if (!Number.isInteger(taskId) || taskId <= 0) {
            return errorResponse(400, "VALIDATION_ERROR", "شناسه نامعتبر است", undefined, context.requestId)
        }

        const body = (await req.json().catch(() => null)) as unknown
        const parsed = reanalyzeTaskSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten(), undefined, context.requestId)
        }
        const { text: textOverride } = parsed.data

        const limited = isRateLimited(
            `analyze:user:${user.id}`,
            5,
            15 * 60 * 1000,
        )
        if (limited) {
            return errorResponse(
                429,
                "RATE_LIMITED",
                "تعداد درخواست‌های هوش مصنوعی زیاد شده؛ کمی بعد دوباره تلاش کن",
                undefined,
                context.requestId,
            )
        }

        // فاز ۱ — ثبت فعالیت (throttle 30 دقیقه) — بعد از rate limit، قبل از plan/quota (سند §17)
        // Fail-safe: خطای داخلی هرگز مسیر اصلی نمی‌شکند.
        const prisma = getPrisma()
        await touchAuthenticatedActivity(user.id, new Date(), prisma)

        // فاز ۱ — plan policy (سند §5): سقف ماهانه فقط از سرویس؛ هرگز hard-code (§26)
        const policy = resolvePlanPolicy({ plan: user.plan })

        // فاز ۱ — quota reserve (سند §8): اتمیک، idempotent بر اساس requestId، fail-closed
        await reserveQuota(prisma, {
            userId: user.id,
            requestId: context.requestId,
            allowedUnits: policy.allowedUnits,
            units: 1, // هر logical AI operation = 1 unit (سند §2)
            feature: "analyze",
            periodStart: getMonthlyPeriod(new Date()).periodStart,
        })

        let result: { task: unknown; aiSource: string }
        try {
            // AI call — خارج از transaction کووتا (سند §10)
            result = await reanalyzeTask(user.id, user.timezone, taskId, textOverride)
        } catch (error) {
            // شکست نهایی provider → release → خطای اصلی به مپینگ استاندارد (سند §12)
            await releaseQuota(prisma, context.requestId).catch(() => {
                // سند §13: release failure → fail-closed QUOTA_UNAVAILABLE
                throw new QuotaUnavailableError()
            })
            throw error
        }

        // موفقیت → complete (سند §11)
        await completeQuota(prisma, context.requestId)

        // ADR-04: { ok, data: { task, aiSource } } — summary حذف شد (A3/A6)
        return okResponse({ task: result.task, aiSource: result.aiSource }, { requestId: context.requestId })
    } catch (error) {
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        recordError(error, context)
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
