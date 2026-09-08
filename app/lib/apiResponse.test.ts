import { describe, expect, it } from "vitest"
import { NextResponse } from "next/server"
import {
    errorResponse,
    okMessageResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
    validationErrorResponse,
} from "./apiResponse"
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
} from "./services/errors"

// B1 — ADR-04 envelope factories ({ ok:true, data } / { ok:false, error:{ code, message, errors? } }).
// Real NextResponse instances are asserted on status + parsed body.

async function body(res: NextResponse): Promise<Record<string, unknown>> {
    return (await res.json()) as Record<string, unknown>
}

describe("okResponse — ADR-04 success envelope", () => {
    it("returns 200 with { ok: true, data } and never an error key", async () => {
        const res = okResponse({ id: "t1", text: "خرید" })
        expect(res.status).toBe(200)
        const parsed = await body(res)
        expect(parsed).toEqual({ ok: true, data: { id: "t1", text: "خرید" } })
        expect(parsed).not.toHaveProperty("error")
        expect(parsed).not.toHaveProperty("message")
    })

    it("supports a custom status (e.g. 201 created)", () => {
        expect(okResponse({}, { status: 201 }).status).toBe(201)
    })

    it("includes message only when explicitly provided", async () => {
        const withMsg = await body(okResponse({}, { message: "ساخته شد" }))
        expect(withMsg).toEqual({ ok: true, data: {}, message: "ساخته شد" })
        expect(withMsg).not.toHaveProperty("error")
    })
})

describe("okMessageResponse — success without data", () => {
    it("returns 200 with { ok: true, message }", async () => {
        const res = okMessageResponse("خارج شد")
        expect(res.status).toBe(200)
        await expect(body(res)).resolves.toEqual({ ok: true, message: "خارج شد" })
    })

    it("supports a custom status", () => {
        expect(okMessageResponse("x", 201).status).toBe(201)
    })
})

describe("errorResponse — ADR-04 error envelope", () => {
    it("returns { ok: false, error: { code, message } } with the given status", async () => {
        const res = errorResponse(400, "VALIDATION_ERROR", "اطلاعات نامعتبر است")
        expect(res.status).toBe(400)
        const parsed = await body(res)
        expect(parsed).toEqual({
            ok: false,
            error: { code: "VALIDATION_ERROR", message: "اطلاعات نامعتبر است" },
        })
        expect(parsed).not.toHaveProperty("data")
    })

    it("omits the errors key entirely when not provided", async () => {
        const parsed = await body(errorResponse(500, "SERVER_ERROR", "خطای سرور"))
        expect(parsed.error as Record<string, unknown>).not.toHaveProperty("errors")
    })

    it("attaches errors detail when provided", async () => {
        const errors = { fieldErrors: { text: ["کوتاه است"] } }
        const parsed = await body(errorResponse(400, "VALIDATION_ERROR", "اطلاعات نامعتبر است", errors))
        expect((parsed.error as Record<string, unknown>).errors).toEqual(errors)
    })
})

describe("error helpers", () => {
    it("unauthorizedResponse → 401 / UNAUTHORIZED", async () => {
        const res = unauthorizedResponse()
        expect(res.status).toBe(401)
        await expect(body(res)).resolves.toEqual({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        })
    })

    it("validationErrorResponse → 400 / VALIDATION_ERROR with default fa message and errors detail", async () => {
        const res = validationErrorResponse({ fieldErrors: { text: ["کوتاه است"] } })
        expect(res.status).toBe(400)
        await expect(body(res)).resolves.toEqual({
            ok: false,
            error: {
                code: "VALIDATION_ERROR",
                message: "اطلاعات نامعتبر است",
                errors: { fieldErrors: { text: ["کوتاه است"] } },
            },
        })
    })

    it("validationErrorResponse honors a custom message and can omit errors", async () => {
        const parsed = await body(validationErrorResponse(undefined, "پیام سفارشی"))
        expect((parsed.error as Record<string, unknown>).message).toBe("پیام سفارشی")
        expect(parsed.error as Record<string, unknown>).not.toHaveProperty("errors")
    })
})

describe("toServiceErrorResponse — ServiceError → error envelope mapping", () => {
    it("returns null for non-ServiceError values (let the caller rethrow)", () => {
        expect(toServiceErrorResponse(new Error("x"))).toBeNull()
        expect(toServiceErrorResponse("boom")).toBeNull()
        expect(toServiceErrorResponse(null)).toBeNull()
    })

    const cases: Array<[ServiceError, number, string]> = [
        [new TaskNotFoundError(), 404, "TASK_NOT_FOUND"],
        [new MissingDayKeyError(), 400, "MISSING_DAY_KEY"],
        [new TaskAlreadyDoneError(), 400, "TASK_ALREADY_DONE"],
        [new TaskNotAnalyzeableError("DONE"), 400, "TASK_NOT_ANALYZEABLE"],
        [new TaskNotAnalyzeableError("IN_PROGRESS"), 400, "TASK_NOT_ANALYZEABLE"],
        [new OverdueTaskError(), 400, "OVERDUE_TASK"],
        [new NoRolloverCandidatesError(), 404, "NO_ROLLOVER_CANDIDATES"],
        [new EmailTakenError(), 409, "EMAIL_TAKEN"],
        [new InvalidCredentialsError(), 401, "INVALID_CREDENTIALS"],
        [new UserNotFoundError(), 404, "USER_NOT_FOUND"],
        [new WrongPasswordError(), 401, "WRONG_PASSWORD"],
        [new SamePasswordError(), 400, "SAME_PASSWORD"],
        [new UsernameTakenError(), 409, "USERNAME_TAKEN"],
    ]

    it.each(
        cases.map(([err, status, code]) => ({ err, status, code })),
    )(
        "maps $err.name to HTTP $status with code $code",
        async ({ err, status, code }) => {
            const res = toServiceErrorResponse(err)!
            expect(res.status).toBe(status)
            await expect(body(res)).resolves.toEqual({
                ok: false,
                error: { code, message: err.message },
            })
        },
    )

    it("passes the errors detail through when present", async () => {
        const err = new ServiceError(400, "VALIDATION_ERROR", "اطلاعات نامعتبر است", {
            fieldErrors: { dayKey: ["فرمت نامعتبر"] },
        })
        const res = toServiceErrorResponse(err)!
        const parsed = await body(res)
        expect((parsed.error as Record<string, unknown>).errors).toEqual({
            fieldErrors: { dayKey: ["فرمت نامعتبر"] },
        })
    })
})