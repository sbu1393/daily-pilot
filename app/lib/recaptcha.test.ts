import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { verifyRecaptcha } from "./recaptcha"

/* ------------------------------------------------------------------ */
/* Unit test: app/lib/recaptcha.ts — verifyRecaptcha (reCAPTCHA v3)     */
/* fetch و RECAPTCHA_SECRET_KEY mock می‌شوند: هیچ تماس شبکه‌ای واقعی    */
/* با Google انجام نمی‌شود.                                            */
/* ------------------------------------------------------------------ */

const SITEVERIFY_URL = "https://www.google.com/recaptcha/api/siteverify"
const SECRET = "test-secret"
const TOKEN = "test-token"

/** پاسخ شبیه‌سازی‌شدهٔ Remix/undici Response — فقط چیزهایی که کد می‌خواند. */
const jsonResponse = (payload: unknown, ok = true) =>
    ({ ok, json: async () => payload }) as unknown as Response

/** پاسخ با بدنهٔ غیرقابل‌تجزیه (شبیه‌سازی HTML خطای گوگل). */
const brokenJsonResponse = (ok = true) =>
    ({ ok, json: async () => { throw new Error("invalid json") } }) as unknown as Response

describe("verifyRecaptcha — reCAPTCHA v3 siteverify contract", () => {
    let fetchMock: ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>

    beforeEach(() => {
        fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
        vi.stubGlobal("fetch", fetchMock)
        vi.stubEnv("RECAPTCHA_SECRET_KEY", SECRET)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.unstubAllEnvs()
    })

    /* -------------------------------------------------------------- */
    /* سناریوی موفقیت                                                  */
    /* -------------------------------------------------------------- */

    it("returns true when Google answers success:true with a score above the threshold", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ success: true, score: 0.9, action: "register" }))

        await expect(verifyRecaptcha(TOKEN)).resolves.toBe(true)
    })

    it("posts the secret and the token (urlencoded) to Google's siteverify endpoint", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ success: true, score: 0.9 }))

        await verifyRecaptcha(TOKEN)

        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe(SITEVERIFY_URL)
        expect(init.method).toBe("POST")

        const params = init.body as URLSearchParams
        expect(params.get("secret")).toBe(SECRET)
        expect(params.get("response")).toBe(TOKEN)
    })

    it("accepts the default threshold boundary (score exactly 0.5 → true)", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ success: true, score: 0.5 }))

        await expect(verifyRecaptcha(TOKEN)).resolves.toBe(true)
    })

    it("treats a missing score as acceptable (v3 may omit it) as long as success is true", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ success: true }))

        await expect(verifyRecaptcha(TOKEN)).resolves.toBe(true)
    })

    /* -------------------------------------------------------------- */
    /* سناریوی شکست                                                    */
    /* -------------------------------------------------------------- */

    it("returns false when Google answers success:false", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ success: false, "error-codes": ["invalid-input-response"] }),
        )

        await expect(verifyRecaptcha(TOKEN)).resolves.toBe(false)
    })

    it("returns false when the score is below the 0.5 threshold (bot-like)", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ success: true, score: 0.1 }))

        await expect(verifyRecaptcha(TOKEN)).resolves.toBe(false)
    })

    it("honors a custom minScore option", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ success: true, score: 0.7 }))

        await expect(verifyRecaptcha(TOKEN, { minScore: 0.9 })).resolves.toBe(false)
    })

    it("returns false on a non-2xx siteverify response", async () => {
        fetchMock.mockResolvedValue(jsonResponse({}, false))

        await expect(verifyRecaptcha(TOKEN)).resolves.toBe(false)
    })

    it("returns false when the response body cannot be parsed", async () => {
        fetchMock.mockResolvedValue(brokenJsonResponse())

        await expect(verifyRecaptcha(TOKEN)).resolves.toBe(false)
    })

    /* -------------------------------------------------------------- */
    /* fail-closed — بدون کرش، همیشه false                             */
    /* -------------------------------------------------------------- */

    it("fails closed (false, no network call) when RECAPTCHA_SECRET_KEY is not configured", async () => {
        vi.stubEnv("RECAPTCHA_SECRET_KEY", "")

        await expect(verifyRecaptcha(TOKEN)).resolves.toBe(false)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it.each([
        ["empty", ""],
        ["whitespace-only", "   "],
    ])("fails closed (false, no network call) for a(n) %s token", async (_label, token) => {
        await expect(verifyRecaptcha(token)).resolves.toBe(false)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("returns false instead of throwing when the network request rejects", async () => {
        fetchMock.mockRejectedValue(new Error("ENOTFOUND www.google.com"))

        await expect(verifyRecaptcha(TOKEN)).resolves.toBe(false)
    })
})
