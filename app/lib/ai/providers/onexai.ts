// provider پیش‌فرض production — 1xai (OpenAI-compatible)
// ------------------------------------------------------------------
// این provider رفتار قبلی `providerClient` را بدون هیچ تغییری نگه می‌دارد:
// همان base URL، همان envها، همان مدل، همان endpoint و همان متن خطا.
//
// توجه: انتخاب این provider در production در registry (./index) ثابت است و
// صرفاً وجود داشتن کلید OpenRouter هرگز provider فعال را عوض نمی‌کند.

import { createOpenAiCompatibleProvider } from "./openaiCompatible"

export const oneXaiProvider = createOpenAiCompatibleProvider({
    id: "1xai",
    label: "1xai",
    baseUrlEnv: "AIXAI_BASE_URL",
    apiKeyEnv: "AIXAI_API_KEY",
    modelEnv: "AIXAI_MODEL",
    defaultBaseUrl: "https://1xai.ir/v1",
    defaultModel: "gpt-4o-mini",
    // 1xai هیچ هدر اختصاصی نمی‌خواهد — پس هیچ چیزی افزوده نمی‌شود.
})
