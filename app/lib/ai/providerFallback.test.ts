import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* مرحلهٔ ۲ — fallback: 1xAI → OpenRouter                             */
/* ------------------------------------------------------------------ */
/* کل fallback در همین فایل و با fetch کاملاً mock آزموده می‌شود.        */
/* هیچ درخواستی به 1xAI یا OpenRouter واقعی نمی‌رود و هیچ API key واقعی */
/* استفاده نمی‌شود — همهٔ کلیدها مقادیر ساختگی تست هستند.               */
/*                                                                      */
/* قرارداد اصلی: quota یک «logical operation» است، نه تعداد provider   */
/* call؛ پس هیچ‌جا در این مسیر reserve/complete/release صدا زده نمی‌شود. */
/* آن‌ها در route و یک‌بار انجام می‌شوند (تست شده در fallback.quota.test). */

vi.hoisted(() => {
    process.env.AI_MAX_ATTEMPTS = "2"
    process.env.AI_TIMEOUT_MS = "3000"
})

const fetchMock = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", fetchMock)

import { ProviderUnusableError, NonRetryableError, RetryableError } from "@/app/lib/ai/providers"
import {
    AI_FALLBACK_MAX_ATTEMPTS,
    isAiFallbackEnabled,
    runAiOperation,
} from "@/app/lib/ai/providerClient"

const MESSAGES = [{ role: "user", content: "سلام" }]
const OK = JSON.stringify({ choices: [{ message: { content: "پاسخ" } }] })
const ok = () => new Response(OK, { status: 200 })
const status = (code: number) => new Response("boom", { status: code })

/** پاسخ 200 که محتوای خالی دارد → خطای «empty content» (قابل تلاش مجدد). */
const EMPTY_CONTENT = JSON.stringify({ choices: [{ message: { content: "   " } }] })

const urls = () => fetchMock.mock.calls.map((call) => String(call[0]))
const oneXaiCalls = () => urls().filter((u) => u.startsWith("https://1xai.ir")).length
const openRouterCalls = () => urls().filter((u) => u.startsWith("https://openrouter.ai")).length

const bothKeys = () => {
    vi.stubEnv("AIXAI_API_KEY", "aixai-key")
    vi.stubEnv("OPENROUTER_API_KEY", "or-key")
}

const clearEnv = () => {
    delete process.env.AIXAI_API_KEY
    delete process.env.AIXAI_BASE_URL
    delete process.env.OPENROUTER_API_KEY
    delete process.env.OPENROUTER_BASE_URL
    delete process.env.OPENROUTER_MODEL
    delete process.env.AI_ALLOW_FALLBACK
}

/** یک عملیات ساده که فقط متن خام provider را برمی‌گرداند. */
const rawOperation = () => runAiOperation({ buildMessages: () => MESSAGES })

/* ------------------------------------------------------------------ */

describe("feature flag AI_ALLOW_FALLBACK", () => {
    beforeEach(() => {
        fetchMock.mockReset()
        clearEnv()
    })
    afterEach(() => {
        vi.unstubAllEnvs()
        clearEnv()
    })

    it("defaults to disabled when the flag is absent", () => {
        expect(isAiFallbackEnabled()).toBe(false)
    })

    it.each(["", "0", "false", "no", "off", "TRUE ", "yes"])(
        "treats %o as disabled (fail-safe: never accidentally on)",
        (value) => {
            vi.stubEnv("AI_ALLOW_FALLBACK", value)
            expect(isAiFallbackEnabled()).toBe(false)
        },
    )

    it("is enabled only by the exact string \"true\"", () => {
        vi.stubEnv("AI_ALLOW_FALLBACK", "true")
        expect(isAiFallbackEnabled()).toBe(true)
    })

    it("exposes a bounded fallback attempt budget with a conservative default", () => {
        expect(AI_FALLBACK_MAX_ATTEMPTS).toBeGreaterThanOrEqual(1)
        expect(AI_FALLBACK_MAX_ATTEMPTS).toBeLessThanOrEqual(2)
    })
})

/* --- A — primary succeeds ------------------------------------------- */

describe("A — primary succeeds", () => {
    beforeEach(() => {
        // mockReset (نه clearAllMocks) لازم است تا پاسخ‌های queue‌شدهٔ تست قبلی
        // به تست بعدی نشت نکنند.
        fetchMock.mockReset()
        clearEnv()
        bothKeys()
        vi.stubEnv("AI_ALLOW_FALLBACK", "true")
    })
    afterEach(() => {
        vi.unstubAllEnvs()
        clearEnv()
    })

    it("calls only 1xAI and reports it as the effective provider", async () => {
        fetchMock.mockResolvedValue(ok())

        const result = await rawOperation()

        expect(oneXaiCalls()).toBe(1)
        expect(openRouterCalls()).toBe(0)
        expect(result.providerId).toBe("1xai")
        expect(result.fallbackUsed).toBe(false)
        expect(result.content).toBe("پاسخ")
    })

    it("is identical whether the flag is on or off", async () => {
        fetchMock.mockResolvedValue(ok())
        const withFlag = await rawOperation()

        vi.clearAllMocks()
        vi.stubEnv("AI_ALLOW_FALLBACK", "false")
        fetchMock.mockResolvedValue(ok())
        const withoutFlag = await rawOperation()

        expect(withoutFlag).toEqual(withFlag)
    })
})

/* --- B — primary retryable → retry → success ------------------------- */

describe("B — primary retries its own attempts before succeeding", () => {
    beforeEach(() => {
        // mockReset (نه clearAllMocks) لازم است تا پاسخ‌های queue‌شدهٔ تست قبلی
        // به تست بعدی نشت نکنند.
        fetchMock.mockReset()
        clearEnv()
        bothKeys()
        vi.stubEnv("AI_ALLOW_FALLBACK", "true")
    })
    afterEach(() => {
        vi.unstubAllEnvs()
        clearEnv()
    })

    it("retries the same provider and never touches the fallback", async () => {
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(ok())

        const result = await rawOperation()

        expect(oneXaiCalls()).toBe(2)
        expect(openRouterCalls()).toBe(0)
        expect(result.providerId).toBe("1xai")
        expect(result.fallbackUsed).toBe(false)
        expect(result.attempts).toBe(2)
    })

    it("retries on a 429 rate limit as before", async () => {
        fetchMock.mockResolvedValueOnce(status(429))
        fetchMock.mockResolvedValueOnce(ok())

        const result = await rawOperation()

        expect(openRouterCalls()).toBe(0)
        expect(result.providerId).toBe("1xai")
    })
})

/* --- C — primary exhausted → fallback -------------------------------- */

describe("C — primary exhausted → fallback", () => {
    beforeEach(() => {
        // mockReset (نه clearAllMocks) لازم است تا پاسخ‌های queue‌شدهٔ تست قبلی
        // به تست بعدی نشت نکنند.
        fetchMock.mockReset()
        clearEnv()
        bothKeys()
        vi.stubEnv("AI_ALLOW_FALLBACK", "true")
    })
    afterEach(() => {
        vi.unstubAllEnvs()
        clearEnv()
    })

    it("falls back only after the primary has used all its attempts", async () => {
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(ok())

        const result = await rawOperation()

        expect(oneXaiCalls()).toBe(2) // AI_MAX_ATTEMPTS=2
        expect(openRouterCalls()).toBe(1)
        expect(result.providerId).toBe("openrouter")
        expect(result.fallbackUsed).toBe(true)
    })

    it("returns the fallback provider content through the same raw pipeline", async () => {
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ choices: [{ message: { content: "پاسخ fallback" } }] }), {
                status: 200,
            }),
        )

        const result = await rawOperation()

        expect(result.content).toBe("پاسخ fallback")
    })

    it("does not fall back at all when the flag is off, even though it is configured", async () => {
        vi.stubEnv("AI_ALLOW_FALLBACK", "false")
        fetchMock.mockResolvedValue(status(503))

        const error: any = await rawOperation().catch((e) => e)

        expect(error).toBeInstanceOf(RetryableError)
        expect(oneXaiCalls()).toBe(2)
        expect(openRouterCalls()).toBe(0)
    })

    it("does not fall back when OpenRouter has no API key", async () => {
        delete process.env.OPENROUTER_API_KEY
        fetchMock.mockResolvedValue(status(503))

        const error: any = await rawOperation().catch((e) => e)

        expect(error).toBeInstanceOf(RetryableError)
        expect(oneXaiCalls()).toBe(2)
        expect(openRouterCalls()).toBe(0)
    })
})

/* --- D — network / timeout failure → fallback ------------------------ */

describe("D — primary network or timeout failure → fallback", () => {
    beforeEach(() => {
        // mockReset (نه clearAllMocks) لازم است تا پاسخ‌های queue‌شدهٔ تست قبلی
        // به تست بعدی نشت نکنند.
        fetchMock.mockReset()
        clearEnv()
        bothKeys()
        vi.stubEnv("AI_ALLOW_FALLBACK", "true")
    })
    afterEach(() => {
        vi.unstubAllEnvs()
        clearEnv()
    })

    it("falls back after exhausting retries on a network failure", async () => {
        fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"))
        fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"))
        fetchMock.mockResolvedValueOnce(ok())

        const result = await rawOperation()

        expect(openRouterCalls()).toBe(1)
        expect(result.providerId).toBe("openrouter")
        expect(result.fallbackUsed).toBe(true)
    })

    it("falls back after an abort/timeout on the primary", async () => {
        fetchMock.mockRejectedValueOnce(new Error("The operation was aborted"))
        fetchMock.mockRejectedValueOnce(new Error("The operation was aborted"))
        fetchMock.mockResolvedValueOnce(ok())

        const result = await rawOperation()

        expect(result.providerId).toBe("openrouter")
    })

    it("falls back when the primary keeps returning empty content", async () => {
        fetchMock.mockResolvedValueOnce(new Response(EMPTY_CONTENT, { status: 200 }))
        fetchMock.mockResolvedValueOnce(new Response(EMPTY_CONTENT, { status: 200 }))
        fetchMock.mockResolvedValueOnce(ok())

        const result = await rawOperation()

        expect(openRouterCalls()).toBe(1)
        expect(result.providerId).toBe("openrouter")
    })
})

/* --- F — all providers fail ------------------------------------------ */

describe("F — every provider fails", () => {
    beforeEach(() => {
        // mockReset (نه clearAllMocks) لازم است تا پاسخ‌های queue‌شدهٔ تست قبلی
        // به تست بعدی نشت نکنند.
        fetchMock.mockReset()
        clearEnv()
        bothKeys()
        vi.stubEnv("AI_ALLOW_FALLBACK", "true")
    })
    afterEach(() => {
        vi.unstubAllEnvs()
        clearEnv()
    })

    it("throws the primary error when the fallback also fails", async () => {
        fetchMock.mockResolvedValue(status(503))

        const error: any = await rawOperation().catch((e) => e)

        expect(error).toBeInstanceOf(RetryableError)
        expect(error.message).toBe("1xai HTTP 503")
        expect(oneXaiCalls()).toBe(2)
        expect(openRouterCalls()).toBeGreaterThanOrEqual(1)
    })

    it("surfaces the same error with the flag off, so enabling it cannot change the contract", async () => {
        fetchMock.mockResolvedValue(status(503))
        const withFlag: any = await rawOperation().catch((e) => e)

        fetchMock.mockReset()
        vi.stubEnv("AI_ALLOW_FALLBACK", "false")
        fetchMock.mockResolvedValue(status(503))
        const withoutFlag: any = await rawOperation().catch((e) => e)

        expect(withFlag.message).toBe(withoutFlag.message)
        expect(withFlag.constructor).toBe(withoutFlag.constructor)
    })

    it("gives the fallback only its own bounded number of attempts", async () => {
        fetchMock.mockResolvedValue(status(503))

        await rawOperation().catch(() => undefined)

        expect(openRouterCalls()).toBe(AI_FALLBACK_MAX_ATTEMPTS)
    })

    it("never reports success when nothing succeeded", async () => {
        fetchMock.mockResolvedValue(status(503))

        const result = await rawOperation().then(
            (value) => ({ ok: true, value }),
            (error) => ({ ok: false, error }),
        )

        expect(result.ok).toBe(false)
    })
})

/* --- G — invalid request: no blind fallback -------------------------- */

describe("G — a definitive request error never triggers fallback", () => {
    beforeEach(() => {
        // mockReset (نه clearAllMocks) لازم است تا پاسخ‌های queue‌شدهٔ تست قبلی
        // به تست بعدی نشت نکنند.
        fetchMock.mockReset()
        clearEnv()
        bothKeys()
        vi.stubEnv("AI_ALLOW_FALLBACK", "true")
    })
    afterEach(() => {
        vi.unstubAllEnvs()
        clearEnv()
    })

    it.each([400, 404])("does not retry or fall back on HTTP %i", async (code) => {
        fetchMock.mockResolvedValue(status(code))

        const error: any = await rawOperation().catch((e) => e)

        expect(error).toBeInstanceOf(NonRetryableError)
        expect(oneXaiCalls()).toBe(1)
        expect(openRouterCalls()).toBe(0)
    })

    it("reaches the fallback only after a real 4xx rejection from the provider", async () => {
        fetchMock.mockResolvedValueOnce(status(400))
        fetchMock.mockResolvedValueOnce(ok())

        const error: any = await rawOperation().catch((e) => e)

        expect(error).toBeInstanceOf(NonRetryableError)
        expect(error.message).toContain("1xai HTTP 400")
        expect(openRouterCalls()).toBe(0)
    })
})

/* --- H — provider unusable: auth/config failure ---------------------- */

describe("H — a provider with a bad key is skipped, not fatal", () => {
    beforeEach(() => {
        // mockReset (نه clearAllMocks) لازم است تا پاسخ‌های queue‌شدهٔ تست قبلی
        // به تست بعدی نشت نکنند.
        fetchMock.mockReset()
        clearEnv()
        bothKeys()
        vi.stubEnv("AI_ALLOW_FALLBACK", "true")
    })
    afterEach(() => {
        vi.unstubAllEnvs()
        clearEnv()
    })

    it.each([401, 403])("falls back immediately on HTTP %i without retrying it", async (code) => {
        fetchMock.mockResolvedValueOnce(status(code))
        fetchMock.mockResolvedValueOnce(ok())

        const result = await rawOperation()

        expect(oneXaiCalls()).toBe(1) // no retry on auth failure
        expect(openRouterCalls()).toBe(1)
        expect(result.providerId).toBe("openrouter")
        expect(result.fallbackUsed).toBe(true)
    })

    it("distinguishes an unusable provider from a definitive request error", async () => {
        vi.stubEnv("AI_ALLOW_FALLBACK", "false")
        fetchMock.mockResolvedValueOnce(status(401))

        const error: any = await rawOperation().catch((e) => e)

        // با fallback خاموش، خطای 401 باید همان رفتار قطعی قبلی را نگه دارد
        expect(error).toBeInstanceOf(ProviderUnusableError)
        expect(error).toBeInstanceOf(NonRetryableError)
        expect(openRouterCalls()).toBe(0)
    })

    it("skips the fallback too when it is the one with the bad key", async () => {
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(status(401))

        const error: any = await rawOperation().catch((e) => e)

        expect(error).toBeInstanceOf(RetryableError)
        // خطای برگشتی همیشه خطای provider اصلی است، حتی وقتی fallback شکست خورده —
        // تا روشن‌کردن flag قرارداد خطا را عوض نکند.
        expect(error.message).toBe("1xai HTTP 503")
        expect(openRouterCalls()).toBe(1) // بی‌فایده تکرار نشد
    })
})
