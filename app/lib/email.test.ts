import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* Unit test: app/lib/email.ts                                         */
/*                                                                     */
/* هدف: شکست ارسال هرگز بی‌صدا نماند و لاگ، جزئیات دقیق Resend          */
/* (statusCode / name / message) را داشته باشد تا «خطای ایمیل» از      */
/* «خطای کپچا» و از «کلید/دامنهٔ نامعتبر» قابل تفکیک باشد.             */
/* resend mock شده است → بدون ایمیل واقعی.                            */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    emailSend: vi.fn(),
}))

vi.mock("resend", () => ({
    Resend: class {
        emails = { send: mocks.emailSend }
    },
}))

import { maskEmailForLog, sendEmail } from "./email"

const TO = "user@example.com"
const SUBJECT = "کد تأیید"
const HTML = "<p>123456</p>"

/** آخرین فراخوانی یک اسپای console. */
const lastCall = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls[spy.mock.calls.length - 1] as unknown as [string, Record<string, unknown>]

describe("maskEmailForLog", () => {
    it("keeps the domain for diagnosis but never the full local part", () => {
        expect(maskEmailForLog("user@example.com")).toBe("us***@example.com")
        expect(maskEmailForLog("a@example.com")).toBe("a***@example.com")
        expect(maskEmailForLog("not-an-email")).toBe("***")
    })
})

describe("sendEmail — Resend diagnostics", () => {
    let errorSpy: ReturnType<typeof vi.spyOn>
    let logSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        vi.clearAllMocks()
        vi.stubEnv("RESEND_API_KEY", "test-key")
        vi.stubEnv("RESEND_FROM_EMAIL", "")
        errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
        logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    })

    afterEach(() => {
        vi.unstubAllEnvs()
        vi.restoreAllMocks()
    })

    it("logs the exact Resend status/name/message when the API returns an error without throwing", async () => {
        // قرارداد واقعی SDK: خطای API در { data: null, error } برمی‌گردد (نه throw)
        mocks.emailSend.mockResolvedValue({
            data: null,
            error: {
                name: "validation_error",
                statusCode: 403,
                message:
                    "You can only send testing emails to your own email address. Verify a domain.",
            },
        })

        const result = await sendEmail(TO, SUBJECT, HTML)

        expect(result.sent).toBe(false)
        const [message, fields] = lastCall(errorSpy)
        expect(message).toContain("Resend API error")
        expect(fields.statusCode).toBe(403)
        expect(fields.name).toBe("validation_error")
        expect(fields.message).toContain("Verify a domain")
        // آدرس کامل گیرنده هرگز لاگ نمی‌شود
        expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(TO)
        expect(fields.to).toBe("us***@example.com")
    })

    it("points at the verified-domain requirement for a 403 with the sandbox sender", async () => {
        mocks.emailSend.mockResolvedValue({
            data: null,
            error: { name: "validation_error", statusCode: 403, message: "sandbox restriction" },
        })

        await sendEmail(TO, SUBJECT, HTML)

        const [, fields] = lastCall(errorSpy)
        expect(fields.senderIsSandbox).toBe(true)
        expect(fields.from).toBe("DailyPilot <onboarding@resend.dev>")
        expect(String(fields.hint)).toContain("RESEND_FROM_EMAIL")
    })

    it("points at the API key for a 401", async () => {
        mocks.emailSend.mockResolvedValue({
            data: null,
            error: { name: "missing_api_key", statusCode: 401, message: "Missing API key" },
        })

        await sendEmail(TO, SUBJECT, HTML)

        const [, fields] = lastCall(errorSpy)
        expect(fields.statusCode).toBe(401)
        expect(String(fields.hint)).toContain("RESEND_API_KEY")
    })

    it("logs a thrown/network failure with its error name", async () => {
        mocks.emailSend.mockRejectedValue(new TypeError("fetch failed"))

        const result = await sendEmail(TO, SUBJECT, HTML)

        expect(result.sent).toBe(false)
        const [message, fields] = lastCall(errorSpy)
        expect(message).toContain("threw")
        expect(fields.errorName).toBe("TypeError")
        expect(fields.errorMessage).toBe("fetch failed")
    })

    it("says explicitly that no provider call happened when the API key is missing", async () => {
        vi.stubEnv("RESEND_API_KEY", "")

        const result = await sendEmail(TO, SUBJECT, HTML)

        expect(result).toEqual({ sent: false, error: "RESEND_API_KEY is not configured" })
        const [message, fields] = lastCall(errorSpy)
        expect(message).toContain("RESEND_API_KEY is not configured")
        expect(fields.to).toBe("us***@example.com")
        expect(mocks.emailSend).not.toHaveBeenCalled()
    })

    it("logs the Resend id on success (delivery accepted by the provider)", async () => {
        mocks.emailSend.mockResolvedValue({ data: { id: "email_1" }, error: null })

        const result = await sendEmail(TO, SUBJECT, HTML)

        expect(result).toEqual({ sent: true, id: "email_1" })
        const [message, fields] = lastCall(logSpy)
        expect(message).toContain("accepted by Resend")
        expect(fields.id).toBe("email_1")
        expect(errorSpy).not.toHaveBeenCalled()
    })
})
