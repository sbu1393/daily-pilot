// فاز ۲ — گام ۵: نگاشت deterministic severity → console level (سند فاز ۲ §16 — A5)
//
// §16 برای structured console fallback فیلد `level` را الزام می‌کند. مقدار آن deterministic
// و مشتق از همان مدل severity/category موجود است (هیچ مقدار hard-code شده‌ی محیطی یا
// per-call نیست) تا payload هم‌شکل و قابل پارس/فیلتر بماند.

import type { ErrorSeverity } from "./types"

/** نگاشت قطعی severity → level. کلیدهای ناشناخته → "error" (پیش‌فرض امن §12 فاز ۰). */
const SEVERITY_TO_LEVEL: Record<ErrorSeverity, string> = {
    INFO: "info",
    WARNING: "warn",
    ERROR: "error",
    CRITICAL: "critical",
}

/**
 * severityToConsoleLevel — level ساختاریافته برای payload لاگ.
 * ورودی نامعتبر/ناشناخته → "error" (حداکثر محافظه‌کارانه؛ هرگز چیزی را پنهان نمی‌کند).
 */
export function severityToConsoleLevel(severity: unknown): string {
    if (typeof severity === "string" && severity in SEVERITY_TO_LEVEL) {
        return SEVERITY_TO_LEVEL[severity as ErrorSeverity]
    }
    return SEVERITY_TO_LEVEL.ERROR
}
