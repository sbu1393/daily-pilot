import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* Route smoke test: POST /api/auth/send-otp                           */
/* کپچا: ماژول @/app/lib/turnstile mock شده است → هیچ تماس شبکه‌ای با   */
/* Cloudflare نمی‌رود. قرارداد HTTP خودِ verifier جداگانه در            */
/* app/lib/turnstile.test.ts تست می‌شود.                               */
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
// Cloudflare Turnstile: fail-closed پیش‌فرض — فقط توکن غیرخالی «معتبر» است.
vi.mock("@/app/lib/turnstile", () => ({ verifyTurnstile: mocks.verifyTurnstile }))

import { POST } from "./route"

const TURNSTILE_TOKEN = "test-token"
const EMAIL = "user@example.com"

const callPOST = (body: unknown) =>
    POST(
        new NextRequest("http://localhost/api/auth/send-otp", {
            method: "POST",
            body: JSON.stringify(body),
        }),
    )

describe("POST /api/auth/send-otp", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.stubEnv("RESEND_API_KEY", "test-resend-key")

        // پیش‌فرض: فقط توکن غیرخالی معتبر است (معادل رفتار fail-closed سرور)
        mocks.verifyTurnstile.mockImplementation(async (token: string) => token.length > 0)
        mocks.generateOtpCode.mockReturnValue("123456")
        mocks.hashOtp.mockResolvedValue("hashed-code")
        mocks.otpCreate.mockResolvedValue({ id: "otp_1" })
        mocks.emailSend.mockResolvedValue({ id: "email_1" })
    })

    afterEach(() => {
        vi.unstubAllEnvs()
    })

    /* -------------------------------------------------------------- */
    /* Turnstile — fail-closed                                         */
    /* -------------------------------------------------------------- */

    it("returns 400 CAPTCHA_FAILED without a captcha token and never creates a code or sends an email", async () => {
        const res = await callPOST({ email: EMAIL })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("CAPTCHA_FAILED")

        // توکن غایب به verifier به‌صورت رشته‌ی خالی می‌رسد (قرارداد بدنه)
        expect(mocks.verifyTurnstile).toHaveBeenCalledWith("", {
            expectedAction: "send_otp",
        })

        // هیچ کار حساسی انجام نشده — نه کد ساخته شد، نه ایمیلی رفت
        expect(mocks.otpCreate).not.toHaveBeenCalled()
        expect(mocks.emailSend).not.toHaveBeenCalled()
        expect(mocks.generateOtpCode).not.toHaveBeenCalled()
    })

    it("returns 400 CAPTCHA_FAILED when the verifier rejects the token (invalid, expired, used, wrong hostname/action, timeout)", async () => {
        mocks.verifyTurnstile.mockResolvedValue(false)

        const res = await callPOST({ email: EMAIL, turnstileToken: "bad-token" })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("CAPTCHA_FAILED")
        expect(mocks.verifyTurnstile).toHaveBeenCalledWith("bad-token", {
            expectedAction: "send_otp",
        })
        expect(mocks.otpCreate).not.toHaveBeenCalled()
        expect(mocks.emailSend).not.toHaveBeenCalled()
    })

    /* -------------------------------------------------------------- */
    /* مسیر موفق                                                       */
    /* -------------------------------------------------------------- */

    it("creates a 10-minute code and sends the email when the captcha token is valid", async () => {
        const res = await callPOST({ email: EMAIL, turnstileToken: TURNSTILE_TOKEN })

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
            ok: true,
            message: "کد با موفقیت ارسال شد",
        })

        // action سمت سرور تعیین می‌شود، نه از بدنه‌ی درخواست
        expect(mocks.verifyTurnstile).toHaveBeenCalledWith(TURNSTILE_TOKEN, {
            expectedAction: "send_otp",
        })

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
        const res = await callPOST({
            email: "  USER@Example.COM  ",
            turnstileToken: TURNSTILE_TOKEN,
        })

        expect(res.status).toBe(200)
        const created = mocks.otpCreate.mock.calls[0][0] as { data: { email: string } }
        expect(created.data.email).toBe(EMAIL)
    })

    /* -------------------------------------------------------------- */
    /* validation بعد از captcha                                       */
    /* -------------------------------------------------------------- */

    it("returns 400 VALIDATION_ERROR when the email is missing but the captcha is valid", async () => {
        const res = await callPOST({ turnstileToken: TURNSTILE_TOKEN })

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

    /* -------------------------------------------------------------- */
    /* شکست ارسال ایمیل — هرگز بی‌صدا رد نمی‌شود                       */
    /* -------------------------------------------------------------- */

    it("returns 503 EMAIL_DELIVERY_FAILED when the provider throws (network failure)", async () => {
        mocks.emailSend.mockRejectedValue(new Error("resend down"))
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

        const res = await callPOST({ email: EMAIL, turnstileToken: TURNSTILE_TOKEN })

        expect(res.status).toBe(503)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("EMAIL_DELIVERY_FAILED")
        errorSpy.mockRestore()
    })

    it("returns 503 EMAIL_DELIVERY_FAILED when the provider returns an API error without throwing", async () => {
        // قرارداد واقعی SDK: خطای API (403/401/429) به‌جای throw، در
        // { data: null, error } برمی‌گردد — دقیقاً حالتی که قبلاً بی‌صدا رد می‌شد.
        mocks.emailSend.mockResolvedValue({
            data: null,
            error: { message: "domain not verified", name: "validation_error", statusCode: 403 },
        })
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

        const res = await callPOST({ email: EMAIL, turnstileToken: TURNSTILE_TOKEN })

        expect(res.status).toBe(503)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("EMAIL_DELIVERY_FAILED")
        errorSpy.mockRestore()
    })
})
