import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { InvalidCredentialsError } from "@/app/lib/services/errors"

/* ------------------------------------------------------------------ */
/* Route smoke test: POST /api/auth/login (ADR-04)                     */
/*                                                                     */
/* ورود دو مرحله‌ای (2FA): رمز عبور + کد ایمیل.                         */
/* - authenticate mocked (no DB)                                       */
/* - rateLimit mocked                                                  */
/* - otp.service mocked (چالش + ارسال ایمیل بدون DB/شبکه واقعی)         */
/* - هیچ سشنی در این مرحله ساخته نمی‌شود (createSession صدا زده نمی‌شود) */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    isRateLimited: vi.fn(),
    clientIp: vi.fn(),
    authenticate: vi.fn(),
    touchAuthenticatedActivity: vi.fn(),
    recordProductEvent: vi.fn(),
    getPrisma: vi.fn(),
    verifyTurnstile: vi.fn(),
    createOtpChallenge: vi.fn(),
    sendOtpEmail: vi.fn(),
}))

vi.mock("@/app/lib/rateLimit", () => ({
    isRateLimited: mocks.isRateLimited,
    clientIp: mocks.clientIp,
}))
vi.mock("@/app/lib/services/auth.service", () => ({ authenticate: mocks.authenticate }))
vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: mocks.getPrisma }))
vi.mock("@/app/lib/services/userActivity.service", () => ({
    touchAuthenticatedActivity: mocks.touchAuthenticatedActivity,
}))
vi.mock("@/app/lib/services/productEvent.service", () => ({
    recordProductEvent: mocks.recordProductEvent,
}))
// Cloudflare Turnstile: بدون mock، verifyTurnstile تماس واقعی با Cloudflare می‌زند.
vi.mock("@/app/lib/turnstile", () => ({ verifyTurnstile: mocks.verifyTurnstile }))
// OTP: چالش و ارسال ایمیل در این تست‌ها شبیه‌سازی می‌شوند
vi.mock("@/app/lib/services/otp.service", () => ({
    createOtpChallenge: mocks.createOtpChallenge,
    sendOtpEmail: mocks.sendOtpEmail,
    OTP_TTL_MS: 600000,
    OTP_MAX_ATTEMPTS: 5,
}))

import { POST } from "./route"

const USER = { id: 1, username: "test", email: "test@example.com" }
const CHALLENGE = { challengeId: "ch_1", code: "123456", expiresAt: new Date() }

const VALID_BODY = {
    email: "test@example.com",
    password: "secret123",
    turnstileToken: "test-token",
}

const callPOST = (body: unknown) =>
    POST(
        new NextRequest("http://localhost/api/auth/login", {
            method: "POST",
            body: JSON.stringify(body),
        }),
    )

describe("POST /api/auth/login", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.clientIp.mockReturnValue("1.2.3.4")
        mocks.isRateLimited.mockReturnValue(false)
        mocks.verifyTurnstile.mockResolvedValue(true)
        mocks.touchAuthenticatedActivity.mockResolvedValue({ touched: true })
        mocks.recordProductEvent.mockResolvedValue({
            recorded: true,
            eventName: "auth.login_succeeded",
        })
        mocks.getPrisma.mockReturnValue({})
        mocks.authenticate.mockResolvedValue(USER)
        mocks.createOtpChallenge.mockResolvedValue(CHALLENGE)
        mocks.sendOtpEmail.mockResolvedValue({ sent: true, id: "email_1" })
    })

    /* -------------------------------------------------------------- */
    /* ورود دو مرحله‌ای — مرحلهٔ اول                                     */
    /* -------------------------------------------------------------- */

    it("returns 200 with { ok: true, data: { nextStep: OTP, challengeId, email } }", async () => {
        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
            ok: true,
            data: { nextStep: "OTP", challengeId: "ch_1", email: "test@example.com" },
        })
        expect(mocks.authenticate).toHaveBeenCalledWith("test@example.com", "secret123")
        expect(mocks.createOtpChallenge).toHaveBeenCalledWith("test@example.com")
        expect(mocks.sendOtpEmail).toHaveBeenCalledWith("test@example.com", "123456")
    })

    it("never creates the final session before the OTP is confirmed (no cookie in step 1)", async () => {
        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(200)
        expect(res.cookies.get("token")).toBeUndefined()
        expect(res.headers.get("set-cookie")).toBeNull()
    })

    it("returns 503 EMAIL_DELIVERY_FAILED when the email provider rejects the send (never silent)", async () => {
        mocks.sendOtpEmail.mockResolvedValue({ sent: false, error: "domain not verified" })

        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(503)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("EMAIL_DELIVERY_FAILED")
        // هیچ سشنی حتی در مسیر شکست ارسال ساخته نمی‌شود
        expect(res.cookies.get("token")).toBeUndefined()
        // چالش ساخته شده بود ولی ارسال نشد — کاربر باید دوباره تلاش کند
        expect(mocks.createOtpChallenge).toHaveBeenCalledTimes(1)
    })

    it("does not create a challenge or send email when the password is wrong", async () => {
        mocks.authenticate.mockRejectedValue(new InvalidCredentialsError())

        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(401)
        expect(mocks.createOtpChallenge).not.toHaveBeenCalled()
        expect(mocks.sendOtpEmail).not.toHaveBeenCalled()
    })

    it("normalizes email before rate limiting and authentication", async () => {
        const res = await callPOST({ email: "  TEST@Example.COM  ", password: "secret123" })

        expect(res.status).toBe(200)
        expect(mocks.isRateLimited).toHaveBeenCalledWith("login:email:test@example.com", 5)
        expect(mocks.authenticate).toHaveBeenCalledWith("test@example.com", "secret123")
        expect(mocks.createOtpChallenge).toHaveBeenCalledWith("test@example.com")
    })

    /* -------------------------------------------------------------- */
    /* X-Request-ID (فاز صفر §7/§25)                                    */
    /* -------------------------------------------------------------- */

    it("200 step-1 response carries X-Request-ID", async () => {
        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(200)
        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
    })

    it("401 error carries X-Request-ID", async () => {
        mocks.authenticate.mockRejectedValue(new InvalidCredentialsError())

        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(401)
        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
    })

    it("429 rate-limit response carries X-Request-ID", async () => {
        mocks.isRateLimited.mockReturnValue(true)

        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(429)
        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
    })

    /* -------------------------------------------------------------- */
    /* Rate limit                                                      */
    /* -------------------------------------------------------------- */

    it("returns 429 RATE_LIMITED when the IP bucket is exhausted (before body/validation)", async () => {
        mocks.isRateLimited.mockImplementation((key: string) => key.startsWith("login:ip:"))

        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(429)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("RATE_LIMITED")
        expect(mocks.authenticate).not.toHaveBeenCalled()
    })

    it("returns 429 RATE_LIMITED when the email bucket is exhausted", async () => {
        mocks.isRateLimited.mockImplementation((key: string) => key.startsWith("login:email:"))

        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(429)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("RATE_LIMITED")
        expect(mocks.authenticate).not.toHaveBeenCalled()
    })

    /* -------------------------------------------------------------- */
    /* فاز ۳ — گام ۷: integration analysis (touch + auth.login_succeeded) */
    /* مرز احراز هویت = تأیید رمز عبور؛ رفتار دست‌نخورده مانده است.      */
    /* -------------------------------------------------------------- */

    it("touches activity and records auth.login_succeeded without properties after real authentication", async () => {
        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(200)
        expect(mocks.touchAuthenticatedActivity).toHaveBeenCalledTimes(1)
        expect(mocks.touchAuthenticatedActivity).toHaveBeenCalledWith(
            1,
            expect.any(Date),
            expect.anything(),
        )
        expect(mocks.recordProductEvent).toHaveBeenCalledTimes(1)
        expect(mocks.recordProductEvent).toHaveBeenCalledWith(
            1,
            "auth.login_succeeded",
            undefined,
            expect.objectContaining({
                requestId: expect.any(String),
                endpoint: "/api/auth/login",
                feature: "auth",
            }),
        )
    })

    it("emits no event and no touch when authentication fails (INVALID_CREDENTIALS)", async () => {
        mocks.authenticate.mockRejectedValue(new InvalidCredentialsError())

        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(401)
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
    })

    it("keeps the step-1 response unchanged when analytics fails (fail-open)", async () => {
        mocks.touchAuthenticatedActivity.mockRejectedValue(new Error("analytics db down"))

        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(200)
        const parsed = await res.json()
        expect(parsed.data.nextStep).toBe("OTP")
        expect(parsed.data.challengeId).toBe("ch_1")
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
    })

    /* -------------------------------------------------------------- */
    /* Turnstile (fail-closed)                                         */
    /* -------------------------------------------------------------- */

    it("returns 400 CAPTCHA_FAILED (before authentication) when human verification fails", async () => {
        mocks.verifyTurnstile.mockResolvedValue(false)

        const res = await callPOST(VALID_BODY)

        // action مورد انتظار از سرور می‌آید، نه از بدنه‌ی درخواست
        expect(mocks.verifyTurnstile).toHaveBeenCalledWith("test-token", {
            expectedAction: "login",
        })
        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("CAPTCHA_FAILED")
        expect(mocks.authenticate).not.toHaveBeenCalled()
        expect(mocks.createOtpChallenge).not.toHaveBeenCalled()
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
    })

    /* -------------------------------------------------------------- */
    /* خطاهای دامنه و بدنه                                              */
    /* -------------------------------------------------------------- */

    it("propagates ServiceError INVALID_CREDENTIALS as 401", async () => {
        mocks.authenticate.mockRejectedValue(new InvalidCredentialsError())

        const res = await callPOST(VALID_BODY)

        expect(res.status).toBe(401)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("INVALID_CREDENTIALS")
    })

    it.each([
        ["malformed JSON", "{ this is not json"],
        ["empty body", ""],
    ])(
        "returns 400 VALIDATION_ERROR (not 500) for a %s body (M3)",
        async (_label, raw) => {
            const res = await POST(
                new NextRequest("http://localhost/api/auth/login", {
                    method: "POST",
                    body: raw,
                }),
            )

            expect(res.status).toBe(400)
            const parsed = await res.json()
            expect(parsed.ok).toBe(false)
            expect(parsed.error.code).toBe("VALIDATION_ERROR")
            expect(mocks.authenticate).not.toHaveBeenCalled()
            expect(mocks.createOtpChallenge).not.toHaveBeenCalled()
        },
    )

    it("returns 400 VALIDATION_ERROR for an invalid body and never calls authenticate", async () => {
        const res = await callPOST({ email: "not-an-email", password: "" })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(parsed.error.errors).toBeDefined()
        expect(mocks.authenticate).not.toHaveBeenCalled()
        expect(mocks.createOtpChallenge).not.toHaveBeenCalled()
    })
})
