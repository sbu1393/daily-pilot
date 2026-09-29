// Phase 2 — Shared AI provider orchestration (single integration point)
// ------------------------------------------------------------------
// تنها لایهی تصمیم‌گیری دربارهٔ «به کدام provider و چند بار» در lib/ai.
//
// لایه‌بندی:
//   قابلیت (analyzeTask / analyzeBatchPlan) → این فایل (orchestration)
//   → app/lib/ai/providers (registry + transport) → سرویس‌دهندهٔ OpenAI-compatible
//
// سه قاعدهٔ غیرقابل‌شکستن این فایل:
// 1) Quota متعلق به «logical AI operation» است، نه به تعداد provider call.
//    این ماژول هیچ‌وقت reserve/complete/release را صدا نمی‌کند؛ آن‌ها یک‌بار در
//    route انجام می‌شوند. fallback چند provider را صدا بزند، یک واحد سهمیه است.
// 2) retry روی «همان provider» می‌ماند؛ fallback فقط بعد از تمام‌شدن بودجهٔ
//    retry همان provider شروع می‌شود.
// 3) خطای قطعیِ خود درخواست (400/404) هرگز fallback نمی‌گیرد.
// 4) خطای parse/اعتبارسنجی هرگز fallback نمی‌گیرد: retryهای همان provider انجام
//    می‌شود، سپس زنجیره متوقف و **همان** خطای parse پرتاب می‌شود (provider بعدی
//    صفر بار صدا زده می‌شود — قبلاً `continue` این کار را می‌کرد و fallback اجرا
//    می‌شد، یعنی یک parse error می‌توانست provider پولی را هم صدا بزند).
// 5) `attempts` = تعداد واقعی `provider.complete()`؛ یکی به‌ازای هر فراخوانی، نه
//    تعداد exception و نه تعداد تصمیم retry. هرگز fallback نمی‌گیرد.
//
// رفتار پیش‌فرض production (ترتیب معکوس‌شده):
// provider = openrouter · fallback = 1xai (فقط با AI_ALLOW_FALLBACK="true")
// · AI_MAX_ATTEMPTS تلاش · backoff با jitter.

import { getDefaultProvider, getProvider, resolveTimeoutMs, providerFailurePolicy, isOperationDeadlineError, NonRetryableError, OperationDeadlineError, ProviderUnusableError, RetryableError, type ChatMessage, type ProviderId } from "./providers"

// مقصد فعال در production. انتخاب provider در app/lib/ai/providers/index است و
// عمداً صریح تعریف شده؛ تغییر آن یک تصمیم آگاهانه است، نه یک اثر جانبی.
const DEFAULT_PROVIDER = getDefaultProvider()

// ترتیب قطعی fallback: openrouter (primary) → 1xai. هرگز برعکس.
// دلیل: 1xai سرویس پولی است و تا وقتی OpenRouter پاسخ می‌دهد نباید صدا زده شود.
const FALLBACK_PROVIDER_ID: ProviderId = "1xai"

// ثابت‌های سازگار با provider پیش‌فرض: نام env از خودِ provider خوانده می‌شود تا
// با تعویض provider (مثلاً openrouter) به‌طور ناخواسته به env یک سرویس دیگر اشاره نکنند.
export const AI_BASE_URL = process.env[DEFAULT_PROVIDER.baseUrlEnv] ?? DEFAULT_PROVIDER.defaultBaseUrl
export const AI_MODEL = process.env[DEFAULT_PROVIDER.modelEnv] ?? DEFAULT_PROVIDER.defaultModel

// حداکثر تلاش: پیشفرض ۳ (اول + ۲ تلاش مجدد)
export const AI_MAX_ATTEMPTS = Math.max(1, Number(process.env.AI_MAX_ATTEMPTS ?? 3))
// تایماوت هر تلاش: پیشفرض ۱۲ ثانیه — جمع تلاشها نباید از محدودیت پلتفرم رد بشه
export const AI_TIMEOUT_MS = resolveTimeoutMs(process.env.AI_TIMEOUT_MS)
// بودجهٔ تلاشِ fallback — عمداً کوچک و محافظه‌کارانه (پیش‌فرض ۱).
// دلیل: بدترین حالت latency نباید ناخواسته «primary × 3 + fallback × 3» شود؛
// سقف fallback جداگانه و صریح است تا این اتفاق بیفتد نه قابل پیش‌بینی.
export const AI_FALLBACK_MAX_ATTEMPTS = Math.max(1, Math.min(2, Number(process.env.AI_FALLBACK_MAX_ATTEMPTS ?? 1)))

// سقف زمانی کل یک عملیات — فقط وقتی fallback فعال است اعمال می‌شود.
//
// چرا مشتق از تنظیمات: اگر عدد ثابتی بود، تغییر AI_MAX_ATTEMPTS/AI_TIMEOUT_MS
// آن را بی‌معنا می‌کرد. مقدار پیش‌فرض = بدترین حالت همهٔ تلاش‌ها + کمی حاشیه
// برای backoff، و با یک سقف سخت محدود می‌شود تا از تایماوت پلتفرم رد نشود.
const OPERATION_TIMEOUT_HARD_MAX_MS = 60_000
const OPERATION_TIMEOUT_BACKOFF_ALLOWANCE_MS = 5_000

export const AI_OPERATION_TIMEOUT_MS = (() => {
    const derived =
        (AI_MAX_ATTEMPTS + AI_FALLBACK_MAX_ATTEMPTS) * AI_TIMEOUT_MS + OPERATION_TIMEOUT_BACKOFF_ALLOWANCE_MS
    const raw = process.env.AI_OPERATION_TIMEOUT_MS
    if (raw === undefined || raw.trim() === "") {
        return Math.min(OPERATION_TIMEOUT_HARD_MAX_MS, derived)
    }
    const parsed = Number(raw)
    if (!Number.isFinite(parsed) || parsed <= 0) {
        // مقدار نامعتبر انگار نشده و به پیش‌فرض مشتق‌شده برمی‌گردد (fail-closed)
        return Math.min(OPERATION_TIMEOUT_HARD_MAX_MS, derived)
    }
    // کف: حداقل یک تلاش کامل باید جا شود، وگرنه fallback هرگز اجرا نمی‌شود
    return Math.max(AI_TIMEOUT_MS, Math.min(OPERATION_TIMEOUT_HARD_MAX_MS, parsed))
})()

export { NonRetryableError, OperationDeadlineError, ProviderUnusableError, RetryableError } from "./providers"
export { isOperationDeadlineError, providerFailurePolicy } from "./providers"
export type { ChatMessage, ProviderFailurePolicy, ProviderId } from "./providers"

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** backoff با jitter — کوتاه نگه داشته شده تا از تایماوت پلتفرم رد نشود */
export const retryBackoffMs = (attemptNumber: number): number =>
    Math.min(300 * 2 ** (attemptNumber - 1), 1500) + Math.random() * 200

/**
 * feature flag fallback — عمداً fail-closed.
 *
 * فقط رشتهٔ دقیق `"true"` آن را روشن می‌کند؛ هر مقدار دیگری (حتی `"TRUE"` یا
 * `"1"`) خاموش است تا فعال‌سازی ناخواستهٔ یک سرویس دوم در production رخ ندهد.
 * در زمان فراخوانی خوانده می‌شود تا قابل تست باشد.
 */
export function isAiFallbackEnabled(): boolean {
    return process.env.AI_ALLOW_FALLBACK === "true"
}

/** یک فراخوانی خام provider — بدون parse/اعتبارسنجی و بدون fallback. */
export async function fetchProviderRaw(messages: ChatMessage[]): Promise<string> {
    const config = DEFAULT_PROVIDER.resolveConfig({ timeoutMs: AI_TIMEOUT_MS })
    return DEFAULT_PROVIDER.complete(config, messages)
}

/** نتیجهٔ یک عملیات AI: محتوای خام + provider مؤثر + شمار تلاش‌ها. */
export interface AiOperationResult<T = string> {
    /** خروجی نهایی پس از transform (در نبود آن، همان محتوای خام). */
    value: T
    /** محتوای خام provider — فقط در حافظه، هرگز persist نمی‌شود. */
    content: string
    /** provider‌ای که واقعاً پاسخ را داد — برای observability، نه برای UI. */
    providerId: ProviderId
    /** مجموع provider callهای انجام‌شده تا موفقیت. */
    attempts: number
    fallbackUsed: boolean
}

interface ProviderChainEntry {
    id: ProviderId
    maxAttempts: number
}

/** زنجیرهٔ providerهای این عملیات — قطعی، کوتاه و همیشه با primary شروع. */
function resolveProviderChain(allowFallback: boolean): ProviderChainEntry[] {
    const chain: ProviderChainEntry[] = [
        { id: DEFAULT_PROVIDER.id, maxAttempts: AI_MAX_ATTEMPTS },
    ]
    if (!allowFallback) return chain

    // fallback فقط وقتی واقعاً در دسترسم باشد وارد زنجیره می‌شود؛ نبودِ کلیدِ
    // آن نباید هیچ اثری روی رفتار primary بگذارد.
    if (getProvider(FALLBACK_PROVIDER_ID).isConfigured()) {
        chain.push({ id: FALLBACK_PROVIDER_ID, maxAttempts: AI_FALLBACK_MAX_ATTEMPTS })
    }
    return chain
}

/**
 * یک «logical AI operation» را اجرا می‌کند: ابتدا provider اصلی با بودجهٔ retry
 * خودش، و فقط پس از تمام‌شدن آن، provider بعدی (در صورت فعال‌بودن fallback).
 *
 * caller فقط یک‌بار این را صدا می‌زند؛ reserve/complete/release در route و
 * بیرون از این ماژول است، پس هر تعداد provider call همچنان یک واحد سهمیه است.
 *
 * تفکیک عمدیِ دو نوع خطا (این مرز نباید جابه‌جا شود):
 * - خطای transport (Retryable/NonRetryable/ProviderUnusable) → سیاست fallback.
 * - خطای parse/اعتبارسنجی → فقط retry همان provider، **هرگز** fallback. پس
 *   fallback به لایهٔ parse منتقل نمی‌شود و prompt/schema دو بار طراحی نمی‌شوند.
 */
export async function runAiOperation<T = string>(options: {
    /** پیام‌ها برای هر تلاش ساخته می‌شوند تا تشدید prompt ممکن باشد. */
    buildMessages: (attemptNumber: number) => ChatMessage[]
    /** تبدیل محتوای خام به خروجی نهایی (parse/schema). خطای آن = retry بدون fallback. */
    transform?: (content: string) => T
    /** اجازهٔ استفاده از fallback در این فراخوانی (پیش‌فرض: وضعیت flag). */
    allowFallback?: boolean
}): Promise<AiOperationResult<T>> {
    const allowFallback = options.allowFallback ?? isAiFallbackEnabled()
    const chain = resolveProviderChain(allowFallback)

    // سقف زمانی کل عملیات فقط وقتی اعمال می‌شود که fallback واقعاً در زنجیره باشد.
    // با پیش‌فرض فعلی (fallback خاموش) این کد اصلاً اجرا نمی‌شود تا semantics
    // مسیر primary بی‌دلیل تغییر نکند.
    const deadlineController = chain.length > 1 ? new AbortController() : null
    const deadlineTimer =
        deadlineController !== null
            ? setTimeout(() => deadlineController.abort(), AI_OPERATION_TIMEOUT_MS)
            : null

    let lastError: unknown = null
    /** خطای آخرین تلاشِ provider اصلی — خطایی که در نهایت به caller می‌رود. */
    let primaryError: unknown = null
    let totalAttempts = 0
    /**
     * پایان زنجیره به‌خاطر خطای غیرtransport (parse/schema).
     *
     * `break` داخل حلقهٔ تلاش‌ها فقط همان provider را می‌بندد، نه کل زنجیره را؛ پس
     * بدون این پرچم، provider بعدی (پولی) باز هم صدا زده می‌شد. یعنی این دقیقاً
     * همان باگی است که fix شد: قبلاً `continue` باعث می‌شد بعد از تمام‌شدن retryهای
     * primary، fallback اجرا شود.
     */
    let stopChain = false

    try {
        for (const [providerIndex, entry] of chain.entries()) {
            const provider = getProvider(entry.id)
            const isFallback = providerIndex > 0

            for (let attemptNumber = 1; attemptNumber <= entry.maxAttempts; attemptNumber++) {
                // سقف کل تمام شده → هیچ provider دیگری (حتی fallback) صدا زده نمی‌شود.
                if (deadlineController?.signal.aborted) {
                    throw new OperationDeadlineError()
                }

                // شمارهٔ تلاش برای هر provider از ۱ شروع می‌شود: provider fallback
                // هنوز پاسخ بدی نداده، پس نباید با prompt سخت‌گیرانه شروع کند.
                const localAttempt = attemptNumber
                try {
                    const config = provider.resolveConfig({ timeoutMs: AI_TIMEOUT_MS })
                    // یک `provider.complete()` = یک واحد. شمارش **قبل** از فراخوانی
                    // انجام می‌شود تا `attempts` معنای «تعداد واقعی provider call»
                    // را داشته باشد، نه «تعداد استثنا» و نه «تعداد تصمیم retry».
                    // (شمارش دوم در catch یا error را دوبار می‌شمرد، یا در خطای
                    // `resolveConfig`/`buildMessages` اصلاً شمارش نمی‌کرد.)
                    totalAttempts++
                    const content = await provider.complete(
                        config,
                        options.buildMessages(localAttempt),
                        { signal: deadlineController?.signal },
                    )
                    const value = options.transform ? options.transform(content) : (content as unknown as T)
                    return {
                        value,
                        content,
                        providerId: entry.id,
                        attempts: totalAttempts,
                        fallbackUsed: isFallback,
                    }
                } catch (error) {
                    lastError = error
                    if (!isFallback) primaryError = error

                    // سقف کل تمام شده: نه retry، نه fallback. زودتر از policy
                    // transport بررسی می‌شود چون یک AbortError معمولی هم retryable است.
                    if (isOperationDeadlineError(error) || deadlineController?.signal.aborted) {
                        throw new OperationDeadlineError()
                    }

                    // خطای parse/اعتبارسنجی، خطای transport نیست: نه retry به
                    // provider بعدی، نه throw کردن زودهنگام. retry همان provider تا
                    // سقف سیاست انجام می‌شود، و `break` زنجیره را **همین‌جا** تمام
                    // می‌کند تا provider بعدی (پولی/دیگر) اصلاً صدا زده نشود.
                    //
                    // چرا این مرز: وقتی HTTP 200 گرفته شده و فقط parse شکست خورده،
                    // مشکل از سرویس نیست؛ provider دوم همان schema را نمی‌خواند و
                    // فقط پول/تأخیر تازه اضافه می‌کند. در پایان هم `primaryError`
                    // پرتاب می‌شود ⇒ خطای نهایی همان parse error است.
                    const isTransportError =
                        error instanceof RetryableError ||
                        error instanceof NonRetryableError ||
                        error instanceof ProviderUnusableError
                    if (!isTransportError) {
                        if (attemptNumber < entry.maxAttempts) {
                            await sleep(retryBackoffMs(attemptNumber))
                            continue
                        }
                        // retryهای همین provider تمام شد ⇒ کل زنجیره متوقف می‌شود
                        stopChain = true
                        break
                    }

                    const policy = providerFailurePolicy(error)

                    // خطای قطعیِ خود درخواست: نه retry، نه fallback.
                    if (policy === "fatal") throw error

                    // این provider در این عملیات غیرقابل‌استفاده است → مستقیم بعدی.
                    if (policy === "unusable") break

                    if (attemptNumber < entry.maxAttempts) {
                        await sleep(retryBackoffMs(attemptNumber))
                    }
                }
            }

            if (stopChain) break
        }
    } finally {
        // timer همیشه پاک می‌شود، حتی در throw → بدون leak در مسیر خطا.
        if (deadlineTimer !== null) clearTimeout(deadlineTimer)
    }

    // وقتی همه providerها شکست خوردند، خطای **primary** برگردانده می‌شود، نه خطای
    // آخرین provider. دلیل: متن خطا همان چیزی می‌ماند که امروز بدون fallback دیده
    // می‌شود، پس روشن‌کردن flag هیچ‌گاه قرارداد خطا/لاگ را بی‌صدا عوض نمی‌کند و
    // alerting روی سرویس اصلی همچنان درست کار می‌کند.
    throw primaryError ?? lastError ?? new Error("AI provider unavailable")
}
