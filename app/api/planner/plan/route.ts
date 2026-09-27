import { NextRequest } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { getPrisma } from "@/app/lib/getPrisma"
import { isRateLimited } from "@/app/lib/rateLimit"
import { getCanonicalToday } from "@/app/lib/canonicalDay"
import { planRequestSchema } from "@/app/schema/plannerSchema"
import { getPlanGenerationContext } from "@/app/lib/services/plan.service"
import { analyzeBatchPlan } from "@/app/lib/ai/analyzeBatchPlan"
import { validateBatchPlan, type PlanAnalysisResult } from "@/app/lib/ai/planContract"
import { buildPlanProposal } from "@/app/lib/planner/planProposal"
import {
    getMonthlyPeriod,
    resolveFeatureUnits,
    resolvePlanPolicy,
} from "@/app/lib/services/planPolicy.service"
import { reserveQuota, completeQuota, releaseQuota } from "@/app/lib/services/aiQuota.service"
import { markReleaseFailed } from "@/app/lib/services/aiUsage.service"
import {
    AiPlanInvalidError,
    AiProviderUnavailableError,
    QuotaUnavailableError,
} from "@/app/lib/services/errors"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
    validationErrorResponse,
} from "@/app/lib/apiResponse"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

// این route AI را صدا می‌زند؛ روی Vercel وقت بیشتری لازم دارد (روی self-host بی‌اثر است)
export const maxDuration = 60

// Phase 2 — POST /api/planner/plan: تولید یک proposal گذرا (ephemeral) از AI batch.
//
// ترتیب LOCKED (سند فاز ۲ §۷):
//   auth → parse → rate limit → load user/day/tasks → plan policy → reserve quota
//   → AI call (خارج از transaction کووتا) → validate → build proposal → complete → response
//
// قراردادها:
// - request فقط dayKey (اختیاری) می‌گیرد؛ هیچ task/availableMinutes ای از Client نمی‌پذیرد.
// - proposal هرگز persist نمی‌شود: نه DailyPlan، نه Task allocation، نه rollover/reminder.
// - فقط scheduler قطعی سیستم (suggestDay از طریق buildPlanProposal) allocation را می‌سازد.
export async function POST(req: NextRequest) {
    const context = createObservabilityContext("/api/planner/plan", "planner")
    try {
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        // req.json() نامعتبر/غایب → null → schema رد می‌کند (invalid request)
        const body = (await req.json().catch(() => null)) as unknown
        const parsed = planRequestSchema.safeParse(body)
        if (!parsed.success) {
            return validationErrorResponse(parsed.error.flatten(), undefined, context.requestId)
        }

        const dayKey = parsed.data.dayKey ?? getCanonicalToday(user.timezone)

        // rate limit جدا برای این feature — همان convention پروژه (analyze: 5/15min)
        const limited = isRateLimited(`plan:user:${user.id}`, 5, 15 * 60 * 1000)
        if (limited) {
            return errorResponse(
                429,
                "RATE_LIMITED",
                "تعداد درخواست‌های ایجاد برنامه زیاد شده؛ کمی بعد دوباره تلاش کن",
                undefined,
                context.requestId,
            )
        }

        // فقط-خواندنی: plan + کارهای بازِ همان کاربر/همان روز (بدون mutation/rebalance).
        // نبود plan/ظرفیت → DayPlanNotSetError؛ نبود کار باز → NoPlannableTasksError (قبل از مصرف quota).
        const planContext = await getPlanGenerationContext(user.id, dayKey)

        const prisma = getPrisma()

        // plan policy (سقف ماهانه فقط از سرویس) + period محلی کاربر
        const policy = resolvePlanPolicy({ plan: user.plan })
        const periodStart = getMonthlyPeriod(new Date(), user.timezone).periodStart
        // feature="plan": یک تولید کامل پلن = یک عملیات منطقی = ۱ unit (نه per-task)
        const units = resolveFeatureUnits("plan")

        // quota reserve — اتمیک/idempotent/fail-closed (سند فاز ۱ §۸)
        try {
            await reserveQuota(prisma, {
                userId: user.id,
                requestId: context.requestId,
                allowedUnits: policy.allowedUnits,
                units,
                feature: "plan",
                periodStart,
            })
        } catch (error) {
            if (error instanceof QuotaUnavailableError) await recordError(error, context)
            throw error
        }

        // AI call — خارج از هر transaction کووتا (سند فاز ۱ §۱۰)
        let aiResult: PlanAnalysisResult
        try {
            aiResult = await analyzeBatchPlan(planContext.input)
        } catch (error) {
            // شکست AI → آزادسازی رزرو با همان semantics فعلی (failureCode برای شکست provider)
            const providerFailure = error instanceof AiProviderUnavailableError ? error : null
            try {
                if (providerFailure) {
                    await releaseQuota(prisma, context.requestId, undefined, {
                        failureCode: providerFailure.code,
                        periodStart,
                    })
                } else {
                    await releaseQuota(prisma, context.requestId, undefined, { periodStart })
                }
            } catch {
                // release failure → رزرو باقی می‌ماند، event در RESERVED علامت می‌خورد، fail-closed
                await markReleaseFailed(prisma, context.requestId)
                await recordError(new QuotaUnavailableError(), context)
                throw new QuotaUnavailableError()
            }
            if (providerFailure) await recordError(providerFailure, context)
            throw error
        }

        // اعتبارسنجی نسبی: هر taskId برگشتی باید در ورودی باشد و همهٔ کارها پوشش داده شوند
        const issues = validateBatchPlan(
            aiResult.plan,
            planContext.input.tasks.map((task) => task.taskId),
        )
        if (issues.length > 0) {
            const invalid = new AiPlanInvalidError()
            try {
                await releaseQuota(prisma, context.requestId, undefined, {
                    failureCode: invalid.code,
                    periodStart,
                })
            } catch {
                await markReleaseFailed(prisma, context.requestId)
                await recordError(new QuotaUnavailableError(), context)
                throw new QuotaUnavailableError()
            }
            await recordError(invalid, context)
            throw invalid
        }

        // proposal گذرا — فقط scheduler قطعی می‌سازد؛ هیچ persist/mutation
        const proposal = buildPlanProposal({
            dayKey,
            planVersion: planContext.planVersion,
            rebalancedVersion: planContext.rebalancedVersion,
            availableMinutes: planContext.availableMinutes,
            source: aiResult.source,
            ai: aiResult.plan,
            tasks: planContext.suggestionTasks,
        })

        // موفقیت → complete روی همان periodStart رزرو
        try {
            await completeQuota(prisma, context.requestId, undefined, { periodStart })
        } catch (error) {
            if (error instanceof QuotaUnavailableError) await recordError(error, context)
            throw error
        }

        // ADR-04: { ok, data: proposal }
        return okResponse(proposal, { requestId: context.requestId })
    } catch (error) {
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        await recordError(error, context)
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
