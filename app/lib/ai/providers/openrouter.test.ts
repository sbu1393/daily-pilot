import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* provider «openrouter» — تعریف‌شده ولی غیرفعال                        */
/* ------------------------------------------------------------------ */
/* هیچ درخواستی به شبکهٔ واقعی نمی‌رود؛ fetch کاملاً mock است. هدف این */
/* تست‌ها اثبات این است که اگر روزی فعال شد، رفتار transport درست و */
/* قابل پیش‌بینی است — و اینکه هدرهای اختیاری hardcode نشده‌اند.        */

const fetchMock = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", fetchMock)

import { NonRetryableError, RetryableError } from "@/app/lib/ai/providers"
import { openRouterProvider } from "@/app/lib/ai/providers/openrouter"

const MESSAGES = [
    { role: "system", content: "sys" },
    { role: "user", content: "user" },
]

const PROVIDER_OK = JSON.stringify({ choices: [{ message: { content: "سلام" } }] })
const httpStatus = (status: number, body = "boom") => new Response(body, { status })

const config = () => openRouterProvider.resolveConfig({ timeoutMs: 5000 })

const clearOpenRouterEnv = () => {
    delete process.env.OPENROUTER_API_KEY
    delete process.env.OPENROUTER_BASE_URL
    delete process.env.OPENROUTER_MODEL
    delete process.env.OPENROUTER_REFERER
    delete process.env.OPENROUTER_TITLE
}

describe("openRouterProvider — پیکربندی", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        clearOpenRouterEnv()
    })
    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it("declares the exact default base URL and model", () => {
        expect(openRouterProvider.id).toBe("openrouter")
        expect(openRouterProvider.defaultBaseUrl).toBe("https://openrouter.ai/api/v1")
        expect(openRouterProvider.defaultModel).toBe("qwen/qwen3.8-27b:free")
        expect(openRouterProvider.apiKeyEnv).toBe("OPENROUTER_API_KEY")
    })

    it("throws a non-retryable error naming its own env var when the key is absent", () => {
        expect(() => openRouterProvider.resolveConfig()).toThrow(NonRetryableError)
        expect(() => openRouterProvider.resolveConfig()).toThrow("OPENROUTER_API_KEY missing")
    })

    it("honours OPENROUTER_BASE_URL and OPENROUTER_MODEL overrides", () => {
        vi.stubEnv("OPENROUTER_API_KEY", "k")
        vi.stubEnv("OPENROUTER_BASE_URL", "https://proxy.invalid/api/v1")
        vi.stubEnv("OPENROUTER_MODEL", "some/other-model")

        const resolved = openRouterProvider.resolveConfig()

        expect(resolved.baseUrl).toBe("https://proxy.invalid/api/v1")
        expect(resolved.model).toBe("some/other-model")
    })
})

describe("openRouterProvider — درخواست HTTP (بدون شبکهٔ واقعی)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        clearOpenRouterEnv()
        vi.stubEnv("OPENROUTER_API_KEY", "or-key")
    })
    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it("posts to the OpenRouter /chat/completions endpoint with the configured model", async () => {
        fetchMock.mockResolvedValue(new Response(PROVIDER_OK, { status: 200 }))

        const content = await openRouterProvider.complete(config(), MESSAGES)

        expect(content).toBe("سلام")
        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe("https://openrouter.ai/api/v1/chat/completions")
        expect(init.method).toBe("POST")
        expect(init.headers.Authorization).toBe("Bearer or-key")
        expect(init.headers["Content-Type"]).toBe("application/json")
        expect(JSON.parse(init.body)).toEqual({
            model: "qwen/qwen3.8-27b:free",
            temperature: 0.2,
            messages: MESSAGES,
        })
    })

    it("omits the optional attribution headers when they are not configured", async () => {
        fetchMock.mockResolvedValue(new Response(PROVIDER_OK, { status: 200 }))

        await openRouterProvider.complete(config(), MESSAGES)

        const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
        expect(headers["HTTP-Referer"]).toBeUndefined()
        expect(headers["X-Title"]).toBeUndefined()
    })

    it("sends the optional attribution headers only when they come from env", async () => {
        vi.stubEnv("OPENROUTER_REFERER", "https://rouzsaz.ir")
        vi.stubEnv("OPENROUTER_TITLE", "Roozsaaz")
        fetchMock.mockResolvedValue(new Response(PROVIDER_OK, { status: 200 }))

        await openRouterProvider.complete(config(), MESSAGES)

        const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
        expect(headers["HTTP-Referer"]).toBe("https://rouzsaz.ir")
        expect(headers["X-Title"]).toBe("Roozsaaz")
    })

    it("ignores blank attribution env values instead of sending empty headers", async () => {
        vi.stubEnv("OPENROUTER_REFERER", "   ")
        vi.stubEnv("OPENROUTER_TITLE", "")
        fetchMock.mockResolvedValue(new Response(PROVIDER_OK, { status: 200 }))

        await openRouterProvider.complete(config(), MESSAGES)

        const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
        expect("HTTP-Referer" in headers).toBe(false)
        expect("X-Title" in headers).toBe(false)
    })

    it("extracts the assistant content from the OpenAI-shaped response", async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ choices: [{ message: { content: "پاسخ بلند" } }] }), {
                status: 200,
            }),
        )

        await expect(openRouterProvider.complete(config(), MESSAGES)).resolves.toBe("پاسخ بلند")
    })

    it.each([408, 429, 500, 502, 503, 504])("maps HTTP %i to a retryable error", async (status) => {
        fetchMock.mockResolvedValue(httpStatus(status))

        const error: any = await openRouterProvider.complete(config(), MESSAGES).catch((e) => e)

        expect(error).toBeInstanceOf(RetryableError)
        expect(error.message).toBe(`openrouter HTTP ${status}`)
    })

    it.each([400, 401, 403, 404])("maps HTTP %i to a non-retryable error", async (status) => {
        fetchMock.mockResolvedValue(httpStatus(status, "detail"))

        const error: any = await openRouterProvider.complete(config(), MESSAGES).catch((e) => e)

        expect(error).toBeInstanceOf(NonRetryableError)
        expect(error.message).toBe(`openrouter HTTP ${status}: detail`)
    })

    it("maps an empty response to a retryable error labelled with its own name", async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 }),
        )

        const error: any = await openRouterProvider.complete(config(), MESSAGES).catch((e) => e)

        expect(error).toBeInstanceOf(RetryableError)
        expect(error.message).toBe("openrouter: empty content")
    })

    it("maps a network failure to a retryable error", async () => {
        fetchMock.mockRejectedValue(new Error("ENOTFOUND"))

        const error: any = await openRouterProvider.complete(config(), MESSAGES).catch((e) => e)

        expect(error).toBeInstanceOf(RetryableError)
        expect(error.message).toBe("ENOTFOUND")
    })
})
