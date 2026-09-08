import { NextResponse } from "next/server"
import { ServiceError, toServiceErrorBody } from "@/app/lib/services/errors"

// G-12/A6 — Envelope موفقیت (ADR-04): { ok: true, data, message? }
export function okResponse(
    data: unknown,
    init?: { message?: string; status?: number },
): NextResponse {
    const body: Record<string, unknown> = { ok: true, data }
    if (init?.message != null) body.message = init.message
    return NextResponse.json(body, { status: init?.status ?? 200 })
}

// پاسخ موفق بدون داده (فقط پیام): { ok: true, message }
export function okMessageResponse(message: string, status = 200): NextResponse {
    return NextResponse.json({ ok: true, message }, { status })
}

// ---- A6: Envelope خطا (ADR-04): { ok:false, error:{ code, message, errors? } } ----
export function errorResponse(
    status: number,
    code: string,
    message: string,
    errors?: unknown,
): NextResponse {
    const body: Record<string, unknown> = { ok: false, error: { code, message } }
    if (errors !== undefined) (body.error as Record<string, unknown>).errors = errors
    return NextResponse.json(body, { status })
}

export function unauthorizedResponse(): NextResponse {
    return errorResponse(401, "UNAUTHORIZED", "Unauthorized")
}

export function validationErrorResponse(
    errors: unknown,
    message = "اطلاعات نامعتبر است",
): NextResponse {
    return errorResponse(400, "VALIDATION_ERROR", message, errors)
}

// نگاشت ServiceError → Envelope خطا (بدنه‌ی خالص در errors.ts قابل تست است)
export function toServiceErrorResponse(error: unknown): NextResponse | null {
    if (!(error instanceof ServiceError)) return null
    const body = toServiceErrorBody(error)
    return NextResponse.json(body, { status: error.status })
}