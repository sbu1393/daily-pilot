// A6 — سرویس‌گیرنده‌ی مرکزی API (ADR-04)
// قرارداد: موفقیت { ok, data } — خطا { ok:false, error:{ code, message, errors? } }
// خروجی: json.data (تیپ‌دار). در صورت !res.ok یک ApiClientError با message و code پرتاب می‌کند.
// Transition-friendly: اگر سرور error.code ندهد، از message قدیمی استفاده می‌شود.
// Phase 2B (M6): init.signal به fetch می‌رسد — لغو عمدی به‌صورت AbortError خام به callee می‌رسد.

export class ApiClientError extends Error {
    readonly code: string
    readonly status: number
    readonly errors?: unknown

    constructor(status: number, code: string, message: string, errors?: unknown) {
        super(message)
        this.name = "ApiClientError"
        this.code = code
        this.status = status
        this.errors = errors
    }
}

/**
 * Phase 2B (M6) — لغو درخواست: سیگنال به fetch عبور داده می‌شود (RequestInit قبلاً این را دارد).
 * اگر لغو شود، AbortError خام پرتاب می‌شود تا callee (مثلاً useDaySummary) بتواند لغو عمدی
 * خودش را از خطای واقعی شبکه تشخیص دهد — این لایه آن را قورت نمی‌دهد.
 */
export async function api<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init)

    // خطای لغو هنگام خواندن بدنه (بدنه هنوز دریافت نشده) هم باید بهcallee برسد
    const json = (await res.json().catch((e: unknown) => {
        if (typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError") throw e
        return {}
    })) as {
        data?: T
        error?: { code?: string; message?: string; errors?: unknown }
        message?: string
    }

    if (!res.ok) {
        const error = json.error
        throw new ApiClientError(
            res.status,
            error?.code ?? "UNKNOWN_ERROR",
            error?.message ?? json.message ?? `درخواست ناموفق بود (${res.status})`,
            error?.errors,
        )
    }

    return json.data as T
}