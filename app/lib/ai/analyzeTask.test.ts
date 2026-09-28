import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* C3 — lib/ai/analyzeTask orchestrator (§7.8 Failure & Degradation).  */
/* fetch mocked: no real provider calls.                               */
/* Retryable → backoff+retry; Non-retryable → immediate fallback;      */
/* Key missing → mock. Mock output must stay clearly identifiable      */
/* via source: "mock" and must satisfy aiAnalysisSchema.               */
/* ------------------------------------------------------------------ */

// MAX_ATTEMPTS در سطح ماژول خوانده میشود — قبل از import کم می‌کنیم تا تست سریع بماند
vi.hoisted(() => {
    process.env.AI_MAX_ATTEMPTS = "2"
    process.env.AI_TIMEOUT_MS = "3000"
    delete process.env.AIXAI_API_KEY
    // این فایل پیش از معرفی fallback نوشته شده و زنجیرهٔ provider آن‌وقت تک‌عضوی بود.
    // اگر این دو کلید از محیط (یا فایل .env) به تست نشت کند، زنجیره یک عضو دوم
    // می‌گیرد و «تعداد تلاش» در assertهای زیر دیگر معتبر نیست. پس اینجا صریحاً
    // پاک می‌شوند تا نتیجهٔ تست به محیط ماشین وابسته نباشد.
    delete process.env.AI_ALLOW_FALLBACK
    delete process.env.OPENROUTER_API_KEY
})

const fetchMock = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", fetchMock)

import { AiProviderUnavailableError } from "@/app/lib/services/errors"

import { analyzeTask } from "./analyzeTask"
import { aiAnalysisSchema } from "./aiSchema"
import { mockAnalyze } from "./mock"

const PROVIDER_OK = JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
        priority: "HIGH",
        score: 90,
        estimatedMinutes: 45,
        reason: "توضیح تست",
        // کلید legacy «Work» عمداً استفاده شده تا نرمال‌سازی به واژگان canonical آزموده شود
        category: "Work",
    }) } }],
})

const httpStatus = (status: number) => new Response("boom", { status })

describe("analyzeTask (§7.8 — Failure & Degradation)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })
    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it("returns clearly-identifiable mock output when the default provider key is missing (no provider call)", async () => {
        delete process.env.OPENROUTER_API_KEY

        const result = await analyzeTask("گزارش فوری پروژه مشتری")

        expect(fetchMock).not.toHaveBeenCalled()
        expect(result.source).toBe("mock")
        expect(result.attempts).toBe(0)
        // خروجی mock همیشه هم‌ساختار خروجی AI است و از zod عبور می‌کند
        expect(result.analysis).toEqual(mockAnalyze("گزارش فوری پروژه مشتری"))
        expect(aiAnalysisSchema.parse(result.analysis)).toEqual(result.analysis)
    })

    it("returns the provider analysis on a successful first attempt", async () => {
        vi.stubEnv("OPENROUTER_API_KEY", "test-key")
        fetchMock.mockResolvedValueOnce(new Response(PROVIDER_OK, { status: 200 }))

        const result = await analyzeTask("گزارش فروش")

        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(result.source).toBe("1xai")
        expect(result.attempts).toBe(1)
        expect(result.analysis).toEqual({
            priority: "HIGH",
            score: 90,
            estimatedMinutes: 45,
            reason: "توضیح تست",
            // «Work» از مدل به کلید canonical «work» نگاشت می‌شود
            category: "work",
        })
    })

    it("normalizes an unknown/legacy category to the canonical vocabulary", async () => {
        vi.stubEnv("OPENROUTER_API_KEY", "test-key")
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    choices: [{ message: { content: JSON.stringify({
                        priority: "MEDIUM",
                        score: 50,
                        estimatedMinutes: 30,
                        reason: "توضیح",
                        category: "Urgent", // دیگر دسته‌بندی نیست
                    }) } }],
                }),
                { status: 200 },
            ),
        )

        const result = await analyzeTask("کار فوری")

        // هیچ دسته‌ای بیرون از واژگان canonical از AI عبور نمی‌کند
        expect(result.analysis.category).toBe("personal")
    })

    it("retries a retryable 503 and succeeds on the next attempt", async () => {
        vi.stubEnv("OPENROUTER_API_KEY", "test-key")
        fetchMock.mockResolvedValueOnce(httpStatus(503))
        fetchMock.mockResolvedValueOnce(new Response(PROVIDER_OK, { status: 200 }))

        const result = await analyzeTask("گزارش فروش")

        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(result.source).toBe("1xai")
        expect(result.attempts).toBe(2)
    })

    it("falls back to mock immediately on a non-retryable 400 (no quota burn)", async () => {
        vi.stubEnv("OPENROUTER_API_KEY", "test-key")
        fetchMock.mockResolvedValue(httpStatus(400))

        const result = await analyzeTask("گزارش فروش")

        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(result.source).toBe("mock")
        expect(result.analysis).toEqual(mockAnalyze("گزارش فروش"))
    })

    it("falls back to mock after exhausting retries when all attempts fail", async () => {
        vi.stubEnv("OPENROUTER_API_KEY", "test-key")
        fetchMock.mockResolvedValue(httpStatus(503))

        const result = await analyzeTask("گزارش فروش")

        expect(fetchMock).toHaveBeenCalledTimes(2) // AI_MAX_ATTEMPTS=2
        expect(result.source).toBe("mock")
        expect(aiAnalysisSchema.parse(result.analysis)).toEqual(result.analysis)
    })

    it("falls back to mock when the provider returns unparseable content on every attempt", async () => {
        vi.stubEnv("OPENROUTER_API_KEY", "test-key")
        fetchMock.mockResolvedValue(new Response(JSON.stringify({
            choices: [{ message: { content: "not json at all" } }],
        }), { status: 200 }))

        const result = await analyzeTask("گزارش فروش")

        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(result.source).toBe("mock")
    })
})

/* ------------------------------------------------------------------ */
/* فاز ۱ — سند §۲/§۱۲: در production هیچ mock‌ای به‌عنوان success       */
/* برنمی‌گردد؛ شکست نهایی provider خطای قابل مدیریت (۵۰۳) می‌دهد.       */
/* ------------------------------------------------------------------ */

describe("analyzeTask — production never returns a mock result (فاز ۱ §۲/§۱۲)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })
    afterEach(() => {
        vi.unstubAllEnvs()
        delete process.env.OPENROUTER_API_KEY
    })

    it("throws AiProviderUnavailableError when the provider is not configured (no mock, no fetch)", async () => {
        delete process.env.OPENROUTER_API_KEY
        vi.stubEnv("NODE_ENV", "production")

        const error: any = await analyzeTask("گزارش فروش").catch((e) => e)

        expect(error).toBeInstanceOf(AiProviderUnavailableError)
        expect(error.code).toBe("AI_PROVIDER_UNAVAILABLE")
        expect(error.status).toBe(503)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("throws AiProviderUnavailableError instead of mock after exhausting retries", async () => {
        vi.stubEnv("NODE_ENV", "production")
        vi.stubEnv("OPENROUTER_API_KEY", "prod-key")
        fetchMock.mockResolvedValue(httpStatus(503))

        const error: any = await analyzeTask("گزارش فروش").catch((e) => e)

        expect(error).toBeInstanceOf(AiProviderUnavailableError)
        expect(error.code).toBe("AI_PROVIDER_UNAVAILABLE")
        expect(error).not.toHaveProperty("source")
        expect(fetchMock).toHaveBeenCalledTimes(2) // AI_MAX_ATTEMPTS=2
    })

    it("throws AiProviderUnavailableError on a non-retryable provider rejection too", async () => {
        vi.stubEnv("NODE_ENV", "production")
        vi.stubEnv("OPENROUTER_API_KEY", "prod-key")
        fetchMock.mockResolvedValue(httpStatus(400))

        const error: any = await analyzeTask("گزارش فروش").catch((e) => e)

        expect(error).toBeInstanceOf(AiProviderUnavailableError)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })
})
