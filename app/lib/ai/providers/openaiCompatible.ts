// transport مشترک برای سرویس‌دهنده‌های OpenAI-compatible
// ------------------------------------------------------------------
// 1xai و OpenRouter هر دو از `/chat/completions` با قالب
// `{ model, temperature, messages }` و پاسخ `choices[0].message.content`
// استفاده می‌کنند. بنابراین منطق transport یک‌بار اینجا نوشته می‌شود و هر
// provider فقط مشخصاتش (envها، مدل پیش‌فرض، هدرهای اختیاری) را اعلام می‌کند.
//
// قرارداد رفتاری (بیت‌به‌بیت همان providerClient قبلی):
// - خطای HTTP قابل‌تلاش (408/429/5xx) → RetryableError
// - 4xx قطعی → NonRetryableError (بدون تلاش مجدد)
// - خطای شبکه/abort/timeout → RetryableError
// - محتوای خالی → RetryableError
// - پاسخ خام provider هرگز persist نمی‌شود؛ فقط به caller برمی‌گردد.

import {
    NonRetryableError,
    ProviderUnusableError,
    RetryableError,
    type AiProvider,
    type ChatMessage,
    type ProviderRuntimeConfig,
    type ProviderSpec,
} from "./types"

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])

/**
 * ۴۰۱/۴۰۳ خطای «خود درخواست» نیست؛ یعنی همین provider با همین کلید کار نمی‌کند.
 * تلاش مجدد و حتی fallback به مدل دیگری روی همین کلید بی‌فایده است، ولی
 * provider بعدی می‌تواند سالم باشد. پس جدا از ۴۰۰/۴۰۴ دسته‌بندی می‌شود.
 */
const PROVIDER_UNUSABLE_STATUS = new Set([401, 403])

/** تایماوت پیش‌فرض ۱۲ ثانیه با کف ۳ ثانیه — جمع تلاشها نباید از محدودیت پلتفرم رد بشه. */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 12000
export const MIN_PROVIDER_TIMEOUT_MS = 3000

export const resolveTimeoutMs = (raw: string | undefined): number =>
    Math.max(MIN_PROVIDER_TIMEOUT_MS, Number(raw ?? DEFAULT_PROVIDER_TIMEOUT_MS))

export const createOpenAiCompatibleProvider = (spec: ProviderSpec): AiProvider => {
    // به‌صورت محلی تعریف می‌شود تا `complete` به `this` وابسته نباشد و بتوان آن را
    // بدون شکستن context صدا زد.
    const buildHeaders = (config: ProviderRuntimeConfig): Record<string, string> => {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
        }
        // هدرهای provider-specific فقط اگر واقعاً پیکربندی شده باشند افزوده می‌شوند.
        const extra = spec.buildExtraHeaders?.()
        if (extra) Object.assign(headers, extra)
        return headers
    }

    const resolveConfig = (options?: { timeoutMs?: number }): ProviderRuntimeConfig => {
        const apiKey = process.env[spec.apiKeyEnv]
        if (!apiKey) throw new ProviderUnusableError(`${spec.apiKeyEnv} missing`, spec.id)

        return {
            baseUrl: process.env[spec.baseUrlEnv] ?? spec.defaultBaseUrl,
            model: process.env[spec.modelEnv] ?? spec.defaultModel,
            apiKey,
            timeoutMs: options?.timeoutMs ?? resolveTimeoutMs(process.env.AI_TIMEOUT_MS),
        }
    }

    return {
        id: spec.id,
        label: spec.label,
        baseUrlEnv: spec.baseUrlEnv,
        apiKeyEnv: spec.apiKeyEnv,
        modelEnv: spec.modelEnv,
        defaultBaseUrl: spec.defaultBaseUrl,
        defaultModel: spec.defaultModel,

        isConfigured() {
            return Boolean(process.env[spec.apiKeyEnv])
        },

        resolveConfig,

        buildHeaders,

        async complete(
            config,
            messages: ChatMessage[],
            options?: { signal?: AbortSignal },
        ): Promise<string> {
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), config.timeoutMs)

            // اگر signal بیرونی (سقف کل عملیات) داده شده باشد، این تلاش هم با آن قطع
            // می‌شود. listener حتماً در finally پاک می‌شود تا روی یک AbortSignal
            // بلندمدت leak نشود (یک عملیات چند تلاش دارد).
            const externalSignal = options?.signal
            const forwardAbort = () => controller.abort()
            if (externalSignal) {
                if (externalSignal.aborted) controller.abort()
                else externalSignal.addEventListener("abort", forwardAbort, { once: true })
            }

            try {
                const res = await fetch(`${config.baseUrl}/chat/completions`, {
                    method: "POST",
                    headers: buildHeaders(config),
                    body: JSON.stringify({ model: config.model, temperature: 0.2, messages }),
                    signal: controller.signal,
                })

                if (!res.ok) {
                    if (RETRYABLE_STATUS.has(res.status)) {
                        throw new RetryableError(`${spec.label} HTTP ${res.status}`)
                    }
                    const body = await res.text().catch(() => "")
                    if (PROVIDER_UNUSABLE_STATUS.has(res.status)) {
                        throw new ProviderUnusableError(
                            `${spec.label} HTTP ${res.status}: ${body.slice(0, 200)}`,
                            spec.id,
                        )
                    }
                    // 400/404 → هرگز تلاش مجدد نمی‌شود (هدر نرفتن سهمیه)
                    throw new NonRetryableError(`${spec.label} HTTP ${res.status}: ${body.slice(0, 200)}`)
                }

                const data = await res.json()
                const raw = data?.choices?.[0]?.message?.content
                if (typeof raw !== "string" || !raw.trim()) {
                    throw new RetryableError(`${spec.label}: empty content`)
                }
                return raw
            } catch (error) {
                if (error instanceof RetryableError || error instanceof NonRetryableError) throw error
                // خطای شبکه / abort / timeout → قابل تلاش مجدد
                throw new RetryableError(error instanceof Error ? error.message : "network error")
            } finally {
                clearTimeout(timer)
                externalSignal?.removeEventListener("abort", forwardAbort)
            }
        },
    }
}
