import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { verifyTurnstile } from "./turnstile"

/* ------------------------------------------------------------------ */
/* Unit test: app/lib/turnstile.ts — verifyTurnstile (Cloudflare)      */
/* fetch و متغیرهای محیطی mock می‌شوند: هیچ تماس شبکه‌ای واقعی با        */
/* Cloudflare انجام نمی‌شود. این تست‌ها قرارداد HTTP لایهٔ کپچا را قفل    */
/* می‌کنند (لایهٔ کپچای قبلی پروژه حذف شده است).                        */
/* ------------------------------------------------------------------ */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
const SECRET = "test-secret"
const TOKEN = "test-token"
const HOSTNAME = "app.example.com"

/** پاسخ شبیه‌سازی‌شدهٔ Response — فقط چیزهایی که کد می‌خواند. */
const jsonResponse = (payload: unknown, ok = true) =>
    ({ ok, json: async () => payload }) as unknown as Response

/** پاسخ با بدنهٔ غیرقابل‌تجزیه (شبیه‌سازی HTML خطای Cloudflare). */
const brokenJsonResponse = (ok = true) =>
    ({ ok, json: async () => { throw new Error("invalid json") } }) as unknown as Response

/** پاسخ موفق استاندارد Cloudflare. */
const successResponse = (extra: Record<string, unknown> = {}) =>
    jsonResponse({ success: true, hostname: HOSTNAME, action: "register", ...extra })

describe("verifyTurnstile — Cloudflare siteverify contract", () => {
    let fetchMock: ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>

    beforeEach(() => {
        fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
        vi.stubGlobal("fetch", fetchMock)
        vi.stubEnv("TURNSTILE_SECRET_KEY", SECRET)
        vi.stubEnv("TURNSTILE_ALLOWED_HOSTNAMES", "")
        vi.stubEnv("NODE_ENV", "test")
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.unstubAllEnvs()
    })

    /* -------------------------------------------------------------- */
    /* سناریوی موفقیت                                                  */
    /* -------------------------------------------------------------- */

    it("returns true when Cloudflare answers success:true with a matching action", async () => {
        fetchMock.mockResolvedValue(successResponse())

        await expect(
            verifyTurnstile(TOKEN, { expectedAction: "register" }),
        ).resolves.toBe(true)
    })

    it("posts secret/response (urlencoded) to Cloudflare's siteverify with an abort signal", async () => {
        fetchMock.mockResolvedValue(successResponse())

        await verifyTurnstile(TOKEN, { expectedAction: "register" })

        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe(SITEVERIFY_URL)
        expect(init.method).toBe("POST")

        const params = init.body as URLSearchParams
        expect(params.get("secret")).toBe(SECRET)
        expect(params.get("response")).toBe(TOKEN)

        // تایماوت با AbortSignal اعمال می‌شود
        expect(init.signal).toBeInstanceOf(AbortSignal)
    })

    it("passes the visitor IP as remoteip when provided", async () => {
        fetchMock.mockResolvedValue(successResponse())

        await verifyTurnstile(TOKEN, { remoteIp: "203.0.113.7" })

        const params = fetchMock.mock.calls[0][1].body as URLSearchParams
        expect(params.get("remoteip")).toBe("203.0.113.7")
    })

    it("ignores the action when no expectedAction is required", async () => {
        fetchMock.mockResolvedValue(successResponse({ action: "anything" }))

        await expect(verifyTurnstile(TOKEN)).resolves.toBe(true)
    })

    /* -------------------------------------------------------------- */
    /* توکن نامعتبر / منقضی / مصرف‌شده                                  */
    /* -------------------------------------------------------------- */

    it("returns false for an invalid token (success:false, invalid-input-response)", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ success: false, "error-codes": ["invalid-input-response"] }),
        )

        await expect(verifyTurnstile(TOKEN)).resolves.toBe(false)
    })

    it("returns false for an expired or already-used token (timeout-or-duplicate)", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ success: false, "error-codes": ["timeout-or-duplicate"] }),
        )

        await expect(
            verifyTurnstile(TOKEN, { expectedAction: "send_otp" }),
        ).resolves.toBe(false)
    })

    /* -------------------------------------------------------------- */
    /* hostname — allowlist سرور (نه Host header)                       */
    /* -------------------------------------------------------------- */

    it("accepts a hostname that is explicitly allowlisted", async () => {
        vi.stubEnv("TURNSTILE_ALLOWED_HOSTNAMES", "app.example.com, localhost")
        fetchMock.mockResolvedValue(successResponse())

        await expect(verifyTurnstile(TOKEN)).resolves.toBe(true)
    })

    it("supports wildcard subdomain entries in the allowlist", async () => {
        vi.stubEnv("TURNSTILE_ALLOWED_HOSTNAMES", "*.example.com")
        fetchMock.mockResolvedValue(successResponse({ hostname: "preview.example.com" }))

        await expect(verifyTurnstile(TOKEN)).resolves.toBe(true)
    })

    it("returns false when the response hostname is not in the allowlist", async () => {
        vi.stubEnv("TURNSTILE_ALLOWED_HOSTNAMES", "app.example.com")
        fetchMock.mockResolvedValue(successResponse({ hostname: "evil.example.net" }))

        await expect(verifyTurnstile(TOKEN)).resolves.toBe(false)
    })

    it("returns false when an allowlist is configured but the response has no hostname", async () => {
        vi.stubEnv("TURNSTILE_ALLOWED_HOSTNAMES", "app.example.com")
        fetchMock.mockResolvedValue(jsonResponse({ success: true }))

        await expect(verifyTurnstile(TOKEN)).resolves.toBe(false)
    })

    it("fails closed (no network call) in production when no hostname allowlist is configured", async () => {
        vi.stubEnv("NODE_ENV", "production")
        vi.stubEnv("TURNSTILE_ALLOWED_HOSTNAMES", "")

        await expect(verifyTurnstile(TOKEN)).resolves.toBe(false)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("allows an unconfigured allowlist outside production (local dev)", async () => {
        vi.stubEnv("NODE_ENV", "development")
        fetchMock.mockResolvedValue(successResponse())

        await expect(verifyTurnstile(TOKEN)).resolves.toBe(true)
    })

    /* -------------------------------------------------------------- */
    /* action مورد انتظار سرور                                          */
    /* -------------------------------------------------------------- */

    it("returns false when the action does not match the server expectation", async () => {
        fetchMock.mockResolvedValue(successResponse({ action: "login" }))

        await expect(
            verifyTurnstile(TOKEN, { expectedAction: "register" }),
        ).resolves.toBe(false)
    })

    it("returns false when the response carries no action but one is expected", async () => {
        fetchMock.mockResolvedValue(jsonResponse({ success: true, hostname: HOSTNAME }))

        await expect(
            verifyTurnstile(TOKEN, { expectedAction: "verify_otp" }),
        ).resolves.toBe(false)
    })

    /* -------------------------------------------------------------- */
    /* fail-closed — پیکربندی، شبکه، تایماوت، پاسخ خراب                 */
    /* -------------------------------------------------------------- */

    it("fails closed (false, no network call) when TURNSTILE_SECRET_KEY is not configured", async () => {
        vi.stubEnv("TURNSTILE_SECRET_KEY", "")

        await expect(verifyTurnstile(TOKEN)).resolves.toBe(false)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it.each([
        ["empty", ""],
        ["whitespace-only", "   "],
    ])("fails closed (false, no network call) for a(n) %s token", async (_label, token) => {
        await expect(verifyTurnstile(token)).resolves.toBe(false)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("returns false on a non-2xx siteverify response", async () => {
        fetchMock.mockResolvedValue(jsonResponse({}, false))

        await expect(verifyTurnstile(TOKEN)).resolves.toBe(false)
    })

    it("returns false when the response body cannot be parsed", async () => {
        fetchMock.mockResolvedValue(brokenJsonResponse())

        await expect(verifyTurnstile(TOKEN)).resolves.toBe(false)
    })

    it("returns false instead of throwing when the network request rejects (DNS/offline)", async () => {
        fetchMock.mockRejectedValue(new Error("ENOTFOUND challenges.cloudflare.com"))

        await expect(verifyTurnstile(TOKEN)).resolves.toBe(false)
    })

    it("returns false when Cloudflare does not answer before the timeout aborts the request", async () => {
        fetchMock.mockImplementation((_url, init) => {
            return new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener("abort", () =>
                    reject(new DOMException("The operation was aborted.", "TimeoutError")),
                )
            })
        })

        await expect(verifyTurnstile(TOKEN, { timeoutMs: 20 })).resolves.toBe(false)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })
})
