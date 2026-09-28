import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* انتخاب provider — قفل ایمنی مرحلهٔ ۱                               */
/* ------------------------------------------------------------------ */
/* این تست عمداً «خاموش نگه‌داشتن fallback» را قفل می‌کند: تا وقتی تصمیمی */
/* خلاف آن گرفته نشده، production باید فقط 1xai را صدا بزند و وجود کلید  */
/* OpenRouter نباید هیچ اثری بر provider فعال یا مقصد درخواست بگذارد.   */

const fetchMock = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", fetchMock)

import { NonRetryableError, RetryableError, getDefaultProvider, getProvider, listProviders } from "@/app/lib/ai/providers"
import { oneXaiProvider } from "@/app/lib/ai/providers/onexai"
import { openRouterProvider } from "@/app/lib/ai/providers/openrouter"
import { AI_BASE_URL, AI_MODEL, fetchProviderRaw } from "@/app/lib/ai/providerClient"
import { NonRetryableError as ProviderClientNonRetryableError } from "@/app/lib/ai/providerClient"

const PROVIDER_OK = JSON.stringify({ choices: [{ message: { content: "ok" } }] })

const clearEnv = () => {
    delete process.env.AIXAI_API_KEY
    delete process.env.AIXAI_BASE_URL
    delete process.env.AIXAI_MODEL
    delete process.env.OPENROUTER_API_KEY
    delete process.env.OPENROUTER_BASE_URL
    delete process.env.OPENROUTER_MODEL
}

describe("provider registry — انتخاب پیش‌فرض", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        clearEnv()
    })
    afterEach(() => {
        vi.unstubAllEnvs()
        clearEnv()
    })

    it("declares 1xai as the default provider id", () => {
        expect(getDefaultProvider().id).toBe("1xai")
    })

    it("resolves the default provider to the 1xai implementation", () => {
        expect(getDefaultProvider()).toBe(oneXaiProvider)
    })

    it("keeps providerClient constants sourced from the 1xai defaults", () => {
        expect(AI_BASE_URL).toBe("https://1xai.ir/v1")
        expect(AI_MODEL).toBe("gpt-4o-mini")
    })

    it("registers both providers with unique ids", () => {
        const ids = listProviders().map((p) => p.id)
        expect(ids).toEqual(["1xai", "openrouter"])
        expect(new Set(ids).size).toBe(ids.length)
    })

    it("looks providers up by id and never returns the inactive one as default", () => {
        expect(getProvider("1xai")).toBe(oneXaiProvider)
        expect(getProvider("openrouter")).toBe(openRouterProvider)
        expect(getProvider("openrouter")).not.toBe(getDefaultProvider())
    })
})

describe("provider registry — OpenRouter نباید حتی با کلید فعال شود", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        clearEnv()
    })
    afterEach(() => {
        vi.unstubAllEnvs()
        clearEnv()
    })

    it("stays on 1xai even when an OpenRouter key is present", () => {
        vi.stubEnv("OPENROUTER_API_KEY", "or-key")

        expect(getDefaultProvider().id).toBe("1xai")
        expect(getDefaultProvider()).toBe(oneXaiProvider)
    })

    it("stays on 1xai even when both keys are present", () => {
        vi.stubEnv("AIXAI_API_KEY", "aixai-key")
        vi.stubEnv("OPENROUTER_API_KEY", "or-key")

        expect(getDefaultProvider().apiKeyEnv).toBe("AIXAI_API_KEY")
    })

    it("reports the default provider as unconfigured when only the OpenRouter key exists", () => {
        vi.stubEnv("OPENROUTER_API_KEY", "or-key")

        expect(getDefaultProvider().isConfigured()).toBe(false)
    })

    it("does not read the OpenRouter key when resolving the default provider config", () => {
        vi.stubEnv("AIXAI_API_KEY", "aixai-key")
        vi.stubEnv("OPENROUTER_BASE_URL", "https://should-not-be-used.invalid")

        const resolved = getDefaultProvider().resolveConfig()

        expect(resolved.baseUrl).toBe("https://1xai.ir/v1")
        expect(resolved.apiKey).toBe("aixai-key")
    })

    it("routes every real request to 1xai and never to OpenRouter", async () => {
        vi.stubEnv("AIXAI_API_KEY", "aixai-key")
        vi.stubEnv("OPENROUTER_API_KEY", "or-key")
        fetchMock.mockResolvedValue(new Response(PROVIDER_OK, { status: 200 }))

        await fetchProviderRaw([{ role: "user", content: "سلام" }])

        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(fetchMock.mock.calls[0][0]).toBe("https://1xai.ir/v1/chat/completions")
        expect(fetchMock.mock.calls[0][0]).not.toContain("openrouter")
    })

    it("surfaces the missing 1xai key as a non-retryable error when only OpenRouter is set", async () => {
        vi.stubEnv("OPENROUTER_API_KEY", "or-key")

        const error: any = await fetchProviderRaw([{ role: "user", content: "سلام" }]).catch((e) => e)

        expect(error).toBeInstanceOf(NonRetryableError)
        expect(error.message).toBe("AIXAI_API_KEY missing")
        expect(fetchMock).not.toHaveBeenCalled()
    })
})

describe("provider registry — هویت کلاس خطا بین لایه‌ها حفظ می‌شود", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        clearEnv()
    })
    afterEach(() => {
        vi.unstubAllEnvs()
        clearEnv()
    })

    // callerها (analyzeTask/analyzeBatchPlan) با instanceof تصمیم می‌گیرند؛ اگر
    // provider جای دیگری کلاس خطا بسازد، retry semantics بی‌صدا خراب می‌شود.
    it("throws the exact same error class that providerClient re-exports", async () => {
        vi.stubEnv("AIXAI_API_KEY", "aixai-key")
        fetchMock.mockResolvedValue(new Response("boom", { status: 400 }))

        const error: any = await fetchProviderRaw([{ role: "user", content: "سلام" }]).catch((e) => e)

        expect(error).toBeInstanceOf(NonRetryableError)
        expect(error).toBeInstanceOf(ProviderClientNonRetryableError)
        expect(error.constructor).toBe(NonRetryableError)
    })

    it("also shares the retryable error class across layers", async () => {
        vi.stubEnv("AIXAI_API_KEY", "aixai-key")
        fetchMock.mockResolvedValue(new Response("boom", { status: 503 }))

        const error: any = await fetchProviderRaw([{ role: "user", content: "سلام" }]).catch((e) => e)

        expect(error.constructor).toBe(RetryableError)
    })
})
