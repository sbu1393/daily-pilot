import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* Route smoke test: POST /api/auth/send-otp                           */
/* reCAPTCHA: fetch و RECAPTCHA_SECRET_KEY mock می‌شوند → verifyRecaptcha*/
/* واقعی اجرا می‌شود ولی هیچ تماس شبکه‌ای با Google نمی‌رود.            */
/* Prisma و Resend و lib/otp mock شده‌اند: بدون DB و بدون ایمیل واقعی.  */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    otpCreate: vi.fn(),
    otpFindFirst: vi.fn(),
    otpDelete: vi.fn(),
    emailSend: vi.fn(),
    generateOtpCode: vi.fn(),
    hashOtp: vi.fn(),
    verifyOtp: vi.fn(),
}))

vi.mock("@/app/lib/getPrisma", () => ({
    getPrisma: () => ({
        otpCode: {
            create: mocks.otpCreate,
            findFirst: mocks.otpFindFirst,
            delete: mocks.otpDelete,
        },
    }),
}))
vi.mock("resend", () => ({
    Resend: class {
        emails = { send: mocks.emailSend }
    },
}))
vi.mock("@/lib/otp", () => ({
    generateOtpCode: mocks.generateOtpCode,
    hashOtp: mocks.hashOtp,
    verifyOtp: mocks.verifyOtp,
}))

import { POST } from "./route"

const RECAPTCHA_SECRET = "test-secret"
const RECAPTCHA_TOKEN = "test-token"
const EMAIL = "user@example.com"

const jsonResponse = (payload: unknown, ok = true) =>
    ({ ok, json: async () => payload }) as unknown as Response

const callPOST = (body: unknown) =>
    POST(
        new NextRequest("http://localhost/api/auth/send-otp", {
            method: "POST",
            body: JSON.stringify(body),
        }),
    )

describe("POST /api/auth/send-otp", () => {
    let fetchMock: ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>

    beforeEach(() => {
        vi.clearAllMocks()
        fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
        vi.stubGlobal("fetch", fetchMock)
        vi.stubEnv("RECAPTCHA_SECRET_KEY", RECAPTCHA_SECRET)
        vi.stubEnv("RESEND_API_KEY", "test-resend-key")

        mocks.generateOtpCode.mockReturnValue("123456")
        mocks.hashOtp.mockResolvedValue("hashed-code")
        mocks.otpCreate.mockResolvedValue({ id: "otp_1" })
        mocks.emailSend.mockResolvedValue({ id: "email_1" })
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.unstubAllEnvs()
    })

    /* -------------------------------------------------------------- */
    /* reCAPTCHA — fail-closed                                        */
    /* -------------------------------------------------------------- */

    it("returns 400 RECAPTCHA_FAILED without a captcha token and never creates a code or sends an email", async () => {
        const res = await callPOST({ email: EMAIL })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("RECAPTCHA_FAILED")

        // هیچ کار حساسی انجام نشده — نه کد ساخته شد، نه ایمیلی رفت
        expect(mocks.otpCreate).not.toHaveBeenCalled()
        expect(mocks.emailSend).not.toHaveBeenCalled()
        expect(mocks.generateOtpCode).not.toHaveBeenCalled()
        // توکن خالی → حتی به Google هم درخواست نرفت
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("returns 400 RECAPTCHA_FAILED for an invalid token (Google success:false)", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ success: false, "error-codes": ["invalid-input-response"] }),
        )

        const res = await callPOST({ email: EMAIL, recaptchaToken: "bad-token" })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("RECAPTCHA_FAILED")
        expect(mocks.otpCreate).not.toHaveBeenCalled()
        expect(mocks.emailSend).not.toHaveBeenCalled()
    })

    it("returns 400 RECAPTCHA_FAILED for a low-score token (bot-like, below 0.5)", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ success: true, score: 0.1 }))

        const res = await callPOST({ email: EMAIL, recaptchaToken: RECAPTCHA_TOKEN })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("RECAPTCHA_FAILED")
        expect(mocks.otpCreate).not.toHaveBeenCalled()
        expect(mocks.emailSend).not.toHaveBeenCalled()
    })

    it("fails closed (400 RECAPTCHA_FAILED) when RECAPTCHA_SECRET_KEY is missing", async () => {
        vi.stubEnv("RECAPTCHA_SECRET_KEY", "")

        const res = await callPOST({ email: EMAIL, recaptchaToken: RECAPTCHA_TOKEN })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("RECAPTCHA_FAILED")
        expect(fetchMock).not.toHaveBeenCalled()
        expect(mocks.otpCreate).not.toHaveBeenCalled()
        expect(mocks.emailSend).not.toHaveBeenCalled()
    })

    /* -------------------------------------------------------------- */
    /* مسیر موفق                                                       */
    /* -------------------------------------------------------------- */

    it("creates a 10-minute code and sends the email when the captcha token is valid", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ success: true, score: 0.9 }))

        const res = await callPOST({ email: EMAIL, recaptchaToken: RECAPTCHA_TOKEN })

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
            ok: true,
            message: "کد با موفقیت ارسال شد",
        })

        // توکن واقعاً به Google's siteverify فرستاده شده است
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [, init] = fetchMock.mock.calls[0]
        expect(init.method).toBe("POST")
        const params = init.body as URLSearchParams
        expect(params.get("secret")).toBe(RECAPTCHA_SECRET)
        expect(params.get("response")).toBe(RECAPTCHA_TOKEN)

        // رکورد OTP با هش (نه کد خام) و انقضای ۱۰ دقیقه‌ای
        expect(mocks.otpCreate).toHaveBeenCalledTimes(1)
        const created = mocks.otpCreate.mock.calls[0][0] as {
            data: { email: string; codeHash: string; expiresAt: Date }
        }
        expect(created.data.email).toBe(EMAIL)
        expect(created.data.codeHash).toBe("hashed-code")
        const ttlMs = created.data.expiresAt.getTime() - Date.now()
        expect(ttlMs).toBeGreaterThan(9 * 60 * 1000)
        expect(ttlMs).toBeLessThanOrEqual(10 * 60 * 1000 + 1000)

        expect(mocks.emailSend).toHaveBeenCalledTimes(1)
        const emailArg = mocks.emailSend.mock.calls[0][0] as { to: string; html: string }
        expect(emailArg.to).toBe(EMAIL)
        expect(emailArg.html).toContain("123456")
    })

    it("normalizes the email before storing it", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ success: true, score: 0.9 }))

        const res = await callPOST({
            email: "  USER@Example.COM  ",
            recaptchaToken: RECAPTCHA_TOKEN,
        })

        expect(res.status).toBe(200)
        const created = mocks.otpCreate.mock.calls[0][0] as { data: { email: string } }
        expect(created.data.email).toBe(EMAIL)
    })

    /* -------------------------------------------------------------- */
    /* validation بعد از captcha                                       */
    /* -------------------------------------------------------------- */

    it("returns 400 VALIDATION_ERROR when the email is missing but the captcha is valid", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ success: true, score: 0.9 }))

        const res = await callPOST({ recaptchaToken: RECAPTCHA_TOKEN })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.otpCreate).not.toHaveBeenCalled()
        expect(mocks.emailSend).not.toHaveBeenCalled()
    })

    it("returns 400 (not 500) for a malformed JSON body", async () => {
        const res = await POST(
            new NextRequest("http://localhost/api/auth/send-otp", {
                method: "POST",
                body: "{ this is not json",
            }),
        )

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(mocks.emailSend).not.toHaveBeenCalled()
    })

    it("returns 500 INTERNAL when email delivery fails after a valid captcha", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ success: true, score: 0.9 }))
        mocks.emailSend.mockRejectedValue(new Error("resend down"))
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

        const res = await callPOST({ email: EMAIL, recaptchaToken: RECAPTCHA_TOKEN })

        expect(res.status).toBe(500)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("INTERNAL")
        errorSpy.mockRestore()
    })
})
