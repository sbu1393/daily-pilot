import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, type NextResponse } from "next/server"

/* ------------------------------------------------------------------ */
/* Route smoke test: POST /api/auth/verify-otp                         */
/* کپچا: ماژول @/app/lib/turnstile mock شده است → هیچ تماس شبکه‌ای با   */
/* Cloudflare نمی‌رود. قرارداد HTTP خودِ verifier جداگانه در            */
/* app/lib/turnstile.test.ts تست می‌شود.                               */
/* Prisma، lib/otp، rateLimit و createSession mock شده‌اند: بدون DB،    */
/* بدون bcrypt واقعی و بدون JWT.                                      */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    otpCreate: vi.fn(),
    otpFindFirst: vi.fn(),
    otpFindUnique: vi.fn(),
    otpDelete: vi.fn(),
    userFindUnique: vi.fn(),
    generateOtpCode: vi.fn(),
    hashOtp: vi.fn(),
    verifyOtp: vi.fn(),
    verifyTurnstile: vi.fn<(token: string, options?: unknown) => Promise<boolean>>(),
    isRateLimited: vi.fn(),
    clientIp: vi.fn(),
    createSession: vi.fn(),
}))

vi.mock("@/app/lib/getPrisma", () => ({
    getPrisma: () => ({
        otpCode: {
            create: mocks.otpCreate,
            findFirst: mocks.otpFindFirst,
            findUnique: mocks.otpFindUnique,
            delete: mocks.otpDelete,
        },
        user: {
            findUnique: mocks.userFindUnique,
        },
    }),
}))
vi.mock("@/lib/otp", () => ({
    generateOtpCode: mocks.generateOtpCode,
    hashOtp: mocks.hashOtp,
    verifyOtp: mocks.verifyOtp,
}))
vi.mock("@/app/lib/turnstile", () => ({ verifyTurnstile: mocks.verifyTurnstile }))
vi.mock("@/app/lib/rateLimit", () => ({
    isRateLimited: mocks.isRateLimited,
    clientIp: mocks.clientIp,
}))
vi.mock("@/app/lib/createSession", () => ({ createSession: mocks.createSession }))
// فقط ثابت سقف تلاش لازم است؛ خود سرویس OTP اینجا مصرف نمی‌شود
vi.mock("@/app/lib/services/otp.service", () => ({ OTP_MAX_ATTEMPTS: 5 }))

import { POST } from "./route"

const TURNSTILE_TOKEN = "test-token"
const EMAIL = "user@example.com"
const CHALLENGE_ID = "otp_1"
const CODE = "123456"
const USER = { id: 1, username: "test", email: EMAIL }

const callPOST = (body: unknown) =>
    POST(
        new NextRequest("http://localhost/api/auth/verify-otp", {
            method: "POST",
            body: JSON.stringify(body),
        }),
    )

const RECORD = {
    id: CHALLENGE_ID,
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
        mocks.isRateLimited.mockReturnValue(false)
        mocks.clientIp.mockReturnValue("1.2.3.4")
        mocks.otpFindFirst.mockResolvedValue(RECORD)
        mocks.otpFindUnique.mockResolvedValue(RECORD)
        mocks.otpDelete.mockResolvedValue(RECORD)
        mocks.userFindUnique.mockResolvedValue(USER)
        mocks.verifyOtp.mockResolvedValue(true)
        mocks.createSession.mockImplementation((_user: unknown, response: NextResponse) => {
            response.cookies.set("token", "mocked-jwt", { httpOnly: true, path: "/" })
            return response
        })
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
        expect(mocks.otpFindUnique).not.toHaveBeenCalled()
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
    /* مسیر 2FA — challengeId → صدور سشن                                */
    /* -------------------------------------------------------------- */

    it("verifies by challengeId, consumes the code and issues the final session", async () => {
        const res = await callPOST({
            challengeId: CHALLENGE_ID,
            code: CODE,
            turnstileToken: TURNSTILE_TOKEN,
        })

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
            ok: true,
            data: { nextStep: "DONE", user: USER },
        })

        expect(mocks.verifyTurnstile).toHaveBeenCalledWith(TURNSTILE_TOKEN, {
            expectedAction: "verify_otp",
        })
        // lookup با شناسهٔ چالش (نه ایمیل)
        expect(mocks.otpFindUnique).toHaveBeenCalledWith({ where: { id: CHALLENGE_ID } })
        expect(mocks.otpFindFirst).not.toHaveBeenCalled()
        expect(mocks.verifyOtp).toHaveBeenCalledWith(CODE, "hashed-code")
        // یک‌بارمصرف: حذف قبل از صدور سشن
        expect(mocks.otpDelete).toHaveBeenCalledWith({ where: { id: CHALLENGE_ID } })
        // کاربر از خود رکورد (سمت سرور) خوانده می‌شود، نه از ورودی کلاینت
        expect(mocks.userFindUnique).toHaveBeenCalledWith({
            where: { email: EMAIL },
            select: { id: true, username: true, email: true },
        })
        expect(mocks.createSession).toHaveBeenCalledWith(USER, expect.anything())
        expect(res.cookies.get("token")?.value).toBe("mocked-jwt")
    })

    it("deletes the record before creating the session (single-use ordering)", async () => {
        const order: string[] = []
        mocks.otpDelete.mockImplementation(async () => {
            order.push("delete")
            return RECORD
        })
        mocks.createSession.mockImplementation((_user: unknown, response: NextResponse) => {
            order.push("session")
            return response
        })

        const res = await callPOST({
            challengeId: CHALLENGE_ID,
            code: CODE,
            turnstileToken: TURNSTILE_TOKEN,
        })

        expect(res.status).toBe(200)
        expect(order).toEqual(["delete", "session"])
    })

    it("a consumed code cannot be replayed (second attempt finds no record)", async () => {
        const body = { challengeId: CHALLENGE_ID, code: CODE, turnstileToken: TURNSTILE_TOKEN }

        const first = await callPOST(body)
        expect(first.status).toBe(200)

        // حذف اتمیک رکورد → درخواست دوم چیزی برای مقایسه ندارد
        mocks.otpFindUnique.mockResolvedValue(null)
        const second = await callPOST(body)

        expect(second.status).toBe(400)
        const parsed = await second.json()
        expect(parsed.error.code).toBe("OTP_NOT_FOUND")
        expect(mocks.createSession).toHaveBeenCalledTimes(1)
    })

    it("does not issue a session for a challenge whose email has no user", async () => {
        mocks.userFindUnique.mockResolvedValue(null)

        const res = await callPOST({
            challengeId: CHALLENGE_ID,
            code: CODE,
            turnstileToken: TURNSTILE_TOKEN,
        })

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: { nextStep: "DONE" } })
        expect(mocks.createSession).not.toHaveBeenCalled()
        expect(res.cookies.get("token")).toBeUndefined()
    })

    /* -------------------------------------------------------------- */
    /* مسیر تأیید سادهٔ ایمیل — بدون سشن (ضدِ ورود بدون رمز)             */
    /* -------------------------------------------------------------- */

    it("verifies by email and deletes the record without issuing a session", async () => {
        const res = await callPOST({
            email: EMAIL,
            code: CODE,
            turnstileToken: TURNSTILE_TOKEN,
        })

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: { nextStep: "DONE" } })

        expect(mocks.otpFindUnique).not.toHaveBeenCalled()
        expect(mocks.otpFindFirst).toHaveBeenCalledWith({
            where: { email: EMAIL },
            orderBy: { createdAt: "desc" },
        })
        expect(mocks.verifyOtp).toHaveBeenCalledWith(CODE, "hashed-code")
        expect(mocks.otpDelete).toHaveBeenCalledWith({ where: { id: CHALLENGE_ID } })
        // مسیر send-otp نباید به ورود بدون رمز تبدیل شود
        expect(mocks.userFindUnique).not.toHaveBeenCalled()
        expect(mocks.createSession).not.toHaveBeenCalled()
        expect(res.cookies.get("token")).toBeUndefined()
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
    /* max attempts / rate limit                                       */
    /* -------------------------------------------------------------- */

    it("returns 429 RATE_LIMITED when the per-IP attempts are exhausted, before any DB work", async () => {
        mocks.isRateLimited.mockImplementation((key: string) => key.startsWith("otp:verify:ip:"))

        const res = await callPOST({
            email: EMAIL,
            code: CODE,
            turnstileToken: TURNSTILE_TOKEN,
        })

        expect(res.status).toBe(429)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("RATE_LIMITED")
        expect(mocks.isRateLimited).toHaveBeenCalledWith("otp:verify:ip:1.2.3.4", 5)
        expect(mocks.otpFindFirst).not.toHaveBeenCalled()
        expect(mocks.otpFindUnique).not.toHaveBeenCalled()
        expect(mocks.verifyOtp).not.toHaveBeenCalled()
    })

    it("returns 429 RATE_LIMITED when the per-challenge attempts are exhausted", async () => {
        mocks.isRateLimited.mockImplementation((key: string) =>
            key.startsWith("otp:verify:challenge:"),
        )

        const res = await callPOST({
            email: EMAIL,
            code: CODE,
            turnstileToken: TURNSTILE_TOKEN,
        })

        expect(res.status).toBe(429)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("RATE_LIMITED")
        // سقف روی خود چالش/ایمیل هم اعمال می‌شود (max attempts)
        expect(mocks.isRateLimited).toHaveBeenCalledWith(`otp:verify:challenge:${EMAIL}`, 5)
        expect(mocks.otpFindFirst).not.toHaveBeenCalled()
        expect(mocks.verifyOtp).not.toHaveBeenCalled()
    })

    it("keys the attempts bucket by challengeId in the two-factor flow", async () => {
        await callPOST({
            challengeId: CHALLENGE_ID,
            code: CODE,
            turnstileToken: TURNSTILE_TOKEN,
        })

        expect(mocks.isRateLimited).toHaveBeenCalledWith(
            `otp:verify:challenge:${CHALLENGE_ID}`,
            5,
        )
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
        expect(mocks.createSession).not.toHaveBeenCalled()
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

    it("returns 400 OTP_NOT_FOUND when the challengeId is unknown", async () => {
        mocks.otpFindUnique.mockResolvedValue(null)

        const res = await callPOST({
            challengeId: "does-not-exist",
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

    it("returns 400 VALIDATION_ERROR when the code is missing but the captcha is valid", async () => {
        const res = await callPOST({ email: EMAIL, turnstileToken: TURNSTILE_TOKEN })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.otpFindFirst).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR when neither challengeId nor email is provided", async () => {
        const res = await callPOST({ code: "123456", turnstileToken: TURNSTILE_TOKEN })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.otpFindFirst).not.toHaveBeenCalled()
        expect(mocks.otpFindUnique).not.toHaveBeenCalled()
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
