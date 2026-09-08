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