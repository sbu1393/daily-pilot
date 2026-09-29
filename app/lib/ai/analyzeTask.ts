import { AiProviderUnavailableError } from "@/app/lib/services/errors"
import { recordError } from "@/src/lib/observability/recordError"

import { aiAnalysisSchema, type AiAnalysis } from "./aiSchema"
import { attachAiCallTelemetry, startAiCallTimer, type AiCallTelemetry } from "./aiDuration"
import { mockAnalyze } from "./mock"
import { AI_MAX_ATTEMPTS, runAiOperation, type ProviderId } from "./providerClient"
import { getDefaultProvider } from "./providers"
import { parseAiJson } from "./repair"

export type AiSource = "1xai" | "mock"

export interface AiResult {
    source: AiSource
    analysis: AiAnalysis
    raw?: string
    attempts: number // چند تلاش انجام شد (برای دیباگ)
    /**
     * provider‌ای که واقعاً پاسخ را داد — فقط برای observability.
     * با زنجیرهٔ فعلی («openrouter» سپس «1xai») مقدار آن provider مؤثر است و
     * قرارداد عمومی `source` (که مقدار «1xai» می‌گیرد) دست‌نخورده می‌ماند.
     */
    aiProvider?: ProviderId
    /** آیا پاسخ از provider جایگزین آمده است؟ (پیش‌فرض: خیر) */
    fallbackUsed?: boolean
    /**
     * مدت واقعی همین عملیات AI + شمارندهٔ تلاش — فقط برای observability
     * (مرحلهٔ ۴.۲). اختیاری است تا همهٔ call siteهای موجود بدون تغییر بمانند
     * و قرارداد عمومی `source` دست‌نخورده بماند.
     */
    aiTelemetry?: AiCallTelemetry
}

const SYSTEM_PROMPT = `تو دستیار تحلیل تسک در اپلیکیشن برنامه‌ریزی هوشمند «روزساز» هستی.
عنوان یک کار را می‌گیری و فقط یک JSON معتبر برمی‌گردانی (بدون markdown و بدون توضیح اضافه) با این ساختار:
{
  "priority": "HIGH" یا "MEDIUM" یا "LOW",
  "score": عدد صحیح ۰ تا ۱۰۰ (اهمیت و فوریت ترکیبی),
  "estimatedMinutes": عدد صحیح ۵ تا ۴۸۰ (تخمین زمان لازم برای یک انسان معمولی به دقیقه),
  "reason": یک جمله فارسی کوتاه که چرایی اولویت و زمان را توضیح دهد,
  "category": یکی از "home" | "work" | "transport" | "shopping" | "learning" | "health" | "leisure" | "personal" — موضوع کار را توصیف کن؛ اگر هیچ‌کدام مناسب نبود "personal"
}
دقت کن خروجی حتماً JSON خام و قابل parse باشد.`

// تلاش‌های دوم به بعد با این پرامپت سخت‌گیرانه‌تر صدا زده می‌شوند
const SYSTEM_PROMPT_STRICT = `${SYSTEM_PROMPT}
هشدار: خروجی قبلی قابل parse نبود. این بار فقط و فقط یک آبجکت JSON خام و معتبر برگردان؛ بدون توضیح، بدون markdown، بدون کاراکتر اضافه.`

/** پیام‌ها برای یک تلاش — تشدید prompt فقط از تلاش دوم به بعد. */
const buildMessages = (text: string, strict: boolean) => [
    { role: "system", content: strict ? SYSTEM_PROMPT_STRICT : SYSTEM_PROMPT },
    { role: "user", content: `عنوان تسک: "${text}"` },
]

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

    // کلید provider **پیش‌فرض** (اکنون openrouter) ملاک است، نه یک سرویس خاص.
    // نام env از خودِ provider خوانده می‌شود تا تعویض ترتیب provider این گارد را
    // بی‌صدا از کار نیندازد. رفتار fail-closed عیناً حفظ می‌شود: نه fallback خودسرانه،
    // نه mock در production.
    if (!getDefaultProvider().isConfigured()) {
        if (!allowMockFallback) throw new AiProviderUnavailableError()
        return { source: "mock", analysis: mockAnalyze(text), attempts: 0 }
    }

    // مرحلهٔ ۴.۲ — دقیقاً حول خودِ عملیات AI، نه کل route و نه خواندن DB
    // اطراف آن. fail-Open: خراب‌شدن این اندازه‌گیری هیچ اثری ندارد.
    const stopTimer = startAiCallTimer()

    try {
        // orchestration (provider انتخاب، retry و fallback) کاملاً در
        // providerClient است — اینجا فقط prompt و parse قرار دارند.
        const result = await runAiOperation({
            buildMessages: (attemptNumber) => buildMessages(text, attemptNumber > 1),
            // parseAiJson نرمال‌سازی می‌کند؛ zod آخرین گارد است
            transform: (raw) => aiAnalysisSchema.parse(parseAiJson(raw)),
        })
        return {
            source: "1xai",
            analysis: result.value,
            raw: result.content,
            attempts: result.attempts,
            aiProvider: result.providerId,
            fallbackUsed: result.fallbackUsed,
            aiTelemetry: stopTimer(result.attempts),
        }
    } catch (error) {
    console.error("[AI_PROVIDER_FAILURE]", {
        name: error instanceof Error ? error.name : typeof error,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
    })

    if (!allowMockFallback) {
        throw attachAiCallTelemetry(new AiProviderUnavailableError(), stopTimer())
        }

        // فاز ۲ — سند §17: لاگ خام console در این محل حذف شد و شکست از همان boundary
        // observability عبور می‌کند (normalize → redact → policy → persist → external seam).
        // رفتار non-production/mock دقیقاً مثل قبل است (بدون throw، همان mock) — فقط کانال
        // لاگ امن شد؛ متن خام پیام provider از طریق redaction همان boundary می‌گذرد.
        // recordError خودش fail-open است، پس این مسیر هرگز پاسخ را نمی‌شکند.
        await recordError(error, {
            requestId: "unknown",
            endpoint: "analyzeTask",
            feature: "ai",
        })
        return { source: "mock", analysis: mockAnalyze(text), attempts: AI_MAX_ATTEMPTS }
    }
}
