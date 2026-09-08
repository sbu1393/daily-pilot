// A6 — سرویس‌گیرنده‌ی مرکزی API (ADR-04)
// قرارداد: موفقیت { ok, data } — خطا { ok:false, error:{ code, message, errors? } }
// خروجی: json.data (تیپ‌دار). در صورت !res.ok یک ApiClientError با message و code پرتاب می‌کند.
// Transition-friendly: اگر سرور error.code ندهد، از message قدیمی استفاده می‌شود.

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

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(url, init)

    const json = (await res.json().catch(() => ({}))) as {
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