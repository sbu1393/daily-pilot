// app/lib/ai/providers/cloudflare.ts
// ------------------------------------------------------------------
// پرووایدر Cloudflare Workers AI با استاندارد OpenAI-compatible

import { createOpenAiCompatibleProvider } from "./openaiCompatible"

// اگر CLOUDFLARE_ACCOUNT_ID تنظیم شده باشد، بیس آدرس استاندارد OpenAI کلاودفلر را می‌سازد
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
const defaultBaseUrl = accountId 
    ? `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`
    : "https://api.cloudflare.com/client/v4/accounts/missing-account-id/ai/v1"

export const cloudflareProvider = createOpenAiCompatibleProvider({
    id: "cloudflare",
    label: "cloudflare",
    baseUrlEnv: "CLOUDFLARE_BASE_URL",
    apiKeyEnv: "CLOUDFLARE_API_TOKEN",
    modelEnv: "CLOUDFLARE_MODEL",
    defaultBaseUrl: defaultBaseUrl,
    // یک مدل رایگان، پرسرعت و بسیار قوی به عنوان پیش‌فرض:
    defaultModel: "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
})
