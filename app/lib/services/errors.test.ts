import { describe, expect, it } from "vitest"
import {
    EmailTakenError,
    InvalidCredentialsError,
    MissingDayKeyError,
    NoRolloverCandidatesError,
    OverdueTaskError,
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