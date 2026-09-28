// provider اختیاری — OpenRouter (OpenAI-compatible)
// ------------------------------------------------------------------
// وضعیت: **provider پیش‌فرض production.** انتخاب آن در registry (./index) ثابت
// است؛ 1xai تنها fallback است و فقط وقتی fallback فعال باشد صدا زده می‌شود.
//
// هدرهای `HTTP-Referer` و `X-Title` که OpenRouter توصیه می‌کند اختیاری‌اند و
// از env خوانده می‌شوند (نه hardcode). اگر تنظیم نشده باشند اصلاً ارسال
// نمی‌شوند تا درخواست با providerهای دیگر بی‌تفاوت بماند.

import { createOpenAiCompatibleProvider } from "./openaiCompatible"

const trimmed = (value: string | undefined): string | undefined => value?.trim() || undefined

export const openRouterProvider = createOpenAiCompatibleProvider({
    id: "openrouter",
    label: "openrouter",
    baseUrlEnv: "OPENROUTER_BASE_URL",
    apiKeyEnv: "OPENROUTER_API_KEY",
    modelEnv: "OPENROUTER_MODEL",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "qwen/qwen3.8-27b:free",
    buildExtraHeaders: () => {
        const headers: Record<string, string> = {}
        const referer = trimmed(process.env.OPENROUTER_REFERER)
        if (referer) headers["HTTP-Referer"] = referer
        const title = trimmed(process.env.OPENROUTER_TITLE)
        if (title) headers["X-Title"] = title
        return headers
    },
})
