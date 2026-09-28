// registry سرویس‌دهنده‌های هوش مصنوعی
// ------------------------------------------------------------------
// تنها جایی که «کدام provider فعال است» تصمیم گرفته می‌شود.
//
// قانون مرحلهٔ فعلی: provider پیش‌فرض production همیشه `1xai` است. وجود
// `OPENROUTER_API_KEY` در محیط هیچ اثری ندارد و fallback هم فعال نیست.
// این مقدار عمداً یک ثابت صریح است تا در مراحل بعدی قابل تغییر و قابل تست باشد
// بدون آنکه لایهٔ transport یا قابلیت‌های AI تغییر کنند.

export { resolveTimeoutMs } from "./openaiCompatible"

import { oneXaiProvider } from "./onexai"
import { openRouterProvider } from "./openrouter"
import type { AiProvider, ProviderId } from "./types"

/** provider فعال در production — تا وقتی تصمیم دیگری گرفته نشده، 1xai. */
export const DEFAULT_PROVIDER_ID: ProviderId = "1xai"

const PROVIDERS: Readonly<Record<ProviderId, AiProvider>> = {
    "1xai": oneXaiProvider,
    openrouter: openRouterProvider,
}

export const listProviders = (): AiProvider[] => [PROVIDERS["1xai"], PROVIDERS.openrouter]

/** provider فعال — همان چیزی که providerClient برای فراخوانی استفاده می‌کند. */
export const getDefaultProvider = (): AiProvider => PROVIDERS[DEFAULT_PROVIDER_ID]

export const getProvider = (id: ProviderId): AiProvider => PROVIDERS[id]

export {
    NonRetryableError,
    OperationDeadlineError,
    ProviderUnusableError,
    RetryableError,
    isOperationDeadlineError,
    providerFailurePolicy,
    type AiProvider,
    type ChatMessage,
    type ProviderFailurePolicy,
    type ProviderId,
    type ProviderRuntimeConfig,
} from "./types"
