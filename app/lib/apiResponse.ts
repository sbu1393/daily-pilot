import { NextResponse } from "next/server"
import { ServiceError, toServiceErrorBody } from "@/app/lib/services/errors"

// فاز صفر Observability — اگر requestId ارائه شود، به‌صورت per-response روی شیء NextResponse
// ست می‌شود (بدون next.config.js). در غیاب requestId رفتار دقیقاً مانند قبل است.
function withRequestId(response: NextResponse, requestId?: string): NextResponse {
    if (requestId) response.headers.set("X-Request-ID", requestId)
    return response
}

// G-12/A6 — Envelope موفقیت (ADR-04): { ok: true, data, message? }
export function okResponse(
    data: unknown,
    init?: { message?: string; status?: number; requestId?: string },
): NextResponse {
    const body: Record<string, unknown> = { ok: true, data }
    if (init?.message != null) body.message = init.message
    return withRequestId(
        NextResponse.json(body, { status: init?.status ?? 200 }),
        init?.requestId,
    )
}

// پاسخ موفق بدون داده (فقط پیام): { ok: true, message }
export function okMessageResponse(message: string, status = 200, requestId?: string): NextResponse {
    return withRequestId(NextResponse.json({ ok: true, message }, { status }), requestId)
}

// ---- A6: Envelope خطا (ADR-04): { ok:false, error:{ code, message, errors? } } ----
export function errorResponse(
    status: number,
    code: string,
    message: string,
    errors?: unknown,
    requestId?: string,
): NextResponse {
    const body: Record<string, unknown> = { ok: false, error: { code, message } }
    if (errors !== undefined) (body.error as Record<string, unknown>).errors = errors
    return withRequestId(NextResponse.json(body, { status }), requestId)
}

export function unauthorizedResponse(requestId?: string): NextResponse {
    return errorResponse(401, "UNAUTHORIZED", "Unauthorized", undefined, requestId)
}

export function validationErrorResponse(
    errors: unknown,
    message = "اطلاعات نامعتبر است",
    requestId?: string,
): NextResponse {
    return errorResponse(400, "VALIDATION_ERROR", message, errors, requestId)
}

// نگاشت ServiceError → Envelope خطا (بدنه‌ی خالص در errors.ts قابل تست است)
export function toServiceErrorResponse(error: unknown, requestId?: string): NextResponse | null {
    if (!(error instanceof ServiceError)) return null
    const body = toServiceErrorBody(error)
    return withRequestId(NextResponse.json(body, { status: error.status }), requestId)
}