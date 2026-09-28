// AI provider abstraction — قرارداد provider-agnostic
// ------------------------------------------------------------------
// این فایل فقط «شکل» سرویس‌دهندهٔ هوش مصنوعی را تعریف می‌کند و هیچ چیزی دربارهٔ
// Task Analysis یا Daily Planning نمی‌داند. لایهٔ بالاتر (analyzeTask /
// analyzeBatchPlan) فقط می‌داند «یک متن بگیر، یک متن خام برگردان».
//
// مرزها:
// - این لایه هیچ HTTP route، DB، quota، persist یا mock/policy ندارد.
// - هیچ کلیدی از اینجا به کلاینت نمی‌رسد؛ همهٔ envها فقط در سرور خوانده می‌شوند.
// - retry عمداً در این لایه نیست: هر provider فقط «یک تلاش» انجام می‌دهد و
//   تصمیم دربارهٔ تلاش مجدد در لایهٔ orchestration (providerClient) می‌ماند تا
//   شمارش attempt و backoff بین همهٔ قابلیت‌ها یکسان بماند.

/** شناسهٔ پایدار هر سرویس‌دهنده — در لاگ و تست‌ها قابل تشخیص است. */
export type ProviderId = "1xai" | "openrouter"

export type ChatMessage = { role: string; content: string }

/** خطایی که تلاش مجدد مجاز است (HTTP قابل‌تلاش، شبکه، timeout، محتوای خالی). */
export class RetryableError extends Error {}
/** خطای قطعی (4xx، کلید غایب) — هرگز تلاش مجدد نمی‌شود تا سهمیه نسوزد. */
export class NonRetryableError extends Error {}

/**
 * خطای مخصوص یک provider (کلید نامعتبر/ردشده 401/403).
 *
 * از NonRetryableError ارث می‌برد تا همهٔ قراردادهای قبلی (retry نکردن،
 * `instanceof NonRetryableError` در callerها) بدون تغییر کار کنند، ولی
 * orchestration می‌تواند آن را تشخیص دهد و به provider بعدی برود.
 *
 * چرا subclass و نه یک صنف موازی: پروژه از قبل یک hierarchy دارد؛ افزودن
 * subclass برخلاف ساختن hierarchy دوم، هیچ شاخهٔ تازه‌ای وارد نمی‌کند.
 */
export class ProviderUnusableError extends NonRetryableError {
    readonly providerId: string

    constructor(message: string, providerId: string) {
        super(message)
        this.name = "ProviderUnusableError"
        this.providerId = providerId
    }
}

/** تنظیمات حل‌شدهٔ یک provider برای یک فراخوانی مشخص. */
export interface ProviderRuntimeConfig {
    baseUrl: string
    model: string
    apiKey: string
    timeoutMs: number
}

/** توصیف یک سرویس‌دهندهٔ OpenAI-compatible. */
export interface ProviderSpec {
    id: ProviderId
    /** برچسبی که در پیام خطا می‌آید (بدون هیچ اطلاعات محرمانه). */
    label: string
    baseUrlEnv: string
    apiKeyEnv: string
    modelEnv: string
    defaultBaseUrl: string
    defaultModel: string
    /** هدرهای اختیاری provider — از env خوانده می‌شوند، هرگز hardcode نمی‌شوند. */
    buildExtraHeaders?: () => Record<string, string>
}

/**
 * یک provider کامل و آمادهٔ استفاده.
 *
 * نکتهٔ طراحی: `isConfigured` و `resolveConfig` در **زمان فراخوانی** env را
 * می‌خوانند (نه در سطح ماژول) تا قابل تست بمانند و تا رفتار فعلی پروژه
 * (که کلید در هر درخواست خوانده می‌شد) دقیقاً حفظ شود.
 */
export interface AiProvider {
    readonly id: ProviderId
    readonly label: string
    readonly baseUrlEnv: string
    readonly apiKeyEnv: string
    readonly modelEnv: string
    readonly defaultBaseUrl: string
    readonly defaultModel: string
    /** آیا کلید این provider در محیط سرور موجود است؟ */
    isConfigured(): boolean
    /** حل تنظیمات؛ اگر کلید نباشد NonRetryableError می‌دهد. */
    resolveConfig(options?: { timeoutMs?: number }): ProviderRuntimeConfig
    buildHeaders(config: ProviderRuntimeConfig): Record<string, string>
    /**
     * یک تلاش کامل؛ بدون retry. خروجی: محتوای خام متن مدل.
     *
     * `signal` اختیاری و بیرونی است: اگر داده شود، هر تلاش هم با تایماوت خودش و هم
     * با آن signal قطع می‌شود. نبودنش دقیقاً یعنی رفتار قدیمی (فقط تایماوت محلی).
     */
    complete(
        config: ProviderRuntimeConfig,
        messages: ChatMessage[],
        options?: { signal?: AbortSignal },
    ): Promise<string>
}

/**
 * خطای سقف زمانی کل عملیات (نه یک تلاش منفرد).
 *
 * از RetryableError ارث می‌برد تا هر caller ی که «خطای گذرا» می‌شناسد آن را
 * درست ببیند، ولی orchestration می‌تواند تشخیص دهد که دیگر نباید هیچ provider
 * دیگری (نه fallback) امتحان شود.
 */
export class OperationDeadlineError extends RetryableError {
    constructor() {
        super("ai operation deadline exceeded")
        this.name = "OperationDeadlineError"
    }
}

/**
 * سیاست fallback برای یک خطای transport.
 *
 * - "retry-same-then-fallback": خطای گذرا — اول همان provider دوباره، و اگر
 *   تمام شد provider بعدی امتحان شود.
 * - "unusable": این provider در این عملیات غیرقابل‌استفاده است (401/403) —
 *   تلاش مجدد فایده ندارد، مستقیم provider بعدی.
 * - "fatal": خطای قطعیِ خود درخواست (400/404) — نه retry، نه fallback؛
 *   تعویض provider فقط هزینه و تأخیر اضافه می‌کند.
 */
export type ProviderFailurePolicy = "retry-same-then-fallback" | "unusable" | "fatal"

/** نگاشت خطا به سیاست fallback — تنها مرجع تصمیم‌گیری در کل پروژه. */
export function providerFailurePolicy(error: unknown): ProviderFailurePolicy {
    // ترتیب مهم است: subclass باید قبل از base بررسی شود.
    if (error instanceof ProviderUnusableError) return "unusable"
    if (error instanceof NonRetryableError) return "fatal"
    return "retry-same-then-fallback"
}

/** آیا خطا یعنی «بودجهٔ زمانی کل عملیات تمام شد»؟ */
export function isOperationDeadlineError(error: unknown): boolean {
    return error instanceof OperationDeadlineError
}
