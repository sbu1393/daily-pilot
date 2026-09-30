// quotaError — تشخیص خطای دامنه‌ای «سهمیهٔ هوش مصنوعی تمام شد» (سمت کلاینت)
//
// تنها معیار، خودِ code است — عمداً status=429 به‌تنهایی کافی نیست، چون
// RATE_LIMITED هم 429 است ولی سهمیه نیست و باید رفتار خطای عادی خودش را حفظ کند.
// هیچ محاسبهٔ quota و هیچ عددی اینجا نیست: فقط یک بررسی‌کنندهٔ pure روی خطای API.

import { ApiClientError } from "./client"

export function isQuotaExceeded(error: unknown): boolean {
    return error instanceof ApiClientError && error.code === "QUOTA_EXCEEDED"
}
