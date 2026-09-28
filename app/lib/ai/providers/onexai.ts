// provider جایگزین production — 1xai (OpenAI-compatible)
// ------------------------------------------------------------------
// این provider فقط **fallback** است: تا وقتی provider پیش‌فرض (OpenRouter) پاسخ
// می‌دهد، هیچ درخواستی به این سرویس پولی ارسال نمی‌شود. انتخاب آن در registry
// (./index) و ترتیب زنجیره در providerClient تعریف شده است.

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
