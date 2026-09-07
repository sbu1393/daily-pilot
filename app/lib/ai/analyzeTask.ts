import { aiAnalysisSchema, type AiAnalysis } from "./aiSchema"
import { mockAnalyze } from "./mock"
import { parseAiJson } from "./repair"

export type AiSource = "1xai" | "mock"

export interface AiResult {
    source: AiSource
    analysis: AiAnalysis
    raw?: string
    attempts: number // چند تلاش انجام شد (برای دیباگ)
}

const BASE_URL = process.env.AIXAI_BASE_URL ?? "https://1xai.ir/v1"
const MODEL = process.env.AIXAI_MODEL ?? "deepseek-chat"

// حداکثر تلاش: پیش‌فرض ۳ (اول + ۲ تلاش مجدد)
const MAX_ATTEMPTS = Math.max(1, Number(process.env.AI_MAX_ATTEMPTS ?? 3))
// تایماوت هر تلاش: پیش‌فرض ۱۲ ثانیه — جمع تلاش‌ها نباید از محدودیت پلتفرم رد بشه
const TIMEOUT_MS = Math.max(3000, Number(process.env.AI_TIMEOUT_MS ?? 12000))

const SYSTEM_PROMPT = `تو دستیار تحلیل تسک در اپلیکیشن برنامه‌ریزی هوشمند «Daily Pilot» هستی.
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

class RetryableError extends Error { }
class NonRetryableError extends Error { }

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function fetchRaw(messages: { role: string; content: string }[]): Promise<string> {
    const apiKey = process.env.AIXAI_API_KEY
    if (!apiKey) throw new NonRetryableError("AIXAI_API_KEY missing")

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
        const res = await fetch(`${BASE_URL}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ model: MODEL, temperature: 0.2, messages }),
            signal: controller.signal,
        })

        if (!res.ok) {
            if (RETRYABLE_STATUS.has(res.status)) {
                throw new RetryableError(`1xai HTTP ${res.status}`)
            }
            const body = await res.text().catch(() => "")
            // 400/401/403/404 → هرگز تلاش مجدد نمی‌شود (هدر نرفتن سهمیه)
            throw new NonRetryableError(`1xai HTTP ${res.status}: ${body.slice(0, 200)}`)
        }

        const data = await res.json()
        const raw = data?.choices?.[0]?.message?.content
        if (typeof raw !== "string" || !raw.trim()) {
            throw new RetryableError("1xai: empty content")
        }
        return raw
    } catch (error) {
        if (error instanceof RetryableError || error instanceof NonRetryableError) throw error
        // خطای شبکه / abort / timeout → قابل تلاش مجدد
        throw new RetryableError(error instanceof Error ? error.message : "network error")
    } finally {
        clearTimeout(timer)
    }
}

/** یک تلاش کامل: فراخوانی مدل + parse مقاوم + اعتبارسنجی نهایی zod */
async function attempt(text: string, strict: boolean): Promise<{ analysis: AiAnalysis; raw: string }> {
    const raw = await fetchRaw([
        { role: "system", content: strict ? SYSTEM_PROMPT_STRICT : SYSTEM_PROMPT },
        { role: "user", content: `عنوان تسک: "${text}"` },
    ])
    // parseAiJson نرمال‌سازی می‌کند؛ zod آخرین گارد است
    const analysis = aiAnalysisSchema.parse(parseAiJson(raw))
    return { analysis, raw }
}

/**
 * تحلیل عنوان تسک — فقط سمت سرور صدا بزن (Route Handler / Server Action).
 * اگه کلید نباشد → Mock. اگه API خطا بده → retry هوشمند → در نهایت Mock.
 */
export async function analyzeTask(text: string): Promise<AiResult> {
    if (!process.env.AIXAI_API_KEY) {
        return { source: "mock", analysis: mockAnalyze(text), attempts: 0 }
    }

    let lastError: unknown = null

    for (let attemptNumber = 1; attemptNumber <= MAX_ATTEMPTS; attemptNumber++) {
        try {
            const { analysis, raw } = await attempt(text, attemptNumber > 1)
            return { source: "1xai", analysis, raw, attempts: attemptNumber }
        } catch (error) {
            lastError = error
            if (error instanceof NonRetryableError) break // صرف‌نظر از تلاش مجدد
            if (attemptNumber < MAX_ATTEMPTS) {
                // backoff با jitter — کوتاه نگه داشته شده تا از تایماوت پلتفرم رد نشود
                const backoff = Math.min(300 * 2 ** (attemptNumber - 1), 1500) + Math.random() * 200
                await sleep(backoff)
            }
        }
    }

    console.warn("⚠️ AI call failed after retries, falling back to mock:", (lastError as Error)?.message ?? lastError)
    return { source: "mock", analysis: mockAnalyze(text), attempts: MAX_ATTEMPTS }
}
