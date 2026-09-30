import { NextRequest } from "next/server"
import { requireVerifiedUser } from "@/app/lib/requireVerifiedUser"
import { getPrisma } from "@/app/lib/getPrisma"
import { isRateLimited } from "@/app/lib/rateLimit"
import { reanalyzeTask } from "@/app/lib/services/tasks.service"
import { type AiCallTelemetry } from "@/app/lib/ai/aiDuration"
import { reanalyzeTaskSchema } from "@/app/schema/plannerSchema"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import { touchAuthenticatedActivity } from "@/app/lib/services/userActivity.service"
import { recordProductEvent } from "@/app/lib/services/productEvent.service"
import { runAiOperation } from "@/app/lib/services/aiOperation.service"
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
        const user = await requireVerifiedUser()
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

        // ── lifecycle کامل quota در یک نقطه (سند §۸/§۱۰/§۱۱/§۱۲/§۱۳) ─────────────
        // `runAiOperation` تنها entry point مجاز است و خودش تصمیم می‌گیرد این دوره
        // LEGACY است یا V2 — پس route دیگر نه `resolvePlanPolicy` می‌خواند، نه
        // `getMonthlyPeriod`، نه reserve/complete/release را دستی صدا می‌زند.
        //
        // ترتیب قفل‌شده: reserve **قبل** از `reanalyzeTask` انجام می‌شود، پس هیچ
        // provider call بدون reservation رخ نمی‌دهد. unit و قاعدهٔ failureCode هم
        // از جدول بستهٔ فیچر می‌آید، نه از این route.
        let result: {
            task: unknown
            aiSource: string
            aiProvider?: string
            fallbackUsed?: boolean
            aiTelemetry?: AiCallTelemetry
        }
        try {
            const outcome = await runAiOperation({
                prisma,
                user,
                feature: "analyze",
                requestId: context.requestId,
                execute: async () => {
                    const analysis = await reanalyzeTask(
                        user.id,
                        user.timezone,
                        taskId,
                        textOverride,
                    )
                    return {
                        result: analysis,
                        telemetry: analysis.aiTelemetry,
                        // provider/fallback واقعی ثبت می‌شوند (پیش از این wiring
                        // هرگز ثبت نمی‌شدند و همیشه null می‌ماندند).
                        // `model` عمداً خالی است: لایهٔ AI آن را برنمی‌گرداند و
                        // `AI_MODEL` مدلِ provider اصلی است — روی fallback، ثبتِ آن
                        // دادهٔ audit جعلی می‌شد.
                        provider: analysis.aiProvider
                            ? {
                                  provider: analysis.aiProvider,
                                  fallbackUsed: analysis.fallbackUsed,
                              }
                            : undefined,
                    }
                },
            })
            result = outcome.result
        } catch (error) {
            // رزرو پیش از AI انجام شده، پس هر خطایی از این نقطه به بعد یعنی
            // «رزرو کرده بودیم و باید آزاد شود» — که `runAiOperation` انجام داده
            // (و در صورت شکستِ release، markReleaseFailed + 503 داده است).
            // اینجا فقط ثبت observability باقی می‌ماند.
            if (error instanceof QuotaUnavailableError) {
                // زیرساخت quota: یک رکورد (شکست reserve یا شکست release).
                await recordError(error, context)
            } else if (error instanceof AiProviderUnavailableError) {
                // سند §۱۲ مرحله ۶ / §۲۱: شکست نهایی provider از pipeline عبور می‌کند.
                // outer catch برای ServiceErrorها recordError نمی‌کند → دقیقاً یک رکورد.
                await recordError(error, context)
            }
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
                    // فقط allowlist گام ۳ — هرگز prompt/response/provider payload/user content (§8).
                    // aiProvider/fallbackUsed فقط شناسهٔ سرویس‌دهنده و یک boolean هستند.
                    {
                        units: 1,
                        aiSource: result.aiSource,
                        ...(result.aiProvider ? { aiProvider: result.aiProvider } : {}),
                        ...(result.fallbackUsed !== undefined ? { fallbackUsed: result.fallbackUsed } : {}),
                        status: "success",
                    },
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
