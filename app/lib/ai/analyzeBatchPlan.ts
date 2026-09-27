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

import { mockBatchPlan } from "./planMock"
import { parseAiPlanJson } from "./planSchema"
import { AI_MAX_ATTEMPTS, NonRetryableError, fetchProviderRaw, retryBackoffMs, sleep } from "./providerClient"
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

    if (!process.env.AIXAI_API_KEY) {
        if (!allowMockFallback) throw new AiProviderUnavailableError()
        return { source: "mock", plan: mockBatchPlan(input), attempts: 0 }
    }

    let lastError: unknown = null

    for (let attemptNumber = 1; attemptNumber <= AI_MAX_ATTEMPTS; attemptNumber++) {
        try {
            const raw = await fetchProviderRaw([
                {
                    role: "system",
                    content: attemptNumber > 1 ? SYSTEM_PROMPT_STRICT : SYSTEM_PROMPT,
                },
                { role: "user", content: buildUserMessage(input) },
            ])
            // parseAiPlanJson = extractJson (repair) + zod (strict + cross-field)
            const plan = parseAiPlanJson(raw)
            return { source: "1xai", plan, raw, attempts: attemptNumber }
        } catch (error) {
            lastError = error
            if (error instanceof NonRetryableError) break // صرف‌نظر از تلاش مجدد
            if (attemptNumber < AI_MAX_ATTEMPTS) {
                await sleep(retryBackoffMs(attemptNumber))
            }
        }
    }

    // production — شکست نهایی provider هرگز mock/success نیست (سند فاز ۱ §۱۲)
    if (!allowMockFallback) throw new AiProviderUnavailableError()

    // non-production — همان رفتار تحلیل تک‌تسکی: گزارش امن + mock قطعی
    await recordError(lastError ?? new Error("AI provider unavailable after retries"), {
        requestId: "unknown",
        endpoint: "analyzeBatchPlan",
        feature: "ai",
    })
    return { source: "mock", plan: mockBatchPlan(input), attempts: AI_MAX_ATTEMPTS }
}
