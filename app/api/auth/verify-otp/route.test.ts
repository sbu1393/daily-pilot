import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* Route smoke test: POST /api/auth/verify-otp                         */
/* reCAPTCHA: fetch و RECAPTCHA_SECRET_KEY mock می‌شوند → verifyRecaptcha*/
/* واقعی اجرا می‌شود ولی هیچ تماس شبکه‌ای با Google نمی‌رود.            */
/* Prisma و lib/otp mock شده‌اند: بدون DB و بدون bcrypt واقعی.          */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    otpCreate: vi.fn(),
    otpFindFirst: vi.fn(),
    otpDelete: vi.fn(),
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
        new NextRequest("http://localhost/api/auth/verify-otp", {
            method: "POST",
            body: JSON.stringify(body),
        }),
    )

const RECORD = {
    id: "otp_1",
    email: EMAIL,
    codeHash: "hashed-code",
    expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    createdAt: new Date(),
}

describe("POST /api/auth/verify-otp", () => {
    let fetchMock: ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>

    beforeEach(() => {
        vi.clearAllMocks()
        fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
        vi.stubGlobal("fetch", fetchMock)
        vi.stubEnv("RECAPTCHA_SECRET_KEY", RECAPTCHA_SECRET)

        mocks.otpFindFirst.mockResolvedValue(RECORD)
        mocks.otpDelete.mockResolvedValue(RECORD)
        mocks.verifyOtp.mockResolvedValue(true)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.unstubAllEnvs()
    })

    /* -------------------------------------------------------------- */
    /* reCAPTCHA — fail-closed (ضد brute force)                       */
    /* -------------------------------------------------------------- */

    it("returns 400 RECAPTCHA_FAILED without a captcha token and never touches the database", async () => {
        const res = await callPOST({ email: EMAIL, code: "123456" })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("RECAPTCHA_FAILED")

        // هیچ تلاش تأییدی روی DB انجام نشده — brute force مسدود است
        expect(mocks.otpFindFirst).not.toHaveBeenCalled()
        expect(mocks.verifyOtp).not.toHaveBeenCalled()
        expect(mocks.otpDelete).not.toHaveBeenCalled()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("returns 400 RECAPTCHA_FAILED for an invalid token (Google success:false)", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ success: false, "error-codes": ["invalid-input-response"] }),
        )

        const res = await callPOST({
            email: EMAIL,
            code: "123456",
            recaptchaToken: "bad-token",
        })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("RECAPTCHA_FAILED")
        expect(mocks.otpFindFirst).not.toHaveBeenCalled()
        expect(mocks.verifyOtp).not.toHaveBeenCalled()
    })

    it("returns 400 RECAPTCHA_FAILED for a low-score token (bot-like, below 0.5)", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ success: true, score: 0.1 }))

        const res = await callPOST({
            email: EMAIL,
            code: "123456",
            recaptchaToken: RECAPTCHA_TOKEN,
        })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("RECAPTCHA_FAILED")
        expect(mocks.verifyOtp).not.toHaveBeenCalled()
    })

    it("fails closed (400 RECAPTCHA_FAILED) when RECAPTCHA_SECRET_KEY is missing", async () => {
        vi.stubEnv("RECAPTCHA_SECRET_KEY", "")

        const res = await callPOST({
            email: EMAIL,
            code: "123456",
            recaptchaToken: RECAPTCHA_TOKEN,
        })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("RECAPTCHA_FAILED")
        expect(fetchMock).not.toHaveBeenCalled()
        expect(mocks.otpFindFirst).not.toHaveBeenCalled()
    })

    /* -------------------------------------------------------------- */
    /* مسیر موفق                                                       */
    /* -------------------------------------------------------------- */

    it("verifies the code and deletes the record when the captcha token is valid", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ success: true, score: 0.9 }))

        const res = await callPOST({
            email: EMAIL,
            code: "123456",
            recaptchaToken: RECAPTCHA_TOKEN,
        })

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
            ok: true,
            message: "کد با موفقیت تأیید شد",
        })

        // توکن واقعاً به Google's siteverify فرستاده شده است
        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [, init] = fetchMock.mock.calls[0]
        expect(init.method).toBe("POST")
        const params = init.body as URLSearchParams
        expect(params.get("secret")).toBe(RECAPTCHA_SECRET)
        expect(params.get("response")).toBe(RECAPTCHA_TOKEN)

        // آخرین رکورد همان ایمیل، سپس مقایسه‌ی کد، سپس حذف (single-use)
        expect(mocks.otpFindFirst).toHaveBeenCalledWith({
            where: { email: EMAIL },
            orderBy: { createdAt: "desc" },
        })
        expect(mocks.verifyOtp).toHaveBeenCalledWith("123456", "hashed-code")
        expect(mocks.otpDelete).toHaveBeenCalledWith({ where: { id: "otp_1" } })
    })

    it("normalizes the email before looking up the record", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ success: true, score: 0.9 }))

        const res = await callPOST({
            email: "  USER@Example.COM  ",
            code: " 123456 ",
            recaptchaToken: RECAPTCHA_TOKEN,
        })

        expect(res.status).toBe(200)
        expect(mocks.otpFindFirst).toHaveBeenCalledWith({
            where: { email: EMAIL },
            orderBy: { createdAt: "desc" },
        })
        expect(mocks.verifyOtp).toHaveBeenCalledWith("123456", "hashed-code")
    })

    /* -------------------------------------------------------------- */
    /* منطق OTP بعد از captcha                                         */
    /* -------------------------------------------------------------- */

    it("returns 400 INVALID_OTP for a wrong code and keeps the record", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ success: true, score: 0.9 }))
        mocks.verifyOtp.mockResolvedValue(false)

        const res = await callPOST({
            email: EMAIL,
            code: "000000",
            recaptchaToken: RECAPTCHA_TOKEN,
        })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("INVALID_OTP")
        expect(mocks.otpDelete).not.toHaveBeenCalled()
    })

    it("returns 400 OTP_NOT_FOUND when no record exists for the email", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ success: true, score: 0.9 }))
        mocks.otpFindFirst.mockResolvedValue(null)

        const res = await callPOST({
            email: EMAIL,
            code: "123456",
            recaptchaToken: RECAPTCHA_TOKEN,
        })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("OTP_NOT_FOUND")
        expect(mocks.verifyOtp).not.toHaveBeenCalled()
    })

    it("returns 400 OTP_EXPIRED when the record is past its expiry", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ success: true, score: 0.9 }))
        mocks.otpFindFirst.mockResolvedValue({
            ...RECORD,
            expiresAt: new Date(Date.now() - 1000),
        })

        const res = await callPOST({
            email: EMAIL,
            code: "123456",
            recaptchaToken: RECAPTCHA_TOKEN,
        })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("OTP_EXPIRED")
        expect(mocks.verifyOtp).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR when email/code are missing but the captcha is valid", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ success: true, score: 0.9 }))

        const res = await callPOST({ email: EMAIL, recaptchaToken: RECAPTCHA_TOKEN })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.otpFindFirst).not.toHaveBeenCalled()
    })

    it("returns 400 (not 500) for a malformed JSON body", async () => {
        const res = await POST(
            new NextRequest("http://localhost/api/auth/verify-otp", {
                method: "POST",
                body: "{ this is not json",
            }),
        )

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(mocks.otpFindFirst).not.toHaveBeenCalled()
    })
})
