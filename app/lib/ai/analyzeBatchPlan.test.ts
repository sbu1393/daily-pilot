import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* Phase 2 — analyzeBatchPlan (provider call, retry, mock policy)      */
/* fetch mocked: no real provider calls.                               */
/* ------------------------------------------------------------------ */

// AI_MAX_ATTEMPTS/AI_TIMEOUT_MS در سطح ماژول providerClient خوانده می‌شوند — قبل از import کم می‌کنیم
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

import { analyzeBatchPlan } from "./analyzeBatchPlan"
import { mockBatchPlan } from "./planMock"
import { aiBatchPlanSchema } from "./planSchema"
import type { PlanInput } from "./planContract"

const input: PlanInput = {
    dayKey: "2026-09-27",
    availableMinutes: 120,
    tasks: [
        { taskId: 1, title: "گزارش فروش" },
        { taskId: 2, title: "خرید نان" },
    ],
}

const VALID_PLAN = {
    items: [
        { taskId: 1, estimatedMinutes: 30, score: 70, priority: "HIGH", order: 1 },
        { taskId: 2, estimatedMinutes: 20, score: 40, priority: "LOW", order: 2 },
    ],
    summary: "خلاصه",
}

const PROVIDER_OK = JSON.stringify({
    choices: [{ message: { content: JSON.stringify(VALID_PLAN) } }],
})

const httpStatus = (status: number) => new Response("boom", { status })

describe("analyzeBatchPlan — provider success & repair", () => {
    beforeEach(() => vi.clearAllMocks())
    afterEach(() => {
        vi.unstubAllEnvs()
        delete process.env.AIXAI_API_KEY
    })

    it("returns the provider plan on a successful first attempt (source 1xai)", async () => {
        vi.stubEnv("AIXAI_API_KEY", "test-key")
        fetchMock.mockResolvedValueOnce(new Response(PROVIDER_OK, { status: 200 }))

        const result = await analyzeBatchPlan(input)

        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(result.source).toBe("1xai")
        expect(result.attempts).toBe(1)
        expect(aiBatchPlanSchema.parse(result.plan)).toEqual(result.plan)
        expect(result.plan.items.map((i) => i.taskId)).toEqual([1, 2])
    })

    it("repairs a markdown/prose-wrapped JSON payload (same extractJson pipeline)", async () => {
        vi.stubEnv("AIXAI_API_KEY", "test-key")
        const wrapped = `Sure!\n\`\`\`json\n${JSON.stringify(VALID_PLAN)}\n\`\`\``
        fetchMock.mockResolvedValueOnce(
            new Response(JSON.stringify({ choices: [{ message: { content: wrapped } }] }), { status: 200 }),
        )

        const result = await analyzeBatchPlan(input)

        expect(result.source).toBe("1xai")
        expect(result.plan.items).toHaveLength(2)
    })

    it("retries a retryable 503 and succeeds on the next attempt", async () => {
        vi.stubEnv("AIXAI_API_KEY", "test-key")
        fetchMock.mockResolvedValueOnce(httpStatus(503))
        fetchMock.mockResolvedValueOnce(new Response(PROVIDER_OK, { status: 200 }))

        const result = await analyzeBatchPlan(input)

        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(result.source).toBe("1xai")
        expect(result.attempts).toBe(2)
    })

    it("falls back to mock immediately on a non-retryable 400 (no quota burn)", async () => {
        vi.stubEnv("AIXAI_API_KEY", "test-key")
        fetchMock.mockResolvedValue(httpStatus(400))

        const result = await analyzeBatchPlan(input)

        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(result.source).toBe("mock")
        expect(result.plan).toEqual(mockBatchPlan(input))
    })
})

describe("analyzeBatchPlan — degradation (non-production mock)", () => {
    beforeEach(() => vi.clearAllMocks())
    afterEach(() => {
        vi.unstubAllEnvs()
        delete process.env.AIXAI_API_KEY
    })

    it("returns the deterministic mock when the API key is missing (no provider call)", async () => {
        delete process.env.AIXAI_API_KEY

        const result = await analyzeBatchPlan(input)

        expect(fetchMock).not.toHaveBeenCalled()
        expect(result.source).toBe("mock")
        expect(result.attempts).toBe(0)
        expect(result.plan).toEqual(mockBatchPlan(input))
        expect(aiBatchPlanSchema.parse(result.plan)).toEqual(result.plan)
    })

    it("falls back to mock after exhausting retries when all attempts fail", async () => {
        vi.stubEnv("AIXAI_API_KEY", "test-key")
        fetchMock.mockResolvedValue(httpStatus(503))

        const result = await analyzeBatchPlan(input)

        expect(fetchMock).toHaveBeenCalledTimes(2) // AI_MAX_ATTEMPTS=2
        expect(result.source).toBe("mock")
    })

    it("falls back to mock when the provider returns unparseable content every attempt", async () => {
        vi.stubEnv("AIXAI_API_KEY", "test-key")
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ choices: [{ message: { content: "not json at all" } }] }), {
                status: 200,
            }),
        )

        const result = await analyzeBatchPlan(input)

        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(result.source).toBe("mock")
    })

    it("falls back to mock when the parsed JSON is schema-invalid (bad score) every attempt", async () => {
        vi.stubEnv("AIXAI_API_KEY", "test-key")
        const invalid = { items: [{ taskId: 1, estimatedMinutes: 30, score: 500, priority: "HIGH", order: 1 }] }
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(invalid) } }] }), {
                status: 200,
            }),
        )

        const result = await analyzeBatchPlan(input)

        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(result.source).toBe("mock")
    })
})

describe("analyzeBatchPlan — production never returns a mock result", () => {
    beforeEach(() => vi.clearAllMocks())
    afterEach(() => {
        vi.unstubAllEnvs()
        delete process.env.AIXAI_API_KEY
    })

    it("throws AiProviderUnavailableError when the provider is not configured (no fetch)", async () => {
        delete process.env.AIXAI_API_KEY
        vi.stubEnv("NODE_ENV", "production")

        const error: any = await analyzeBatchPlan(input).catch((e) => e)

        expect(error).toBeInstanceOf(AiProviderUnavailableError)
        expect(error.code).toBe("AI_PROVIDER_UNAVAILABLE")
        expect(error.status).toBe(503)
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it("throws AiProviderUnavailableError instead of mock after exhausting retries", async () => {
        vi.stubEnv("NODE_ENV", "production")
        vi.stubEnv("AIXAI_API_KEY", "prod-key")
        fetchMock.mockResolvedValue(httpStatus(503))

        const error: any = await analyzeBatchPlan(input).catch((e) => e)

        expect(error).toBeInstanceOf(AiProviderUnavailableError)
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it("throws AiProviderUnavailableError on a non-retryable provider rejection too", async () => {
        vi.stubEnv("NODE_ENV", "production")
        vi.stubEnv("AIXAI_API_KEY", "prod-key")
        fetchMock.mockResolvedValue(httpStatus(400))

        const error: any = await analyzeBatchPlan(input).catch((e) => e)

        expect(error).toBeInstanceOf(AiProviderUnavailableError)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })
})
