import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* provider «1xai» — قرارداد transport بدون هیچ شبکهٔ واقعی           */
/* ------------------------------------------------------------------ */
/* fetch کاملاً mock است. هدف این تست‌ها قفل‌کردن رفتار دقیقی است که از */
/* providerClient قدیمی به لایهٔ provider منتقل شده: همان URL، همان body، */
/* همان هدر و همان طبقه‌بندی خطا (retryable در برابر قطعی).           */

const fetchMock = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", fetchMock)

import { NonRetryableError, RetryableError } from "@/app/lib/ai/providers"
import { oneXaiProvider } from "@/app/lib/ai/providers/onexai"
import { resolveTimeoutMs } from "@/app/lib/ai/providers/openaiCompatible"

const MESSAGES = [
    { role: "system", content: "sys" },
    { role: "user", content: "user" },
]

const PROVIDER_OK = JSON.stringify({ choices: [{ message: { content: "سلام" } }] })
const httpStatus = (status: number, body = "boom") => new Response(body, { status })

const config = () => oneXaiProvider.resolveConfig({ timeoutMs: 5000 })

describe("oneXaiProvider — پیکربندی و قرارداد env", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        delete process.env.AIXAI_API_KEY
        delete process.env.AIXAI_BASE_URL
        delete process.env.AIXAI_MODEL
    })
    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it("uses the exact production base URL and model by default", () => {
        expect(oneXaiProvider.defaultBaseUrl).toBe("https://1xai.ir/v1")
        expect(oneXaiProvider.defaultModel).toBe("gpt-4o-mini")
        expect(oneXaiProvider.apiKeyEnv).toBe("AIXAI_API_KEY")
        expect(oneXaiProvider.baseUrlEnv).toBe("AIXAI_BASE_URL")
        expect(oneXaiProvider.modelEnv).toBe("AIXAI_MODEL")
    })

    it("is not configured when AIXAI_API_KEY is missing", () => {
        expect(oneXaiProvider.isConfigured()).toBe(false)
    })

    it("is configured once AIXAI_API_KEY is present", () => {
        vi.stubEnv("AIXAI_API_KEY", "k")
        expect(oneXaiProvider.isConfigured()).toBe(true)
    })

    it("throws a non-retryable error naming the missing env var when the key is absent", () => {
        expect(() => oneXaiProvider.resolveConfig()).toThrow(NonRetryableError)
        expect(() => oneXaiProvider.resolveConfig()).toThrow("AIXAI_API_KEY missing")
    })

    it("honours AIXAI_BASE_URL and AIXAI_MODEL overrides", () => {
        vi.stubEnv("AIXAI_API_KEY", "k")
        vi.stubEnv("AIXAI_BASE_URL", "https://mirror.invalid/v1")
        vi.stubEnv("AIXAI_MODEL", "custom-model")

        const resolved = oneXaiProvider.resolveConfig()

        expect(resolved.baseUrl).toBe("https://mirror.invalid/v1")
        expect(resolved.model).toBe("custom-model")
    })

    it("reads the API key at call time so per-request configuration keeps working", () => {
        vi.stubEnv("AIXAI_API_KEY", "first")
        expect(oneXaiProvider.resolveConfig().apiKey).toBe("first")

        vi.stubEnv("AIXAI_API_KEY", "second")
        expect(oneXaiProvider.resolveConfig().apiKey).toBe("second")
    })

    it("clamps the timeout to the same 3s floor as before", () => {
        expect(resolveTimeoutMs(undefined)).toBe(12000)
        expect(resolveTimeoutMs("2000")).toBe(3000)
        expect(resolveTimeoutMs("9000")).toBe(9000)
    })
})

describe("oneXaiProvider — درخواست HTTP", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.stubEnv("AIXAI_API_KEY", "test-key")
    })
    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it("posts to /chat/completions with the expected headers and body", async () => {
        fetchMock.mockResolvedValue(new Response(PROVIDER_OK, { status: 200 }))

        const content = await oneXaiProvider.complete(config(), MESSAGES)

        expect(content).toBe("سلام")
        expect(fetchMock).toHaveBeenCalledTimes(1)

        const [url, init] = fetchMock.mock.calls[0]
        expect(url).toBe("https://1xai.ir/v1/chat/completions")
        expect(init.method).toBe("POST")
        expect(init.headers).toEqual({
            "Content-Type": "application/json",
            Authorization: "Bearer test-key",
        })
        expect(JSON.parse(init.body)).toEqual({
            model: "gpt-4o-mini",
            temperature: 0.2,
            messages: MESSAGES,
        })
    })

    it("sends no provider-specific headers", async () => {
        fetchMock.mockResolvedValue(new Response(PROVIDER_OK, { status: 200 }))

        await oneXaiProvider.complete(config(), MESSAGES)

        const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
        expect(headers["HTTP-Referer"]).toBeUndefined()
        expect(headers["X-Title"]).toBeUndefined()
    })

    it("passes an abort signal so the request can be cancelled", async () => {
        fetchMock.mockResolvedValue(new Response(PROVIDER_OK, { status: 200 }))

        await oneXaiProvider.complete(config(), MESSAGES)

        expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    })

    it("aborts after the timeout and maps the abort to a retryable error", async () => {
        fetchMock.mockImplementation((_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
                init.signal?.addEventListener("abort", () => {
                    const error = new Error("The operation was aborted")
                    error.name = "AbortError"
                    reject(error)
                })
            }),
        )

        vi.useFakeTimers()
        try {
            const pending = oneXaiProvider.complete(config(), MESSAGES)
            const assertion = expect(pending).rejects.toBeInstanceOf(RetryableError)
            await vi.advanceTimersByTimeAsync(5000)
            await assertion
        } finally {
            vi.useRealTimers()
        }
    })
})

describe("oneXaiProvider — طبقه‌بندی خطا (مبنای تصمیم retry)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.stubEnv("AIXAI_API_KEY", "test-key")
    })
    afterEach(() => {
        vi.unstubAllEnvs()
    })

    // این وضعیت‌ها «قابل تلاش مجدد» هستند؛ لایهٔ orchestration دوباره صدا می‌زند.
    it.each([408, 429, 500, 502, 503, 504])("treats HTTP %i as retryable", async (status) => {
        fetchMock.mockResolvedValue(httpStatus(status))

        const error: any = await oneXaiProvider.complete(config(), MESSAGES).catch((e) => e)

        expect(error).toBeInstanceOf(RetryableError)
        expect(error).not.toBeInstanceOf(NonRetryableError)
        expect(error.message).toBe(`1xai HTTP ${status}`)
    })

    // این وضعیت‌ها قطعی‌اند؛ تلاش مجدد می‌تواند سهمیه را بسوزاند.
    it.each([400, 401, 403, 404])("treats HTTP %i as non-retryable", async (status) => {
        fetchMock.mockResolvedValue(httpStatus(status, "detail"))

        const error: any = await oneXaiProvider.complete(config(), MESSAGES).catch((e) => e)

        expect(error).toBeInstanceOf(NonRetryableError)
        expect(error).not.toBeInstanceOf(RetryableError)
        expect(error.message).toBe(`1xai HTTP ${status}: detail`)
    })

    it("truncates a long error body to 200 characters", async () => {
        fetchMock.mockResolvedValue(httpStatus(400, "x".repeat(500)))

        const error: any = await oneXaiProvider.complete(config(), MESSAGES).catch((e) => e)

        expect(error.message).toBe(`1xai HTTP 400: ${"x".repeat(200)}`)
    })

    it("maps a network failure to a retryable error and keeps the original message", async () => {
        fetchMock.mockRejectedValue(new Error("ECONNRESET"))

        const error: any = await oneXaiProvider.complete(config(), MESSAGES).catch((e) => e)

        expect(error).toBeInstanceOf(RetryableError)
        expect(error.message).toBe("ECONNRESET")
    })

    it("maps a non-error rejection to a generic retryable error", async () => {
        fetchMock.mockRejectedValue("boom")

        const error: any = await oneXaiProvider.complete(config(), MESSAGES).catch((e) => e)

        expect(error).toBeInstanceOf(RetryableError)
        expect(error.message).toBe("network error")
    })

    it.each([
        ["whitespace-only content", JSON.stringify({ choices: [{ message: { content: "   " } }] })],
        ["a missing message", JSON.stringify({ choices: [{}] })],
        ["a missing choices array", JSON.stringify({})],
        ["non-string content", JSON.stringify({ choices: [{ message: { content: 42 } }] })],
    ])("treats %s as an empty response and retries it", async (_label, payload) => {
        fetchMock.mockResolvedValue(new Response(payload, { status: 200 }))

        const error: any = await oneXaiProvider.complete(config(), MESSAGES).catch((e) => e)

        expect(error).toBeInstanceOf(RetryableError)
        expect(error.message).toBe("1xai: empty content")
    })
})
