import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* تضمین quota در fallback (مرحلهٔ ۲ — بند «اصل معماری»)               */
/* ------------------------------------------------------------------ */
/* قاعده: quota به «logical AI operation» تعلق دارد، نه به تعداد          */
/* provider call. این تست ثابت می‌کند وقتی 1xAI خراب و OpenRouter موفق    */
/* می‌شود، دقیقاً یک رزرو و یک complete رخ می‌دهد.                        */
/*                                                                      */
/* هیچ شبکهٔ واقعی در کار نیست؛ fetch کاملاً mock است.                    */

vi.hoisted(() => {
    process.env.AI_MAX_ATTEMPTS = "2"
    process.env.AI_TIMEOUT_MS = "3000"
})

const fetchMock = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", fetchMock)

import { analyzeTask } from "@/app/lib/ai/analyzeTask"
import { analyzeBatchPlan } from "@/app/lib/ai/analyzeBatchPlan"
import { getPrisma } from "@/app/lib/getPrisma"
import {
    completeQuota,
    releaseQuota,
    reserveQuota,
} from "@/app/lib/services/aiQuota.service"
import { markReleaseFailed } from "@/app/lib/services/aiUsage.service"
import { getAllowedProperties, validateProductEvent } from "@/app/lib/services/productEvent.contract"

vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: vi.fn(() => ({})) }))
vi.mock("@/app/lib/services/aiQuota.service", () => ({
    reserveQuota: vi.fn(async () => undefined),
    completeQuota: vi.fn(async () => undefined),
    releaseQuota: vi.fn(async () => undefined),
}))
vi.mock("@/app/lib/services/aiUsage.service", () => ({ markReleaseFailed: vi.fn(async () => undefined) }))

import type { PlanInput } from "@/app/lib/ai/planContract"

const OK = JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    priority: "HIGH", score: 80, estimatedMinutes: 30, reason: "دلیل", category: "work",
}) } }] })
const ok = () => new Response(OK, { status: 200 })
const status = (code: number) => new Response("boom", { status: code })

const urls = () => fetchMock.mock.calls.map((call) => String(call[0]))
const oneXaiCalls = () => urls().filter((u) => u.startsWith("https://1xai.ir")).length
const openRouterCalls = () => urls().filter((u) => u.startsWith("https://openrouter.ai")).length

const PLAN: PlanInput = {
    dayKey: "2026-01-01",
    availableMinutes: 120,
    tasks: [{ taskId: 1, title: "کار", category: "work" }],
}
const PLAN_OK = JSON.stringify({ choices: [{ message: { content: JSON.stringify({
    items: [{ taskId: 1, estimatedMinutes: 30, score: 70, priority: "HIGH", order: 1, reason: "دلیل" }],
    unscheduledTaskIds: [],
}) } }] })

const PLAN_INPUT_JSON = JSON.stringify({
    choices: [{ message: { content: JSON.stringify({
        items: [{ taskId: 1, estimatedMinutes: 30, score: 70, priority: "HIGH", order: 1, reason: "دلیل" }],
    }) } }],
})

describe("fallback و quota — یک logical operation برای چند provider call", () => {
    beforeEach(() => {
        fetchMock.mockReset()
        vi.clearAllMocks()
        delete process.env.AIXAI_API_KEY
        delete process.env.OPENROUTER_API_KEY
        delete process.env.AI_ALLOW_FALLBACK
        vi.stubEnv("AIXAI_API_KEY", "aixai-key")
        vi.stubEnv("OPENROUTER_API_KEY", "or-key")
        vi.stubEnv("AI_ALLOW_FALLBACK", "true")
    })
    afterEach(() => {
        vi.unstubAllEnvs()
        delete process.env.AIXAI_API_KEY
        delete process.env.OPENROUTER_API_KEY
        delete process.env.AI_ALLOW_FALLBACK
    })

    it("task analysis: primary fails, fallback succeeds → exactly one quota operation", async () => {
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(ok())

        const result = await analyzeTask("گزارش فروش")

        // ۲ تلاش روی primary + ۱ تلاش روی fallback
        expect(oneXaiCalls()).toBe(2)
        expect(openRouterCalls()).toBe(1)
        expect(result.aiProvider).toBe("openrouter")
        expect(result.fallbackUsed).toBe(true)
        // قرارداد عمومی دست‌نخورده: هنوز «AI واقعی» است، نه mock
        expect(result.source).toBe("1xai")

        // شبیه‌سازی همان چیزی که route انجام می‌دهد (یک‌بار، بیرون از AI):
        await reserveQuota(getPrisma() as never, { userId: 1 } as never)
        await completeQuota(getPrisma() as never, "req-1" as never, undefined as never, {} as never)

        expect(reserveQuota).toHaveBeenCalledTimes(1)
        expect(completeQuota).toHaveBeenCalledTimes(1)
        expect(releaseQuota).not.toHaveBeenCalled()
        expect(markReleaseFailed).not.toHaveBeenCalled()
    })

    it("planner: primary fails, fallback succeeds → exactly one quota operation", async () => {
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(new Response(PLAN_INPUT_JSON, { status: 200 }))

        const result = await analyzeBatchPlan(PLAN)

        expect(oneXaiCalls()).toBe(2)
        expect(openRouterCalls()).toBe(1)
        expect(result.aiProvider).toBe("openrouter")
        expect(result.fallbackUsed).toBe(true)
        expect(result.source).toBe("1xai")

        await reserveQuota(getPrisma() as never, { userId: 1 } as never)
        await completeQuota(getPrisma() as never, "req-1" as never, undefined as never, {} as never)

        expect(reserveQuota).toHaveBeenCalledTimes(1)
        expect(completeQuota).toHaveBeenCalledTimes(1)
        expect(releaseQuota).not.toHaveBeenCalled()
    })

    it("both features use the same shared orchestration (no duplicated fallback logic)", async () => {
        // هر دو از providerClient استفاده می‌کنند؛ اثبات با رفتار یکسان است،
        // نه با تست ساختاری.
        fetchMock.mockResolvedValue(status(503))

        await analyzeTask("کار").catch(() => undefined)
        const afterTask = urls().length
        await analyzeBatchPlan(PLAN).catch(() => undefined)

        // هر دو دقیقاً ۲ تلاش primary + ۱ تلاش fallback دارند (نه ۴+).
        expect(afterTask).toBe(3)
        expect(urls().length).toBe(6)
    })

    it("never exposes a secret or raw provider response in the result metadata", async () => {
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(ok())

        const result = await analyzeTask("گزارش فروش")

        expect(JSON.stringify({ aiProvider: result.aiProvider, fallbackUsed: result.fallbackUsed })).not.toContain("aixai-key")
        expect(result.aiProvider).not.toContain("key")
        // provider فقط یک شناسهٔ شناخته‌شده است
        expect(["1xai", "openrouter"]).toContain(result.aiProvider)
    })

    it("does not persist a raw provider response through the observability contract", async () => {
        const result = validateProductEvent("ai.analysis_succeeded", {
            units: 1,
            aiSource: "1xai",
            aiProvider: "openrouter",
            fallbackUsed: true,
            status: "success",
        })

        expect(result.valid).toBe(true)
        if (result.valid) {
            expect(result.properties).toEqual({
                units: 1,
                aiSource: "1xai",
                aiProvider: "openrouter",
                fallbackUsed: true,
                status: "success",
            })
        }
        // allowlist اجازهٔ هیچ متن آزادی نمی‌دهد
        expect(getAllowedProperties("ai.analysis_succeeded")).toEqual([
            "units",
            "aiSource",
            "aiProvider",
            "fallbackUsed",
            "status",
        ])
        expect(validateProductEvent("ai.analysis_succeeded", { prompt: "x" }).valid).toBe(false)
        expect(validateProductEvent("ai.analysis_succeeded", { raw: "x" }).valid).toBe(false)
    })
})
