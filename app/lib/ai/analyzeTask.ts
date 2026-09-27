import { AiProviderUnavailableError } from "@/app/lib/services/errors"
import { recordError } from "@/src/lib/observability/recordError"

import { aiAnalysisSchema, type AiAnalysis } from "./aiSchema"
import { mockAnalyze } from "./mock"
import { AI_MAX_ATTEMPTS, NonRetryableError, fetchProviderRaw, retryBackoffMs, sleep } from "./providerClient"
import { parseAiJson } from "./repair"

export type AiSource = "1xai" | "mock"

export interface AiResult {
    source: AiSource
    analysis: AiAnalysis
    raw?: string
    attempts: number // چند تلاش انجام شد (برای دیباگ)
}

const SYSTEM_PROMPT = `تو دستیار تحلیل تسک در اپلیکیشن برنامه‌ریزی هوشمند «روزساز» هستی.
عنوان یک کار را می‌گیری و فقط یک JSON معتبر برمی‌گردانی (بدون markdown و بدون توضیح اضافه) با این ساختار:
{
  "priority": "HIGH" یا "MEDIUM" یا "LOW",
  "score": عدد صحیح ۰ تا ۱۰۰ (اهمیت و فوریت ترکیبی),
  "estimatedMinutes": عدد صحیح ۵ تا ۴۸۰ (تخمین زمان لازم برای یک انسان معمولی به دقیقه),
  "reason": یک جمله فارسی کوتاه که چرایی اولویت و زمان را توضیح دهد,
  "category": یکی از "Work" | "Personal" | "Urgent" | "Health" — اگر هیچ‌کدام مناسب نبود "Personal"
}
دقت کن خروجی حتماً JSON خام و قابل parse باشد.`

// تلاش‌های دوم به بعد با این پرامپت سخت‌گیرانه‌تر صدا زده می‌شوند
const SYSTEM_PROMPT_STRICT = `${SYSTEM_PROMPT}
هشدار: خروجی قبلی قابل parse نبود. این بار فقط و فقط یک آبجکت JSON خام و معتبر برگردان؛ بدون توضیح، بدون markdown، بدون کاراکتر اضافه.`

/** یک تلاش کامل: فراخوانی مدل + parse مقاوم + اعتبارسنجی نهایی zod */
async function attempt(text: string, strict: boolean): Promise<{ analysis: AiAnalysis; raw: string }> {
    const raw = await fetchProviderRaw([
        { role: "system", content: strict ? SYSTEM_PROMPT_STRICT : SYSTEM_PROMPT },
        { role: "user", content: `عنوان تسک: "${text}"` },
    ])
    // parseAiJson نرمال‌سازی می‌کند؛ zod آخرین گارد است
    const analysis = aiAnalysisSchema.parse(parseAiJson(raw))
    return { analysis, raw }
}

/**
 * تحلیل عنوان تسک — فقط سمت سرور صدا بزن (Route Handler / Server Action).
 *
 * فاز ۱ — سند §۲/§۱۲: mock یک امکاناتِ محیط توسعه است و **هرگز** نباید در production به‌عنوان
 * موفقیت گزارش شود؛ وگرنه quota اشتباه مصرف می‌شود، release رخ نمی‌دهد و failureCode/observability
 * اجرا نمی‌شود. بنابراین:
 * - non-production: رفتار قبلی حفظ می‌شود (کلید غایب → Mock؛ شکست پس از retryها → Mock).
 * - production: هیچ mockی ساخته نمی‌شود؛ کلید غایب یا شکست نهایی provider →
 *   `AiProviderUnavailableError` (۵۰۳ AI_PROVIDER_UNAVAILABLE) تا caller رزرو کووتا را آزاد کند.
 * این gate در زمان فراخوانی خوانده می‌شود (نه در سطح ماژول) تا قابل تست بماند.
 */
export async function analyzeTask(text: string): Promise<AiResult> {
    // mock فقط در non-production مجاز است (سند §۲ فاز ۱ — محیط‌محور)
    const allowMockFallback = process.env.NODE_ENV !== "production"

    if (!process.env.AIXAI_API_KEY) {
        if (!allowMockFallback) throw new AiProviderUnavailableError()
        return { source: "mock", analysis: mockAnalyze(text), attempts: 0 }
    }

    let lastError: unknown = null

    for (let attemptNumber = 1; attemptNumber <= AI_MAX_ATTEMPTS; attemptNumber++) {
        try {
            const { analysis, raw } = await attempt(text, attemptNumber > 1)
            return { source: "1xai", analysis, raw, attempts: attemptNumber }
        } catch (error) {
            lastError = error
            if (error instanceof NonRetryableError) break // صرف‌نظر از تلاش مجدد
            if (attemptNumber < AI_MAX_ATTEMPTS) {
                // backoff با jitter — کوتاه نگه داشته شده تا از تایماوت پلتفرم رد نشود
                await sleep(retryBackoffMs(attemptNumber))
            }
        }
    }

    // production — سند §۱۲: شکست نهایی provider هرگز mock/success نیست
    if (!allowMockFallback) throw new AiProviderUnavailableError()

    // فاز ۲ — سند §17: لاگ خام console در این محل حذف شد و شکست از همان boundary
    // observability عبور می‌کند (normalize → redact → policy → persist → external seam).
    // رفتار non-production/mock دقیقاً مثل قبل است (بدون throw، همان mock) — فقط کانال
    // لاگ امن شد؛ متن خام پیام provider از طریق redaction همان boundary می‌گذرد.
    // recordError خودش fail-open است، پس این مسیر هرگز پاسخ را نمی‌شکند.
    await recordError(lastError ?? new Error("AI provider unavailable after retries"), {
        requestId: "unknown",
        endpoint: "analyzeTask",
        feature: "ai",
    })
    return { source: "mock", analysis: mockAnalyze(text), attempts: AI_MAX_ATTEMPTS }
}
