// فاز صفر Observability — کارخانه‌ی Context
// تولید requestId فقط سمت سرور و با ماژول استاندارد crypto انجام می‌شود
// (بدون uuid خارجی؛ بدون AsyncLocalStorage/Middleware — محدودیت سند فاز صفر).

import { randomUUID } from "crypto"

import type { ObservabilityContext } from "./types"

/**
 * یک ObservabilityContext تازه برای یک درخواست می‌سازد.
 * فقط در سمت سرور (Route Handler / Service) فراخوانی شود.
 * userId پس از احرازهویت توسط caller ست می‌شود: context.userId = user.id
 */
export function createObservabilityContext(
    endpoint: string,
    feature?: string,
): ObservabilityContext {
    const context: ObservabilityContext = {
        requestId: randomUUID(),
        endpoint,
    }
    if (feature !== undefined) {
        context.feature = feature
    }
    return context
}
