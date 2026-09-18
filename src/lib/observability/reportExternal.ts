// فاز ۲ — گام ۵: مرز external reporter (سند فاز ۲ §21) — فقط seam، بدون هیچ vendor.
//
// قواعد سند §21:
// - ورودی از قبل normalized و redacted است؛ adapter **هرگز** `Error` خام نمی‌بیند.
// - adapter خودش هیچ فرض privacy ای انجام نمی‌دهد (همه‌چیز پیش از رسیدن به آن redact شده است).
// - شکست adapter swallow می‌شود (fail-open) و هرگز مسیر درخواست را نمی‌شکند.
// - external reporting اختیاری است.
//
// فاز ۲:
// - هیچ Sentry/GlitchTip/PostHog و هیچ SDK/vendor دیگری وجود ندارد.
// - هیچ network call انجام نمی‌شود؛ پیاده‌سازی پیش‌فرض no-op است.
// - هیچ persistence دوباره‌ای انجام نمی‌دهد و هیچ چیزی در ErrorLog نمی‌نویسد (§14).
//
// توجه: این تابع عمداً await نمی‌شود تا هیچ درخواستی روی adapter آینده بلاک نشود
// (سند §29: «do not block the request on external vendor»)؛ شکست آن هم swallow می‌شود.

import type { NormalizedErrorRecord } from "./normalizeError"
import type { ObservabilityContext } from "./types"

/**
 * ورودی adapter آینده — فقط داده‌ی امن:
 * رکورد normalized+redacted و شناسه‌های correlation سطح‌بالا.
 * (هیچ `Error` خام، هیچ request/body/prompt و هیچ credential ای این‌جا نیست.)
 */
export interface ExternalReportPayload {
    readonly record: NormalizedErrorRecord
    readonly requestId: string
    readonly endpoint: string
    readonly feature?: string
    readonly userId?: number
}

/** adapter آینده (مثلاً Sentry/GlitchTip) — در فاز ۲ هیچ پیاده‌سازی vendori وجود ندارد. */
export type ExternalErrorReporter = (payload: ExternalReportPayload) => void | Promise<void>

/** پیش‌فرض فاز ۲ — هیچ کاری نمی‌کند (بدون network، بدون dependency). */
export const noopExternalReporter: ExternalErrorReporter = () => {}

let activeReporter: ExternalErrorReporter = noopExternalReporter

/**
 * ثبت adapter آینده در bootstrap (اختیاری).
 * `null` → بازگشت به no-op. هیچ وابستگی خارجی اضافه نمی‌کند.
 */
export function setExternalReporter(next: ExternalErrorReporter | null): void {
    activeReporter = next ?? noopExternalReporter
}

/** adapter فعال فعلی — برای تست/تشخیص؛ در فاز ۲ همیشه no-op است مگر صریحاً ست شود. */
export function getExternalReporter(): ExternalErrorReporter {
    return activeReporter
}

/**
 * reportExternal — عبور رکورد normalize+redactشده از مرز adapter.
 *
 * - Fail-open مطلق: هر throw/rejection (sync یا async) بی‌صدا swallow می‌شود.
 * - بدون retry، بدون transaction، بدون persistence دوباره و بدون هیچ network call در فاز ۲.
 * - اگر adapter یک Promise برگرداند، rejection آن گرفته می‌شود (بدون unhandledRejection)
 *   و await نمی‌شود تا مسیر درخواست بلاک نشود.
 */
export function reportExternal(
    record: NormalizedErrorRecord,
    context: ObservabilityContext,
): void {
    try {
        const payload: ExternalReportPayload = {
            record,
            requestId: context.requestId,
            endpoint: context.endpoint,
            ...(context.feature !== undefined ? { feature: context.feature } : {}),
            ...(context.userId !== undefined ? { userId: context.userId } : {}),
        }

        const maybePromise = activeReporter(payload)
        if (maybePromise && typeof (maybePromise as Promise<void>).catch === "function") {
            void (maybePromise as Promise<void>).catch(() => {
                // fail-open — شکست adapter آینده هرگز به مسیر درخواست نمی‌رسد
            })
        }
    } catch {
        // fail-open — حتی adapter شکسته هم request را نمی‌شکند
    }
}
