// Phase 2 (AI Daily Plan) — batch AI operation (provider call)
// ------------------------------------------------------------
// analyzeBatchPlan(input) — کامل‌ترین جریان AI برای «ایجاد برنامه»:
//   PlanInput (مجموعهٔ کامل کارهای روز + ظرفیت) → provider → parseAiPlanJson → PlanAnalysisResult
//
// سیاست‌های محیطی دقیقاً همان analyzeTask (سند فاز ۱ §۲/§۱۲):
// - non-production: کلید غایب یا شکست نهایی → mock قطعی (planMock) با source="mock".
// - production: هرگز mock به‌عنوان موفقیت برنمی‌گردد؛ کلید غایب/شکست → AiProviderUnavailableError (۵۰۳).
// - retry/backoff/timeout/provider از providerClient مشترک — بدون provider abstraction دوم.
//
// این تابع هیچ persistence/HTTP/quota ای انجام نمی‌دهد؛ فقط تحلیل. quota/route در لایهٔ route است.

import { AiProviderUnavailableError } from "@/app/lib/services/errors"
import { recordError } from "@/src/lib/observability/recordError"

import { attachAiCallTelemetry, startAiCallTimer } from "./aiDuration"
import { mockBatchPlan } from "./planMock"
import { parseAiPlanJson } from "./planSchema"
import { AI_MAX_ATTEMPTS, runAiOperation, type ProviderId } from "./providerClient"
import { getDefaultProvider } from "./providers"
import type { PlanAnalysisResult, PlanInput } from "./planContract"

// پرامپت سیستم — AI فقط تحلیل/پیشنهاد می‌دهد و scheduler نهایی نیست (architecture §3.5 / ADR-008).
const SYSTEM_PROMPT = `تو «تحلیل‌گر برنامهٔ روزانه» در اپلیکیشن برنامه‌ریزی «روزساز» هستی.
مجموعهٔ کارهای یک روز به‌همراه ظرفیت زمانی آن روز (به دقیقه) به تو داده می‌شود.
وظیفهٔ تو فقط تحلیل و پیشنهاد است؛ تو برنامه‌ریز نهایی نیستی و تخصیص ظرفیت/زمان‌بندی نهایی را تعیین نمی‌کنی.

قواعد:
- فقط روی همان taskIdهای ورودی کار کن. هیچ کار جدیدی نساز و هیچ taskId جدیدی اختراع نکن.
- برای هر کار دقیقاً یک آیتم در "items" تولید کن با این کلیدها:
  "taskId" (عدد همان کار ورودی)، "estimatedMinutes" (عدد صحیح ۵ تا ۴۸۰)،
  "score" (عدد صحیح ۰ تا ۱۰۰ = اهمیت و فوریت ترکیبی)،
  "priority" (یکی از "HIGH" | "MEDIUM" | "LOW")،
  "order" (عدد صحیح مثبت و یکتا = ترتیب پیشنهادی اجرا؛ فقط پیشنهاد/advisory)،
  "reason" (یک جملهٔ فارسی کوتاه).
- اگر ظرفیت روز برای همهٔ کارها کافی نیست، شناسهٔ کارهایی که جا نمی‌شوند را در
  "unscheduledTaskIds" بگذار. هر کار باید دقیقاً در یکی از دو حالت باشد؛ نه هم‌زمان در
  items و unscheduledTaskIds. اگر همه جا می‌شوند، این کلید را حذف کن.
- "summary" اختیاری: یک جمع‌بندی کوتاه فارسی.
- ترتیب نهایی و تخصیص ظرفیت توسط موتور برنامه‌ریزی سیستم تعیین می‌شود؛ order فقط پیشنهاد است.
خروجی فقط و فقط یک آبجکت JSON خام و معتبر با همین ساختار باشد (بدون markdown، بدون توضیح اضافه):
{
  "items": [
    { "taskId": 1, "estimatedMinutes": 30, "score": 70, "priority": "HIGH", "order": 1, "reason": "..." }
  ],
  "unscheduledTaskIds": [],
  "summary": "..."
}`

const SYSTEM_PROMPT_STRICT = `${SYSTEM_PROMPT}
هشدار: خروجی قبلی قابل parse یا مطابق ساختار نبود. این بار فقط و فقط یک آبجکت JSON خام و معتبر برگردان؛ بدون توضیح، بدون markdown، بدون کاراکتر اضافه.`

/** پیام‌ها برای یک تلاش — تشدید prompt فقط از تلاش دوم به بعد. */
const buildMessages = (input: PlanInput, strict: boolean) => [
    {
        role: "system",
        content: strict ? SYSTEM_PROMPT_STRICT : SYSTEM_PROMPT,
    },
    { role: "user", content: buildUserMessage(input) },
]

/** پیام کاربر — فقط دادهٔ لازم برای انتخاب روز/کارها/ظرفیت (بدون داده حساس). */
function buildUserMessage(input: PlanInput): string {
    const tasks = input.tasks.map((task) => ({
        taskId: task.taskId,
        title: task.title,
        category: task.category ?? null,
        estimatedMinutes: task.existingEstimatedMinutes ?? null,
        score: task.existingScore ?? null,
        priority: task.existingPriority ?? null,
    }))

    return [
        `روز: ${input.dayKey}`,
        `ظرفیت روز (دقیقه): ${input.availableMinutes}`,
        `تعداد کارها: ${tasks.length}`,
        `کارها (taskId هر کار را عیناً برگردان):`,
        JSON.stringify(tasks),
    ].join("\n")
}

/**
 * analyzeBatchPlan — فقط سمت سرور صدا بزن (Route Handler).
 * ورودی همان PlanInput فاز ۱ است؛ خروجی PlanAnalysisResult (source/plan/attempts).
 */
export async function analyzeBatchPlan(input: PlanInput): Promise<PlanAnalysisResult> {
    // mock فقط در non-production مجاز است (سند فاز ۱ §۲ — محیط‌محور)
    const allowMockFallback = process.env.NODE_ENV !== "production"

    // کلید provider **پیش‌فرض** (اکنون openrouter) ملاک است، نه یک سرویس خاص.
    // نام env از خودِ provider خوانده می‌شود تا تعویض ترتیب provider این گارد را
    // بی‌صدا از کار نیندازد. رفتار fail-closed عیناً حفظ می‌شود.
    if (!getDefaultProvider().isConfigured()) {
        if (!allowMockFallback) throw new AiProviderUnavailableError()
        return { source: "mock", plan: mockBatchPlan(input), attempts: 0 }
    }

    // مرحلهٔ ۴.۲ — فقط خودِ عملیات provider اندازه‌گیری می‌شود (fail-Open)
    const stopTimer = startAiCallTimer()

    try {
        // orchestration مشترک با تحلیل تک‌تسکی — هیچ fallback جداگانه‌ای اینجا نیست
        const result = await runAiOperation({
            buildMessages: (attemptNumber) => buildMessages(input, attemptNumber > 1),
            // parseAiPlanJson = extractJson (repair) + zod (strict + cross-field)
            transform: parseAiPlanJson,
        })
        return {
            source: "1xai",
            plan: result.value,
            raw: result.content,
            attempts: result.attempts,
            aiProvider: result.providerId,
            fallbackUsed: result.fallbackUsed,
            aiTelemetry: stopTimer(result.attempts),
        } as PlanAnalysisResult
    } catch (error) {
        // production — شکست نهایی provider هرگز mock/success نیست (سند فاز ۱ §۱۲).
        // مدت اندازه‌گیری‌شده بیرون از شیء خطا نگه داشته می‌شود تا route آن را
        // کنار failureCode بنویسد؛ خودِ خطا و کد آن کاملاً دست‌نخورده است.
        if (!allowMockFallback) {
            throw attachAiCallTelemetry(new AiProviderUnavailableError(), stopTimer())
        }

        // non-production — همان رفتار تحلیل تک‌تسکی: گزارش امن + mock قطعی
        await recordError(error, {
            requestId: "unknown",
            endpoint: "analyzeBatchPlan",
            feature: "ai",
        })
        return { source: "mock", plan: mockBatchPlan(input), attempts: AI_MAX_ATTEMPTS }
    }
}
