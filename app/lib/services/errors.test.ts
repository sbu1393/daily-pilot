import { describe, expect, it } from "vitest"
import {
    EmailTakenError,
    EntitlementConflictError,
    InvalidCredentialsError,
    MissingDayKeyError,
    NoRolloverCandidatesError,
    OverdueTaskError,
    PaymentConfigurationError,
    PaymentIdempotencyConflictError,
    PaymentInvalidAmountError,
    PaymentNotFoundError,
    PaymentProviderInvalidResponseError,
    PaymentProviderRejectedError,
    PaymentProviderUnavailableError,
    PaymentStateUnresolvedError,
    PaymentVerificationFailedError,
    SamePasswordError,
    ServiceError,
    TaskAlreadyDoneError,
    TaskNotAnalyzeableError,
    TaskNotFoundError,
    UserNotFoundError,
    UsernameTakenError,
    WrongPasswordError,
    toServiceErrorBody,
    toServiceErrorFromInfrastructure,
} from "./errors"

// A6 — بدنه‌ی خالص Envelope خطای ADR-04: { ok:false, error:{ code, message, errors? } }

describe("toServiceErrorBody (A6 error envelope)", () => {
    it("returns null for non-ServiceError values", () => {
        expect(toServiceErrorBody(new Error("x"))).toBeNull()
        expect(toServiceErrorBody("boom")).toBeNull()
        expect(toServiceErrorBody(null)).toBeNull()
    })

    it("maps task errors to stable codes with preserved messages", () => {
        expect(toServiceErrorBody(new TaskNotFoundError())).toEqual({
            ok: false,
            error: { code: "TASK_NOT_FOUND", message: "تسک پیدا نشد" },
        })
        expect(toServiceErrorBody(new MissingDayKeyError())).toEqual({
            ok: false,
            error: { code: "MISSING_DAY_KEY", message: "تاریخ برنامه‌ریزی تسک نامعتبر است" },
        })
        expect(toServiceErrorBody(new TaskAlreadyDoneError())).toEqual({
            ok: false,
            error: { code: "TASK_ALREADY_DONE", message: "این تسک قبلاً تمام شده است" },
        })
        expect(toServiceErrorBody(new TaskNotAnalyzeableError("DONE"))).toEqual({
            ok: false,
            error: {
                code: "TASK_NOT_ANALYZEABLE",
                message: "تسک انجام‌شده را نمی‌توان دوباره تحلیل کرد",
            },
        })
        expect(toServiceErrorBody(new OverdueTaskError())?.error.code).toBe("OVERDUE_TASK")
        expect(toServiceErrorBody(new NoRolloverCandidatesError())?.error.code).toBe(
            "NO_ROLLOVER_CANDIDATES",
        )
    })

    it("maps auth errors to stable codes", () => {
        expect(toServiceErrorBody(new EmailTakenError())?.error.code).toBe("EMAIL_TAKEN")
        expect(toServiceErrorBody(new InvalidCredentialsError())?.error.code).toBe(
            "INVALID_CREDENTIALS",
        )
        expect(toServiceErrorBody(new UserNotFoundError())?.error.code).toBe("USER_NOT_FOUND")
        expect(toServiceErrorBody(new WrongPasswordError())?.error.code).toBe("WRONG_PASSWORD")
        expect(toServiceErrorBody(new SamePasswordError())?.error.code).toBe("SAME_PASSWORD")
        expect(toServiceErrorBody(new UsernameTakenError())?.error.code).toBe("USERNAME_TAKEN")
    })

    it("preserves the errors detail field when present", () => {
        const err = new ServiceError(400, "VALIDATION_ERROR", "اطلاعات نامعتبر است", {
            fieldErrors: { text: ["کوتاه است"] },
        })
        expect(toServiceErrorBody(err)).toEqual({
            ok: false,
            error: {
                code: "VALIDATION_ERROR",
                message: "اطلاعات نامعتبر است",
                errors: { fieldErrors: { text: ["کوتاه است"] } },
            },
        })
    })
})

/* ------------------------------------------------------------------ */
/* E1 — نگاشت زیرساخت خطاهای شناخته‌شده‌ی Prisma (مرز §9.11):            */
/* P2002 → 409 CONFLICT و P2025 → 404 NOT_FOUND طبق §9.3/§9.4؛          */
/* تشخیص فقط با duck-typing روی error.code (بدون import از Prisma).    */
/* خطای ناشناخته → null تا مسیر 500 عمومی بدون تغییر بماند.            */
/* ------------------------------------------------------------------ */

describe("toServiceErrorFromInfrastructure (E1 — §9.11 Prisma boundary)", () => {
    it("maps a duck-typed Prisma P2002 unique violation to 409 CONFLICT", () => {
        const infra = toServiceErrorFromInfrastructure({ code: "P2002", meta: { target: ["email"] } })
        expect(infra).toBeInstanceOf(ServiceError)
        expect(infra?.status).toBe(409)
        expect(infra?.code).toBe("CONFLICT")
    })

    it("maps a duck-typed Prisma P2025 record-not-found to 404 NOT_FOUND", () => {
        const infra = toServiceErrorFromInfrastructure({ code: "P2025" })
        expect(infra).toBeInstanceOf(ServiceError)
        expect(infra?.status).toBe(404)
        expect(infra?.code).toBe("NOT_FOUND")
    })

    it("returns null for unknown Prisma-like codes, missing codes, and non-object values", () => {
        expect(toServiceErrorFromInfrastructure({ code: "P1001" })).toBeNull()
        expect(toServiceErrorFromInfrastructure({ message: "no code here" })).toBeNull()
        expect(toServiceErrorFromInfrastructure({ code: 2002 })).toBeNull()
        expect(toServiceErrorFromInfrastructure("boom")).toBeNull()
        expect(toServiceErrorFromInfrastructure(null)).toBeNull()
        expect(toServiceErrorFromInfrastructure(undefined)).toBeNull()
    })

    it("never exposes raw Prisma details through the ADR-04 envelope", () => {
        const body = toServiceErrorBody({ code: "P2002", meta: { target: ["email"] }, clientVersion: "6.x" })
        expect(body).toEqual({
            ok: false,
            error: { code: "CONFLICT", message: "این مقدار قبلاً ثبت شده است" },
        })
        expect(body?.error).not.toHaveProperty("meta")
        expect(body?.error).not.toHaveProperty("clientVersion")
        expect(JSON.stringify(body)).not.toContain("email")
    })
})

/* ------------------------------------------------------------------ */
/* فاز ۵ — نگاشت خطاهای billing/entitlement (سند فاز ۵ §۲۰/§۲۱):        */
/* قرارداد بسته‌ی taxonomy: هر کلاس دقیقاً یک code/status/category دارد   */
/* و از envelope امن ADR-04 عبور می‌کند (بدون داده‌ی provider/DB).        */
/* ------------------------------------------------------------------ */

type Phase5Case = {
    name: string
    error: ServiceError
    status: number
    code: string
    category: string | undefined
    severity: string | undefined
}

const phase5 = (name: string, error: ServiceError): Phase5Case => ({
    name,
    error,
    status: error.status,
    code: error.code,
    category: error.category,
    severity: error.severity,
})

/** کد/status/category/severity دقیقاً طبق سند §۲۰/§۲۱. */
const EXPECTED_PHASE_5: readonly [string, ServiceError, number, string, string | undefined, string | undefined][] = [
    ["PaymentProviderUnavailableError", new PaymentProviderUnavailableError(), 503, "PAYMENT_PROVIDER_UNAVAILABLE", "EXTERNAL_SERVICE", "ERROR"],
    ["PaymentProviderRejectedError", new PaymentProviderRejectedError(), 503, "PAYMENT_PROVIDER_REJECTED", "EXTERNAL_SERVICE", "ERROR"],
    ["PaymentProviderInvalidResponseError", new PaymentProviderInvalidResponseError(), 503, "PAYMENT_PROVIDER_INVALID_RESPONSE", "EXTERNAL_SERVICE", "ERROR"],
    ["PaymentStateUnresolvedError", new PaymentStateUnresolvedError(), 503, "PAYMENT_STATE_UNRESOLVED", "EXTERNAL_SERVICE", "ERROR"],
    ["PaymentVerificationFailedError", new PaymentVerificationFailedError(), 402, "PAYMENT_VERIFICATION_FAILED", "EXTERNAL_SERVICE", "ERROR"],
    ["PaymentInvalidAmountError", new PaymentInvalidAmountError(), 409, "PAYMENT_INVALID_AMOUNT", "CONFLICT", "CRITICAL"],
    ["PaymentConfigurationError", new PaymentConfigurationError(), 500, "PAYMENT_CONFIGURATION_ERROR", "INTERNAL", "CRITICAL"],
    ["PaymentIdempotencyConflictError", new PaymentIdempotencyConflictError(), 409, "PAYMENT_IDEMPOTENCY_CONFLICT", "CONFLICT", "INFO"],
    ["EntitlementConflictError", new EntitlementConflictError(), 409, "ENTITLEMENT_CONFLICT", "CONFLICT", "WARNING"],
    ["PaymentNotFoundError", new PaymentNotFoundError(), 404, "PAYMENT_NOT_FOUND", undefined, undefined],
]

const PHASE_5_ERRORS: readonly Phase5Case[] = EXPECTED_PHASE_5.map(([name, error]) => phase5(name, error))

describe("Phase 5 error mapping (§20/§21 — closed taxonomy)", () => {
    it.each(EXPECTED_PHASE_5)(
        "%s declares status/code/category/severity from the closed taxonomy",
        (name, error, status, code, category, severity) => {
            expect(error).toBeInstanceOf(ServiceError)
            expect(error.name).toBe(name)
            expect({ status: error.status, code: error.code, category: error.category, severity: error.severity }).toEqual({
                status,
                code,
                category,
                severity,
            })
        },
    )

    it("keeps provider create/verify failures as distinct codes (never collapsed into VERIFICATION_FAILED)", () => {
        const codes = PHASE_5_ERRORS.map((c) => c.code)
        expect(new Set(codes).size).toBe(codes.length)
        expect(codes).toContain("PAYMENT_PROVIDER_REJECTED")
        expect(codes).toContain("PAYMENT_PROVIDER_INVALID_RESPONSE")
        expect(codes).toContain("PAYMENT_STATE_UNRESOLVED")
        expect(codes.filter((code) => code === "PAYMENT_VERIFICATION_FAILED")).toHaveLength(1)
    })

    it("keeps only UNAVAILABLE retryable and never reuses an unrelated legacy code", () => {
        expect(new PaymentProviderUnavailableError().status).toBe(503)
        // این سه شکست provider نباید جای هم را بگیرند (سند §۲۰/§۲۱)
        expect(new PaymentProviderRejectedError().code).not.toBe("PAYMENT_PROVIDER_UNAVAILABLE")
        expect(new PaymentProviderInvalidResponseError().code).not.toBe("PAYMENT_PROVIDER_UNAVAILABLE")
        expect(new PaymentStateUnresolvedError().code).not.toBe("PAYMENT_PROVIDER_UNAVAILABLE")
    })

    it("passes through the safe ADR-04 envelope without provider/DB detail", () => {
        for (const c of PHASE_5_ERRORS) {
            const body = toServiceErrorBody(c.error)
            expect(body?.ok, c.name).toBe(false)
            expect(body?.error.code, c.name).toBe(c.code)
            expect(typeof body?.error.message, c.name).toBe("string")
            expect(body?.error).not.toHaveProperty("errors")
            const serialized = JSON.stringify(body)
            for (const forbidden of ["Authority", "zarinpal", "providerAuthority", "prisma", "P2002", "stack"]) {
                expect(serialized.toLowerCase(), `${c.name} leaks ${forbidden}`).not.toContain(forbidden.toLowerCase())
            }
        }
    })
})