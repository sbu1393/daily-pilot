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
import { recordProductEvent } from "@/app/lib/services/productEvent.service"
import { reserveQuota, completeQuota, releaseQuota } from "@/app/lib/services/aiQuota.service"
import { markReleaseFailed } from "@/app/lib/services/aiUsage.service"
import { AiProviderUnavailableError, QuotaUnavailableError } from "@/app/lib/services/errors"
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
// context → auth → validation → rate limit → plan policy → quota reserve
// → AI call (خارج از هر transaction کووتا) → complete/release → response
// فاز ۳ — گام ۹ (بازنویسی placement): touch از pre-quota حذف شد؛ touch +
// ai.analysis_succeeded فقط بعد از verified production success (§17).

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

        const prisma = getPrisma()

        // فاز ۱ — plan policy (سند §5): سقف ماهانه فقط از سرویس؛ هرگز hard-code (§26)
        const policy = resolvePlanPolicy({ plan: user.plan })

        // فاز ۱ — period ماهانهٔ محلیِ کاربر (سند §۶): همان periodStart در reserve و complete/release
        const periodStart = getMonthlyPeriod(new Date(), user.timezone).periodStart

        // فاز ۱ — quota reserve (سند §8): اتمیک، idempotent بر اساس requestId، fail-closed.
        // P1-5 (سند §19/§20/§21/§32): شکست زیرساخت quota باید در observability ثبت شود؛
        // QUOTA_EXCEEDED/IDEMPOTENCY_CONFLICT خطای expected‌اند و هرگز record نمی‌شوند.
        try {
            await reserveQuota(prisma, {
                userId: user.id,
                requestId: context.requestId,
                allowedUnits: policy.allowedUnits,
                units: 1, // هر logical AI operation = 1 unit (سند §2)
                feature: "analyze",
                periodStart,
            })
        } catch (error) {
            // فقط QUOTA_UNAVAILABLE (infrastructure) و دقیقاً یک‌بار — سپس همان error دوباره throw می‌شود
            // تا response/envelope فعلی دست‌نخورده بماند (toServiceErrorResponse تغییر نمی‌کند).
            if (error instanceof QuotaUnavailableError) await recordError(error, context)
            throw error
        }

        let result: { task: unknown; aiSource: string }
        try {
            // AI call — خارج از transaction کووتا (سند §10)
            result = await reanalyzeTask(user.id, user.timezone, taskId, textOverride)
        } catch (error) {
            // سند §12/§13: هر شکست AI رزرو را آزاد می‌کند.
            // فاز ۱ — شکست نهایی provider یک رویداد عملیاتی است و باید failureCode بگیرد؛
            // خطاهای دیگر (مثل TASK_NOT_FOUND) مثل قبل و بدون failureCode آزاد می‌شوند.
            const providerFailure = error instanceof AiProviderUnavailableError ? error : null
            try {
                if (providerFailure) {
                    // failureCode = همان کد taxonomy که به کلاینت برمی‌گردد (سند §۱۲/§۲۰)
                    await releaseQuota(prisma, context.requestId, undefined, {
                        failureCode: providerFailure.code,
                        periodStart,
                    })
                } else {
                    await releaseQuota(prisma, context.requestId, undefined, { periodStart })
                }
            } catch {
                // سند §13: release failure → رزرو باقی می‌ماند، event در RESERVED می‌ماند،
                // provider دوباره صدا زده نمی‌شود، و failureCode=RELEASE_FAILED برای reconciliation
                // ثبت می‌شود (best-effort، هرگز throw نمی‌کند) + ثبت در observability (§21).
                await markReleaseFailed(prisma, context.requestId)
                await recordError(new QuotaUnavailableError(), context)
                throw new QuotaUnavailableError()
            }

            if (providerFailure) {
                // سند §12 مرحله ۶ / §21: شکست نهایی provider از pipeline observability عبور می‌کند.
                // outer catch برای ServiceErrorها خودش recordError نمی‌کند → دقیقاً یک رکورد (§18 فاز ۲).
                await recordError(providerFailure, context)
            }
            throw error
        }

        // موفقیت → complete (سند §11) — روی همان periodStart رزرو
        // P1-5 (سند §21/§32): شکست complete یک infrastructure failure است → ثبت دقیقاً یک‌بار.
        try {
            await completeQuota(prisma, context.requestId, undefined, { periodStart })
        } catch (error) {
            if (error instanceof QuotaUnavailableError) await recordError(error, context)
            throw error
        }

        // فاز ۳ — گام ۹: verified production success فقط اینجا است (بعد از complete موفق).
        // Mock هرگز production success نیست: بدون touch و بدون event (§8).
        if (result.aiSource !== "mock") {
            try {
                await touchAuthenticatedActivity(user.id, new Date(), prisma)
                await recordProductEvent(
                    user.id,
                    "ai.analysis_succeeded",
                    // فقط allowlist گام ۳ — هرگز prompt/response/provider payload/user content (§8)
                    { units: 1, aiSource: result.aiSource, status: "success" },
                    {
                        requestId: context.requestId,
                        endpoint: "/api/tasks/[id]/analyze",
                        feature: "analyze",
                    },
                )
            } catch {
                // fail-open — analytics failure هرگز پاسخ را fail نمی‌کند (§17)
            }
        }

        // ADR-04: { ok, data: { task, aiSource } } — summary حذف شد (A3/A6)
        return okResponse({ task: result.task, aiSource: result.aiSource }, { requestId: context.requestId })
    } catch (error) {
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        await recordError(error, context)
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
