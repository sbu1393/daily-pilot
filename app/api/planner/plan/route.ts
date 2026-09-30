import { NextRequest } from "next/server"
import { requireVerifiedUser } from "@/app/lib/requireVerifiedUser"
import { getPrisma } from "@/app/lib/getPrisma"
import { isRateLimited } from "@/app/lib/rateLimit"
import { getCanonicalToday } from "@/app/lib/canonicalDay"
import { planRequestSchema, planProposalSchema } from "@/app/schema/plannerSchema"
import { getPlanGenerationContext } from "@/app/lib/services/plan.service"
import { analyzeBatchPlan } from "@/app/lib/ai/analyzeBatchPlan"
import { validateBatchPlan } from "@/app/lib/ai/planContract"
import { buildPlanProposal } from "@/app/lib/planner/planProposal"
import { runAiOperation } from "@/app/lib/services/aiOperation.service"
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
        const user = await requireVerifiedUser()
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
        // ── lifecycle کامل quota در یک نقطه ──────────────────────────────────
        // `runAiOperation` تنها entry point مجاز است: خودش LEGACY/V2 را انتخاب
        // می‌کند و reserve → execute → complete/release را اداره می‌کند.
        //
        // چرا `execute` این‌جا بزرگ است: هر چیزی که **بعد** از AI و **قبل** از
        // complete می‌افتد باید رزرو را آزاد کند، و این‌ها عمداً داخل همان پنجرهٔ
        // رزرو هستند:
        //   • validateBatchPlan → AiPlanInvalidError
        //   • گارد producer/consumer (planProposalSchema)
        // بیرون‌کشیدنشان از `execute` باعث می‌شد آن خطاها **بعد از complete** رخ
        // دهند، یعنی سهمیه‌ای که باید آزاد می‌شد مصرف می‌شد.
        //
        // ترتیب: reserve **قبل** از `analyzeBatchPlan` ⇒ هیچ provider call بدون
        // reservation انجام نمی‌شود.
        //
        // failureCode این route با analyze فرق دارد: علاوه بر شکست provider،
        // شکست اعتبارسنجیِ خروجی AI هم `AI_PLAN_INVALID` ثبت می‌شود (AI پاسخ داده
        // ولی خروجی‌اش قابل استفاده نبوده). قاعده در خودِ سرویس متمرکز می‌ماند.
        const { result: proposal } = await runAiOperation({
            prisma,
            user,
            feature: "plan",
            requestId: context.requestId,
            releaseFailureCode: (error) => {
                if (error instanceof AiProviderUnavailableError) return error.code
                if (error instanceof AiPlanInvalidError) return error.code
                return undefined
            },
            execute: async () => {
                const aiResult = await analyzeBatchPlan(planContext.input)

                // provider/fallback واقعی ثبت می‌شوند (پیش از این wiring هرگز ثبت
                // نمی‌شدند). `model` عمداً خالی است: لایهٔ AI آن را برنمی‌گرداند.
                const provider = aiResult.aiProvider
                    ? { provider: aiResult.aiProvider, fallbackUsed: aiResult.fallbackUsed }
                    : undefined

                // اعتبارسنجی نسبی: هر taskId برگشتی باید در ورودی باشد و همهٔ کارها پوشش داده شوند
                const issues = validateBatchPlan(
                    aiResult.plan,
                    planContext.input.tasks.map((task) => task.taskId),
                )
                if (issues.length > 0) throw new AiPlanInvalidError()

                // proposal گذرا — فقط scheduler قطعی می‌سازد؛ هیچ persist/mutation
                const built = buildPlanProposal({
                    dayKey,
                    planVersion: planContext.planVersion,
                    rebalancedVersion: planContext.rebalancedVersion,
                    availableMinutes: planContext.availableMinutes,
                    source: aiResult.source,
                    ai: aiResult.plan,
                    tasks: planContext.suggestionTasks,
                })

                // ── گاردِ قرارداد producer/consumer ───────────────────────────────
                // خروجی buildPlanProposal باید دقیقاً همان schema canonicalِی را پاس
                // کند که planApplyRequestSchema در فاز Apply اعمال می‌کند. بدون این
                // گارد، producer می‌تواند proposal‌ای بسازد که **خودِ سیستم** چند
                // دقیقه بعد آن را با VALIDATION_ERROR رد می‌کند (کلاسِ bugِ «Apply روی
                // پیشنهادِ معتبر رد می‌شود»). ناهماهنگی باید همین‌جا کشف شود.
                //
                // یک **عیب داخلی** است، نه ورودی نامعتبر کاربر: پیام دامنه‌ای
                // نمی‌گیرد و از مسیر عمومیِ catch (500 INTERNAL + recordError) عبور
                // می‌کند — جزئیات Zod فقط در لاگ سمت سرور می‌ماند.
                //
                // ZodErrorServiceError نیست ⇒ `releaseFailureCode` برایش `undefined`
                // می‌دهد، یعنی release بدون failureCode — عیناً رفتار پیشین.
                const validated = planProposalSchema.safeParse(built)
                if (!validated.success) throw validated.error

                return { result: built, telemetry: aiResult.aiTelemetry, provider }
            },
        }).catch(async (error: unknown) => {
            // رزرو آزاد شده (یا اگر آزاد نشد، 503 با markReleaseFailed آمده).
            // اینجا فقط ثبت observabilityِ همان خطاهایی است که پیش از این wiring
            // صریحاً record می‌شدند: شکست provider و خروجی نامعتبر AI. بقیهٔ خطاها
            // (از جمله ZodError) از outer catch عبور می‌کنند و آنجا یک‌بار ثبت
            // می‌شوند — پس جمعِ recordها دقیقاً یکی می‌ماند.
            if (
                error instanceof AiProviderUnavailableError ||
                error instanceof AiPlanInvalidError ||
                error instanceof QuotaUnavailableError
            ) {
                await recordError(error, context)
            }
            throw error
        })

        // ADR-04: { ok, data: proposal }
        return okResponse(proposal, { requestId: context.requestId })
    } catch (error) {
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        await recordError(error, context)
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
