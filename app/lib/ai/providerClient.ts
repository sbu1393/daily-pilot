// Phase 2 — Shared AI provider transport (single integration point)
// ------------------------------------------------------------------
// تنها لایهی دسترسی به External AI Provider (1xai / OpenAI-compatible) در lib/ai.
// برای همهی قابلیتهای AI همین یک مسیر استفاده میشود تا provider/base/model/key/timeout/
// retry/backoff یکسان بماند و هیچ provider abstraction دومی ساخته نشود.
//
// قراردادها (بییت-به-بییت همان رفتار قبلی analyzeTask):
// - کلید از env سرور خوانده میشود؛ هرگز به کلاینت نمیرسد.
// - خطای HTTP قابل‌تلاش (408/429/5xx) → RetryableError؛ 4xx قطعی → NonRetryableError.
// - خطای شبکه/abort/timeout → RetryableError.
// - محتوای خالی → RetryableError.
// - این ماژول هیچ HTTP/route/DB/persist ندارد و هیچ mock/policy ای اعمال نمیکند.

export const AI_BASE_URL = process.env.AIXAI_BASE_URL ?? "https://1xai.ir/v1"
export const AI_MODEL = process.env.AIXAI_MODEL ?? "gpt-4o-mini"

// حداکثر تلاش: پیشفرض ۳ (اول + ۲ تلاش مجدد)
export const AI_MAX_ATTEMPTS = Math.max(1, Number(process.env.AI_MAX_ATTEMPTS ?? 3))
// تایماوت هر تلاش: پیشفرض ۱۲ ثانیه — جمع تلاشها نباید از محدودیت پلتفرم رد بشه
export const AI_TIMEOUT_MS = Math.max(3000, Number(process.env.AI_TIMEOUT_MS ?? 12000))

export class RetryableError extends Error {}
export class NonRetryableError extends Error {}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** backoff با jitter — کوتاه نگه داشته شده تا از تایماوت پلتفرم رد نشود */
export const retryBackoffMs = (attemptNumber: number): number =>
    Math.min(300 * 2 ** (attemptNumber - 1), 1500) + Math.random() * 200

export type ChatMessage = { role: string; content: string }

/** یک فراخوانی خام provider — بدون parse/اعتبارسنجی (آن کار caller است). */
export async function fetchProviderRaw(messages: ChatMessage[]): Promise<string> {
    const apiKey = process.env.AIXAI_API_KEY
    if (!apiKey) throw new NonRetryableError("AIXAI_API_KEY missing")

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS)

    try {
        const res = await fetch(`${AI_BASE_URL}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ model: AI_MODEL, temperature: 0.2, messages }),
            signal: controller.signal,
        })

        if (!res.ok) {
            if (RETRYABLE_STATUS.has(res.status)) {
                throw new RetryableError(`1xai HTTP ${res.status}`)
            }
            const body = await res.text().catch(() => "")
            // 400/401/403/404 → هرگز تلاش مجدد نمیشود (هدر نرفتن سهمیه)
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
