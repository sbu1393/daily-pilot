import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* Unit test: app/lib/services/otp.service.ts                          */
/* lib/otp و resend و getPrisma mock شده‌اند → بدون bcrypt، بدون DB و   */
/* بدون ایمیل واقعی.                                                   */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    generateOtpCode: vi.fn(),
    hashOtp: vi.fn(),
    emailSend: vi.fn(),
    getPrisma: vi.fn(),
}))

vi.mock("@/lib/otp", () => ({
    generateOtpCode: mocks.generateOtpCode,
    hashOtp: mocks.hashOtp,
}))
vi.mock("resend", () => ({
    Resend: class {
        emails = { send: mocks.emailSend }
    },
}))
vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: mocks.getPrisma }))

import {
    OTP_MAX_ATTEMPTS,
    OTP_TTL_MS,
    createOtpChallenge,
    otpEmailHtml,
    otpEmailSubject,
    sendOtpEmail,
} from "./otp.service"

/** کلاینت جعلی — فقط مرزی که سرویس لازم دارد. */
function makeClient(recordId = "otp_1") {
    const create = vi.fn().mockResolvedValue({ id: recordId })
    return { client: { otpCode: { create } }, create }
}

describe("createOtpChallenge", () => {
    const NOW = new Date("2026-09-20T10:00:00.000Z")

    beforeEach(() => {
        vi.clearAllMocks()
        mocks.generateOtpCode.mockReturnValue("123456")
        mocks.hashOtp.mockResolvedValue("hashed-code")
        mocks.getPrisma.mockReturnValue({})
    })

    it("persists only the hash with a 10-minute expiry and returns the challenge id + raw code", async () => {
        const { client, create } = makeClient("otp_42")

        const challenge = await createOtpChallenge("user@example.com", client, NOW)

        expect(create).toHaveBeenCalledTimes(1)
        const arg = create.mock.calls[0][0] as {
            data: { email: string; codeHash: string; expiresAt: Date }
        }
        expect(arg.data.email).toBe("user@example.com")
        expect(arg.data.codeHash).toBe("hashed-code")
        // کد خام هرگز persist نمی‌شود
        expect(JSON.stringify(arg)).not.toContain("123456")
        expect(arg.data.expiresAt.getTime() - NOW.getTime()).toBe(OTP_TTL_MS)

        expect(challenge).toEqual({
            challengeId: "otp_42",
            code: "123456",
            expiresAt: arg.data.expiresAt,
        })
    })

    it("uses the documented TTL and max-attempt constants", () => {
        expect(OTP_TTL_MS).toBe(10 * 60 * 1000)
        expect(OTP_MAX_ATTEMPTS).toBe(5)
    })

    it("propagates a persistence failure to the caller (route maps it)", async () => {
        const create = vi.fn().mockRejectedValue(new Error("db down"))

        await expect(
            createOtpChallenge("user@example.com", { otpCode: { create } }, NOW),
        ).rejects.toThrow("db down")
    })
})

describe("OTP email payload", () => {
    it("builds the subject and html with the code but no secret material", () => {
        const html = otpEmailHtml("123456")

        expect(otpEmailSubject()).toBe("کد تأیید DailyPilot")
        expect(html).toContain("123456")
        expect(html).toContain("۱۰ دقیقه")
    })
})

describe("sendOtpEmail", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.stubEnv("RESEND_API_KEY", "test-key")
    })

    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it("returns { sent: true } and passes the code in the html on success", async () => {
        // قرارداد واقعی SDK: { data: { id }, error: null }
        mocks.emailSend.mockResolvedValue({ data: { id: "email_1" }, error: null })

        const result = await sendOtpEmail("user@example.com", "123456")

        expect(result).toEqual({ sent: true, id: "email_1" })
        const arg = mocks.emailSend.mock.calls[0][0] as { to: string; html: string }
        expect(arg.to).toBe("user@example.com")
        expect(arg.html).toContain("123456")
    })

    it("surfaces a provider API error as { sent: false } instead of swallowing it", async () => {
        mocks.emailSend.mockResolvedValue({
            data: null,
            error: { message: "domain not verified", name: "validation_error", statusCode: 403 },
        })
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

        const result = await sendOtpEmail("user@example.com", "123456")

        expect(result).toEqual({ sent: false, error: "domain not verified" })
        errorSpy.mockRestore()
    })

    it("surfaces a thrown provider/network failure as { sent: false }", async () => {
        mocks.emailSend.mockRejectedValue(new Error("network down"))
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

        const result = await sendOtpEmail("user@example.com", "123456")

        expect(result.sent).toBe(false)
        errorSpy.mockRestore()
    })

    it("reports missing configuration as { sent: false } without calling the provider", async () => {
        vi.stubEnv("RESEND_API_KEY", "")

        const result = await sendOtpEmail("user@example.com", "123456")

        expect(result).toEqual({ sent: false, error: "RESEND_API_KEY is not configured" })
        expect(mocks.emailSend).not.toHaveBeenCalled()
    })
})
