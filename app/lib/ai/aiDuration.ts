// مرحلهٔ ۴.۲ — instrumentation اندازه‌گیری «logical AI operation»
// ------------------------------------------------------------------
// تنها چیزی که این ماژول اضافه می‌کند، مدت واقعی یک عملیات AI و تعداد
// provider callهای آن است. هیچ رفتار، تصمیم retry/fallback، متن یا پاسخی
// را تغییر نمی‌دهد.
//
// سه قاعدهٔ غیرقابل‌شکستن:
// 1) Fail-Open — خراب‌شدن اندازه‌گیری هرگز نباید مسیر AI را خراب کند.
//    هر خواندن ساعت و هر نوشتن/خواندن telemetry در try/catch است؛ نتیجهٔ
//    هر خطا «نداشتن داده» است، نه throw. instrumentation هرگز نمی‌تواند
//    علت اصلی شکست را بپوشاند یا آن را به شکست تبدیل کند.
// 2) بدون محتوا — فقط یک عدد (میلی‌ثانیه) و یک شمارنده. prompt، پاسخ
//    provider، عنوان تسک، عنوان کارها و هر دادهٔ کاربری از این ماژول
//    عبور نمی‌کند و اصلاً پارامتری برایشان وجود ندارد.
// 3) بدون migration — مقصد نوشتن فقط ستون‌های از قبل موجود
//    `AiUsageEvent.durationMs` و `AiUsageEvent.attempts` است.
//
// چرا WeakMap و نه یک property روی خطا:
// قرارداد عمومی خطا باید byte-for-byte دست‌نخورده بماند. اگر metadata
// روی خودِ error بنشیند، هر مسیری که بعداً خطا را serialize کند
// (recordError، پاسخ HTTP، لاگ) می‌تواند آن را ناخواسته منتشر کند.
// WeakMap داده را از خودِ شیء جدا نگه می‌دارد و با garbage collection
// همراه خطا آزاد می‌شود، پس نشتی هم ندارد.

/** ساعت مونوتونیک — دلیل انتخاب در گزارش Stage 4.2. */
const monotonicNow = (): number => {
    // `performance.now()` در Node 16+ و در runtime فعلی این پروژه موجود است و
    // نسبت به `Date.now()` در برابر تغییر/تنظیم مجدد ساعت سیستم مقاوم است
    // (NTP jump می‌تواند Date.now() را عقب ببرد و duration را منفی کند).
    // دسترسی از `globalThis` تا به هیچ type declaration وابسته نباشد.
    const perf = (globalThis as { performance?: { now?: unknown } }).performance
    if (perf && typeof perf.now === "function") return (perf.now as () => number)()
    return Date.now()
}

/** metadیتای امن یک عملیات AI — فقط عدد، بدون هیچ محتوایی. */
export interface AiCallTelemetry {
    /** مدت واقعی عملیات AI به میلی‌ثانیه؛ شامل همهٔ تلاش‌ها و backoffها. */
    durationMs: number
    /**
     * تعداد واقعی provider callها — فقط وقتی عملیات به پایان قطعی رسیده و
     * شمارنده در دسترس بوده باشد. نبودنش یعنی «اندازه‌گیری نشد»، نه صفر.
     */
    attempts?: number
}

/** تابع پایان‌دهنده: شمارندهٔ نهایی را می‌گیرد و metadیتا را برمی‌گرداند. */
export type StopAiCallTimer = (attempts?: number) => AiCallTelemetry | undefined

/** یک عدد نامعتبر (NaN / Infinity / منفی) هرگز به DB نمی‌رود. */
const isUsableMs = (value: number): boolean => Number.isFinite(value) && value >= 0

/**
 * شروع اندازه‌گیری یک عملیات AI.
 *
 * الگوی استفاده (دقیقاً همان چیزی که خواسته شده):
 * ```
 * const stop = startAiCallTimer()
 * const result = await runAiOperation(...)
 * const telemetry = stop(result.attempts)
 * ```
 * و در مسیر خطا، `stop()` بدون آرگومان (شمارنده در دسترس نیست) — مدت
 * همچنان درست اندازه‌گیری می‌شود چون خودِ عملیات تمام شده است.
 */
export function startAiCallTimer(): StopAiCallTimer {
    let startedAt: number | null = null
    try {
        const value = monotonicNow()
        startedAt = isUsableMs(value) ? value : null
    } catch {
        // قاعدهٔ ۱: ساعت در دسترس نبود → بدون instrumentation ادامه می‌دهیم
        startedAt = null
    }

    return (attempts?: number) => {
        if (startedAt === null) return undefined
        let elapsed: number
        try {
            elapsed = monotonicNow() - startedAt
        } catch {
            return undefined
        }
        if (!isUsableMs(elapsed)) return undefined
        const durationMs = Math.round(elapsed)
        const usableAttempts =
            attempts !== undefined && Number.isFinite(attempts) && attempts >= 1
                ? Math.round(attempts)
                : undefined
        return {
            durationMs,
            ...(usableAttempts !== undefined ? { attempts: usableAttempts } : {}),
        }
    }
}

/**
 * نگه‌داری metadیتای عملیات روی یک شیء (معمولاً خطا) بدون تغییر آن.
 *
 * برای مسیر شکست لازم است: route خطا را catch می‌کند و باید مدت را کنار
 * `failureCode` بنویسد، در حالی که خودِ خطا نباید هیچ فیلد جدیدی بگیرد.
 * اگر telemetry در دسترس نباشد، شیء **دست‌نخورده** برگردانده می‌شود.
 */
const FACTS = new WeakMap<object, AiCallTelemetry>()

export function attachAiCallTelemetry<T>(target: T, telemetry: AiCallTelemetry | undefined): T {
    try {
        if (
            telemetry !== undefined &&
            telemetry !== null &&
            isUsableMs(telemetry.durationMs) &&
            typeof target === "object" &&
            target !== null
        ) {
            FACTS.set(target, telemetry)
        }
    } catch {
        // قاعدهٔ ۱: instrumentation هرگز throw نمی‌کند
    }
    return target
}

/** خواندن metadیتای عملیات از یک خطا/شیء — `undefined` یعنی «اندازه‌گیری نشد». */
export function readAiCallTelemetry(target: unknown): AiCallTelemetry | undefined {
    try {
        if (target === null || typeof target !== "object") return undefined
        return FACTS.get(target)
    } catch {
        return undefined
    }
}
