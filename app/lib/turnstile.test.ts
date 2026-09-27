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

/**
 * پاسخ شبیه‌سازی‌شدهٔ Response — فقط چیزهایی که کد می‌خواند.
 * `status` هم مدل می‌شود چون Response واقعی همیشه آن را دارد و کد از آن در لاگ
 * تشخیصی استفاده می‌کند (وگرنه لاگ در تست مقدار undefined می‌گیرد).
 */
const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500) =>
    ({ ok, status, json: async () => payload }) as unknown as Response

/** پاسخ با بدنهٔ غیرقابل‌تجزیه (شبیه‌سازی HTML خطای Cloudflare). */
const brokenJsonResponse = (ok = true) =>
    ({ ok, status: ok ? 200 : 500, json: async () => { throw new Error("invalid json") } }) as unknown as Response

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

/* ------------------------------------------------------------------ */
/* لاگ تشخیصی — «تیک سبز کلاینت ولی رد سرور»                           */
/* هر مسیر شکست باید دقیقاً یک لاگ ساختاریافته بنویسد و هیچ‌وقت secret   */
/* یا مقدار کامل توکن را افشا نکند.                                   */
/* ------------------------------------------------------------------ */

describe("verifyTurnstile — server-side diagnostics", () => {
    let fetchMock: ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>>
    let warnSpy: ReturnType<typeof spyOnConsoleWarn>

    /** اسپای console.warn با نوع دقیق (بدون any در محل تعریف). */
    const spyOnConsoleWarn = () => vi.spyOn(console, "warn").mockImplementation(() => {})

    /** پاسخ غیر-2xx شبیه‌سازی‌شده (فقط ok/status خوانده می‌شوند). */
    const httpErrorResponse = (status: number) =>
        ({ ok: false, status, json: async () => ({}) }) as unknown as Response

    beforeEach(() => {
        fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
        vi.stubGlobal("fetch", fetchMock)
        vi.stubEnv("TURNSTILE_SECRET_KEY", SECRET)
        vi.stubEnv("TURNSTILE_ALLOWED_HOSTNAMES", "")
        vi.stubEnv("NODE_ENV", "test")
        warnSpy = spyOnConsoleWarn()
    })

    afterEach(() => {
        vi.unstubAllGlobals()
        vi.unstubAllEnvs()
        vi.restoreAllMocks()
    })

    /** آخرین (و تنها) لاگ رد شدن: پیام + فیلدهای ساختاریافته. */
    const rejection = () => {
        expect(warnSpy).toHaveBeenCalledTimes(1)
        const [message, fields] = warnSpy.mock.calls[0] as unknown as [string, Record<string, unknown>]
        return { message, fields }
    }

    /** هیچ لاگی نباید secret یا مقدار کامل توکن را در خود داشته باشد. */
    const expectNoSecretLeak = () => {
        const logged = JSON.stringify(warnSpy.mock.calls)
        expect(logged).not.toContain(SECRET)
        expect(logged).not.toContain(TOKEN)
    }

    it("logs MISSING_SECRET as a boolean (never the secret value)", async () => {
        vi.stubEnv("TURNSTILE_SECRET_KEY", "")

        await expect(verifyTurnstile(TOKEN)).resolves.toBe(false)

        const { message, fields } = rejection()
        expect(message).toContain("[turnstile]")
        expect(message).toContain("MISSING_SECRET")
        expect(fields.hasSecret).toBe(false)
        expect(fields.hasToken).toBe(true)
        expect(fields.tokenLength).toBe(TOKEN.length)
        expect(fetchMock).not.toHaveBeenCalled()
        expectNoSecretLeak()
    })

    it("logs EMPTY_TOKEN (boolean) when the client sent no token", async () => {
        await expect(verifyTurnstile("")).resolves.toBe(false)

        const { message, fields } = rejection()
        expect(message).toContain("EMPTY_TOKEN")
        expect(fields.hasSecret).toBe(true)
        expect(fields.hasToken).toBe(false)
        expect(fields.tokenLength).toBe(0)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("logs PRODUCTION_WITHOUT_ALLOWLIST (the no-network production rejection)", async () => {
        vi.stubEnv("NODE_ENV", "production")
        vi.stubEnv("TURNSTILE_ALLOWED_HOSTNAMES", "")

        await expect(verifyTurnstile(TOKEN)).resolves.toBe(false)

        const { message, fields } = rejection()
        expect(message).toContain("PRODUCTION_WITHOUT_ALLOWLIST")
        expect(fields.allowlistConfigured).toBe(false)
        expect(fields.nodeEnv).toBe("production")
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("logs Cloudflare error-codes when success !== true", async () => {
        fetchMock.mockResolvedValue(
            jsonResponse({ success: false, "error-codes": ["invalid-input-secret"] }),
        )

        await expect(verifyTurnstile(TOKEN)).resolves.toBe(false)

        const { message, fields } = rejection()
        expect(message).toContain("NOT_SUCCESS")
        expect(fields.errorCodes).toEqual(["invalid-input-secret"])
        expectNoSecretLeak()
    })

    it("logs the HTTP status when Cloudflare answers non-2xx", async () => {
        fetchMock.mockResolvedValue(httpErrorResponse(502))

        await expect(verifyTurnstile(TOKEN)).resolves.toBe(false)

        const { message, fields } = rejection()
        expect(message).toContain("HTTP_ERROR")
        expect(fields.httpStatus).toBe(502)
    })

    it("logs INVALID_JSON when the siteverify body cannot be parsed", async () => {
        fetchMock.mockResolvedValue(brokenJsonResponse())

        await expect(verifyTurnstile(TOKEN)).resolves.toBe(false)

        expect(rejection().message).toContain("INVALID_JSON")
    })

    it("logs the returned hostname and the allowlist it was compared against", async () => {
        vi.stubEnv("TURNSTILE_ALLOWED_HOSTNAMES", "app.example.com")
        fetchMock.mockResolvedValue(
            successResponse({ hostname: "evil.example.net", action: "register" }),
        )

        await expect(
            verifyTurnstile(TOKEN, { expectedAction: "register" }),
        ).resolves.toBe(false)

        const { message, fields } = rejection()
        expect(message).toContain("HOSTNAME_NOT_ALLOWED")
        expect(fields.returnedHostname).toBe("evil.example.net")
        expect(fields.allowedHostnames).toEqual(["app.example.com"])
        expect(fields.hostnameAllowed).toBe(false)
        // action درست بوده؛ رد شدن فقط به‌خاطر دامنه است
        expect(fields.actionAllowed).toBe(true)
    })

    it("logs the returned action next to the expected action", async () => {
        fetchMock.mockResolvedValue(successResponse({ action: "login" }))

        await expect(
            verifyTurnstile(TOKEN, { expectedAction: "register" }),
        ).resolves.toBe(false)

        const { message, fields } = rejection()
        expect(message).toContain("ACTION_MISMATCH")
        expect(fields.returnedAction).toBe("login")
        expect(fields.expectedAction).toBe("register")
        // دامنه پیکربندی نشده (خارج production) پس مجاز است؛ رد فقط از action است
        expect(fields.hostnameAllowed).toBe(true)
        expect(fields.actionAllowed).toBe(false)
    })

    it("logs NETWORK_ERROR with the error name (e.g. timeout) instead of throwing", async () => {
        fetchMock.mockImplementation((_url, init) => {
            return new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener("abort", () =>
                    reject(new DOMException("The operation was aborted.", "TimeoutError")),
                )
            })
        })

        await expect(verifyTurnstile(TOKEN, { timeoutMs: 20 })).resolves.toBe(false)

        const { message, fields } = rejection()
        expect(message).toContain("NETWORK_ERROR")
        expect(fields.errorName).toBe("TimeoutError")
        expectNoSecretLeak()
    })

    it("writes no rejection when the verification succeeds, but logs an `accepted` line with success/action", async () => {
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
        fetchMock.mockResolvedValue(successResponse())

        await expect(
            verifyTurnstile(TOKEN, { expectedAction: "register" }),
        ).resolves.toBe(true)

        // هرگز لاگ «rejected» برای مسیر موفق
        expect(warnSpy).not.toHaveBeenCalled()

        // یک خط موفقیت: برای تفکیک «کپچا تأیید شد» از خطاهای بعدی (مثل ارسال ایمیل)
        expect(logSpy).toHaveBeenCalledTimes(1)
        const [message, fields] = logSpy.mock.calls[0] as unknown as [string, Record<string, unknown>]
        expect(message).toContain("accepted")
        expect(fields.success).toBe(true)
        expect(fields.httpStatus).toBe(200)
        expect(fields.returnedAction).toBe("register")
        expect(fields.expectedAction).toBe("register")
        expect(fields.actionAllowed).toBe(true)

        const logged = JSON.stringify(logSpy.mock.calls)
        expect(logged).not.toContain(SECRET)
        expect(logged).not.toContain(TOKEN)
    })
})
