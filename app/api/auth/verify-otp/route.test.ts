import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* Route smoke test: POST /api/auth/verify-otp                         */
/* کپچا: ماژول @/app/lib/turnstile mock شده است → هیچ تماس شبکه‌ای با   */
/* Cloudflare نمی‌رود. قرارداد HTTP خودِ verifier جداگانه در            */
/* app/lib/turnstile.test.ts تست می‌شود.                               */
/* Prisma و lib/otp mock شده‌اند: بدون DB و بدون bcrypt واقعی.          */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    otpCreate: vi.fn(),
    otpFindFirst: vi.fn(),
    otpDelete: vi.fn(),
    generateOtpCode: vi.fn(),
    hashOtp: vi.fn(),
    verifyOtp: vi.fn(),
    verifyTurnstile: vi.fn<(token: string, options?: unknown) => Promise<boolean>>(),
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
// Cloudflare Turnstile: fail-closed پیش‌فرض — فقط توکن غیرخالی «معتبر» است.
vi.mock("@/app/lib/turnstile", () => ({ verifyTurnstile: mocks.verifyTurnstile }))

import { POST } from "./route"

const TURNSTILE_TOKEN = "test-token"
const EMAIL = "user@example.com"

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
    beforeEach(() => {
        vi.clearAllMocks()

        // پیش‌فرض: فقط توکن غیرخالی معتبر است (معادل رفتار fail-closed سرور)
        mocks.verifyTurnstile.mockImplementation(async (token: string) => token.length > 0)
        mocks.otpFindFirst.mockResolvedValue(RECORD)
        mocks.otpDelete.mockResolvedValue(RECORD)
        mocks.verifyOtp.mockResolvedValue(true)
    })

    afterEach(() => {
        vi.unstubAllEnvs()
    })

    /* -------------------------------------------------------------- */
    /* Turnstile — fail-closed (ضد brute force)                        */
    /* -------------------------------------------------------------- */

    it("returns 400 CAPTCHA_FAILED without a captcha token and never touches the database", async () => {
        const res = await callPOST({ email: EMAIL, code: "123456" })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("CAPTCHA_FAILED")

        expect(mocks.verifyTurnstile).toHaveBeenCalledWith("", {
            expectedAction: "verify_otp",
        })

        // هیچ تلاش تأییدی روی DB انجام نشده — brute force مسدود است
        expect(mocks.otpFindFirst).not.toHaveBeenCalled()
        expect(mocks.verifyOtp).not.toHaveBeenCalled()
        expect(mocks.otpDelete).not.toHaveBeenCalled()
    })

    it("returns 400 CAPTCHA_FAILED when the verifier rejects the token (invalid, expired, reused, wrong hostname/action, timeout)", async () => {
        mocks.verifyTurnstile.mockResolvedValue(false)

        const res = await callPOST({
            email: EMAIL,
            code: "123456",
            turnstileToken: "stale-token",
        })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("CAPTCHA_FAILED")
        expect(mocks.verifyTurnstile).toHaveBeenCalledWith("stale-token", {
            expectedAction: "verify_otp",
        })
        expect(mocks.otpFindFirst).not.toHaveBeenCalled()
        expect(mocks.verifyOtp).not.toHaveBeenCalled()
    })

    /* -------------------------------------------------------------- */
    /* مسیر موفق                                                       */
    /* -------------------------------------------------------------- */

    it("verifies the code and deletes the record when the captcha token is valid", async () => {
        const res = await callPOST({
            email: EMAIL,
            code: "123456",
            turnstileToken: TURNSTILE_TOKEN,
        })

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
            ok: true,
            message: "کد با موفقیت تأیید شد",
        })

        // action سمت سرور تعیین می‌شود، نه از بدنه‌ی درخواست
        expect(mocks.verifyTurnstile).toHaveBeenCalledWith(TURNSTILE_TOKEN, {
            expectedAction: "verify_otp",
        })

        // آخرین رکورد همان ایمیل، سپس مقایسه‌ی کد، سپس حذف (single-use)
        expect(mocks.otpFindFirst).toHaveBeenCalledWith({
            where: { email: EMAIL },
            orderBy: { createdAt: "desc" },
        })
        expect(mocks.verifyOtp).toHaveBeenCalledWith("123456", "hashed-code")
        expect(mocks.otpDelete).toHaveBeenCalledWith({ where: { id: "otp_1" } })
    })

    it("normalizes the email before looking up the record", async () => {
        const res = await callPOST({
            email: "  USER@Example.COM  ",
            code: " 123456 ",
            turnstileToken: TURNSTILE_TOKEN,
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
        mocks.verifyOtp.mockResolvedValue(false)

        const res = await callPOST({
            email: EMAIL,
            code: "000000",
            turnstileToken: TURNSTILE_TOKEN,
        })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("INVALID_OTP")
        expect(mocks.otpDelete).not.toHaveBeenCalled()
    })

    it("returns 400 OTP_NOT_FOUND when no record exists for the email", async () => {
        mocks.otpFindFirst.mockResolvedValue(null)

        const res = await callPOST({
            email: EMAIL,
            code: "123456",
            turnstileToken: TURNSTILE_TOKEN,
        })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("OTP_NOT_FOUND")
        expect(mocks.verifyOtp).not.toHaveBeenCalled()
    })

    it("returns 400 OTP_EXPIRED when the record is past its expiry", async () => {
        mocks.otpFindFirst.mockResolvedValue({
            ...RECORD,
            expiresAt: new Date(Date.now() - 1000),
        })

        const res = await callPOST({
            email: EMAIL,
            code: "123456",
            turnstileToken: TURNSTILE_TOKEN,
        })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("OTP_EXPIRED")
        expect(mocks.verifyOtp).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR when email/code are missing but the captcha is valid", async () => {
        const res = await callPOST({ email: EMAIL, turnstileToken: TURNSTILE_TOKEN })

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
