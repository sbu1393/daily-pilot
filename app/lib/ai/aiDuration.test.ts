import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* مرحلهٔ ۴.۲ — instrumentation اندازه‌گیری عملیات AI                  */
/* ------------------------------------------------------------------ */
/* چهار چیز ثابت می‌شود:                                                */
/* ۱) مقدار واقعی در `AiUsageEvent` نوشته می‌شود (success و failure).   */
/* ۲) نبودن/نامعتبر بودن telemetry هیچ تفاوتی با رفتار قبلی نمی‌کند.    */
/* ۳) شکست release دقیقاً مثل قبل fail-closed می‌ماند.                  */
/* ۴) instrumentation هرگز fail نمی‌کند (fail-Open).                    */
/*                                                                      */
/* سرویس quota اینجا واقعی است و روی یک Prisma جعلی اجرا می‌شود، تا    */
/* payload واقعیِ updateMany — نه فقط آرگومان‌های یک spy — بررسی شود.    */
/* هیچ شبکهٔ واقعی در کار نیست؛ fetch کاملاً mock است.                  */

vi.hoisted(() => {
    process.env.AI_MAX_ATTEMPTS = "2"
    process.env.AI_TIMEOUT_MS = "3000"
})

const fetchMock = vi.hoisted(() => vi.fn())
vi.stubGlobal("fetch", fetchMock)

import { analyzeTask } from "@/app/lib/ai/analyzeTask"
import { analyzeBatchPlan } from "@/app/lib/ai/analyzeBatchPlan"
import {
    attachAiCallTelemetry,
    readAiCallTelemetry,
    startAiCallTimer,
} from "@/app/lib/ai/aiDuration"
import { getPrisma } from "@/app/lib/getPrisma"
import { completeQuota, releaseQuota } from "@/app/lib/services/aiQuota.service"
import { markReleaseFailed } from "@/app/lib/services/aiUsage.service"
import { QuotaUnavailableError } from "@/app/lib/services/errors"

vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: vi.fn() }))

import type { PlanInput } from "@/app/lib/ai/planContract"

const OK = JSON.stringify({
    choices: [
        {
            message: {
                content: JSON.stringify({
                    priority: "HIGH",
                    score: 80,
                    estimatedMinutes: 30,
                    reason: "دلیل",
                    category: "work",
                }),
            },
        },
    ],
})
const ok = () => new Response(OK, { status: 200 })
const status = (code: number) => new Response("boom", { status: code })

const PLAN: PlanInput = {
    dayKey: "2026-01-01",
    availableMinutes: 120,
    tasks: [{ taskId: 1, title: "کار", category: "work" }],
}
const PLAN_OK = JSON.stringify({
    choices: [
        {
            message: {
                content: JSON.stringify({
                    items: [
                        {
                            taskId: 1,
                            estimatedMinutes: 30,
                            score: 70,
                            priority: "HIGH",
                            order: 1,
                            reason: "دلیل",
                        },
                    ],
                    unscheduledTaskIds: [],
                }),
            },
        },
    ],
})

const PERIOD = new Date("2026-01-01T00:00:00.000Z")

/** Prisma جعلی که فقط updateMany رویداد را ضبط می‌کند — سایر queryها بی‌اثر. */
const makeEventSpy = () => {
    const eventUpdate = vi.fn(async () => ({ count: 1 }))
    const quotaUpdate = vi.fn(async () => ({ count: 1 }))
    const client = {
        aiUsageEvent: {
            findUnique: vi.fn(async () => ({ units: 1, userId: 7, status: "RESERVED" })),
            updateMany: eventUpdate,
        },
        aiUsage: { updateMany: quotaUpdate },
        $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(client),
    }
    return { client, eventUpdate, quotaUpdate }
}

/** payload آخرین updateMany رویداد — همان چیزی که واقعاً به DB می‌رود. */
const lastEventData = (eventUpdate: ReturnType<typeof vi.fn>) =>
    eventUpdate.mock.calls[eventUpdate.mock.calls.length - 1]?.[0]?.data as
        | Record<string, unknown>
        | undefined

describe("۴.۲ — ماندگاری duration/attempts در AiUsageEvent", () => {
    beforeEach(() => {
        fetchMock.mockReset()
        vi.clearAllMocks()
        vi.mocked(getPrisma).mockReturnValue(makeEventSpy().client as never)
        delete process.env.AIXAI_API_KEY
        delete process.env.OPENROUTER_API_KEY
        delete process.env.AI_ALLOW_FALLBACK
        vi.stubEnv("OPENROUTER_API_KEY", "or-key")
    })
    afterEach(() => {
        vi.unstubAllEnvs()
        delete process.env.AIXAI_API_KEY
        delete process.env.OPENROUTER_API_KEY
        delete process.env.AI_ALLOW_FALLBACK
    })

    /* --- success --------------------------------------------------- */

    it("success: مدت واقعی + شمارندهٔ تلاش در CONSUMED نوشته می‌شود", async () => {
        fetchMock.mockResolvedValueOnce(ok())

        const result = await analyzeTask("گزارش فروش")
        expect(result.aiTelemetry).toBeDefined()
        expect(result.aiTelemetry?.durationMs).toBeGreaterThanOrEqual(0)
        expect(result.aiTelemetry?.attempts).toBe(1)

        const { client, eventUpdate } = makeEventSpy()
        await completeQuota(client, "req-ok", undefined, { periodStart: PERIOD }, result.aiTelemetry)

        const data = lastEventData(eventUpdate)
        expect(data?.status).toBe("CONSUMED")
        expect(typeof data?.durationMs).toBe("number")
        expect(data?.attempts).toBe(1)
    })

    it("success: planner دقیقاً همین قرارداد را دارد", async () => {
        fetchMock.mockResolvedValueOnce(new Response(PLAN_OK, { status: 200 }))

        const result = await analyzeBatchPlan(PLAN)
        expect(result.aiTelemetry?.durationMs).toBeGreaterThanOrEqual(0)

        const { client, eventUpdate } = makeEventSpy()
        await completeQuota(client, "req-plan", undefined, { periodStart: PERIOD }, result.aiTelemetry)

        const data = lastEventData(eventUpdate)
        expect(data?.status).toBe("CONSUMED")
        expect(typeof data?.durationMs).toBe("number")
    })

    it("success: retry واقعی، شمارنده را بزرگ‌تر از ۱ ثبت می‌کند", async () => {
        fetchMock.mockResolvedValueOnce(status(503))
        fetchMock.mockResolvedValueOnce(ok())

        const result = await analyzeTask("کار")
        expect(result.attempts).toBe(2)
        expect(result.aiTelemetry?.attempts).toBe(2)

        const { client, eventUpdate } = makeEventSpy()
        await completeQuota(client, "req-retry", undefined, { periodStart: PERIOD }, result.aiTelemetry)
        expect(lastEventData(eventUpdate)?.attempts).toBe(2)
    })

    /* --- AI failure ----------------------------------------------- */

    it("AI failure: مدت اندازه‌گیری‌شده همراه failureCode در RELEASED می‌نشیند", async () => {
        const failure = attachAiCallTelemetry(new Error("provider down"), { durationMs: 1234 })
        const { client, eventUpdate } = makeEventSpy()

        await releaseQuota(
            client,
            "req-fail",
            undefined,
            { failureCode: "AI_PROVIDER_UNAVAILABLE", periodStart: PERIOD },
            readAiCallTelemetry(failure),
        )

        const data = lastEventData(eventUpdate)
        expect(data?.status).toBe("RELEASED")
        expect(data?.failureCode).toBe("AI_PROVIDER_UNAVAILABLE")
        expect(data?.durationMs).toBe(1234)
    })

    it("AI failure: failureCode و duration مستقل از هم نوشته می‌شوند", async () => {
        const { client, eventUpdate } = makeEventSpy()
        const failure = attachAiCallTelemetry(new Error("boom"), { durationMs: 50, attempts: 3 })

        await releaseQuota(
            client,
            "req-both",
            undefined,
            { failureCode: "AI_PLAN_INVALID", periodStart: PERIOD },
            readAiCallTelemetry(failure),
        )

        const data = lastEventData(eventUpdate)
        expect(data?.failureCode).toBe("AI_PLAN_INVALID")
        expect(data?.durationMs).toBe(50)
        expect(data?.attempts).toBe(3)
    })

    it("AI failure: planner هم مدت را کنار failureCode می‌نویسد", async () => {
        fetchMock.mockResolvedValue(status(503))
        const result = await analyzeBatchPlan(PLAN)
        // در محیط test شکست نهایی به mock تبدیل می‌شود؛ پس مسیر production را
        // با همان شکلی که route می‌بیند بازسازی می‌کنیم.
        expect(result.source).toBe("mock")

        const { client, eventUpdate } = makeEventSpy()
        const failure = attachAiCallTelemetry(new Error("boom"), { durationMs: 4321 })
        await releaseQuota(
            client,
            "req-plan-fail",
            undefined,
            { failureCode: "AI_PROVIDER_UNAVAILABLE", periodStart: PERIOD },
            readAiCallTelemetry(failure),
        )
        expect(lastEventData(eventUpdate)?.durationMs).toBe(4321)
    })

    /* --- بدون telemetry: رفتار قبلی دست‌نخورده ------------------- */

    it("نبودن telemetry هیچ فیلدی به update اضافه نمی‌کند", async () => {
        const { client, eventUpdate } = makeEventSpy()

        await completeQuota(client, "req-plain", undefined, { periodStart: PERIOD })
        expect(lastEventData(eventUpdate)).toEqual({ status: "CONSUMED" })

        await releaseQuota(client, "req-plain-2", undefined, { periodStart: PERIOD })
        expect(lastEventData(eventUpdate)).toEqual({ status: "RELEASED" })
    })

    it("telemetry نامعتبر (NaN / صفر) هرگز به DB نمی‌رسد", async () => {
        const { client, eventUpdate } = makeEventSpy()
        await completeQuota(
            client,
            "req-bad",
            undefined,
            { periodStart: PERIOD },
            { durationMs: Number.NaN, attempts: 0 },
        )
        expect(lastEventData(eventUpdate)).toEqual({ status: "CONSUMED" })
    })

    /* --- release failure: رفتار قبلی حفظ شده --------------------- */

    it("release failure: fail-closed می‌ماند و سهمیه هرگز کم نمی‌شود", async () => {
        const { client, eventUpdate, quotaUpdate } = makeEventSpy()
        eventUpdate.mockRejectedValueOnce(new Error("db down"))

        await expect(
            releaseQuota(
                client,
                "req-rel",
                undefined,
                { failureCode: "AI_PROVIDER_UNAVAILABLE", periodStart: PERIOD },
                { durationMs: 900 },
            ),
        ).rejects.toBeInstanceOf(QuotaUnavailableError)

        // شکست در همان transition رخ داد، پس کاهش ردیف سهمیه اصلاً اجرا نشد؛
        // در یک DB واقعی transaction برگشت می‌خورد و event در RESERVED می‌ماند
        // تا markReleaseFailed آن را برای reconciliation علامه بزند.
        expect(quotaUpdate).not.toHaveBeenCalled()
    })

    it("release failure: markReleaseFailed مثل قبل فقط failureCode می‌نویسد", async () => {
        const { client, eventUpdate } = makeEventSpy()

        expect(await markReleaseFailed(client, "req-rel-2")).toBe(true)
        expect(lastEventData(eventUpdate)).toEqual({ failureCode: "RELEASE_FAILED" })
    })

    /* --- timing safety: fail-Open --------------------------------- */

    it("ساعت خراب → بدون throw و بدون داده، و مسیر AI سالم می‌ماند", async () => {
        const realPerf = globalThis.performance
        Object.defineProperty(globalThis, "performance", {
            configurable: true,
            value: {
                now: () => {
                    throw new Error("clock exploded")
                },
            },
        })
        try {
            const stop = startAiCallTimer()
            expect(stop(1)).toBeUndefined()
        } finally {
            Object.defineProperty(globalThis, "performance", { configurable: true, value: realPerf })
        }

        // عملیات واقعی AI بعد از خرابی ساعت باید همچنان کار کند
        fetchMock.mockResolvedValueOnce(ok())
        const result = await analyzeTask("کار")
        expect(result.analysis.priority).toBe("HIGH")
    })

    it("پرش ساعت (delta منفی) → دادهٔ نامعتبر گزارش نمی‌شود", () => {
        const realPerf = globalThis.performance
        let value = 1000
        Object.defineProperty(globalThis, "performance", {
            configurable: true,
            value: { now: () => value },
        })
        try {
            const stop = startAiCallTimer()
            value = 900 // ساعت عقب رفت (مثل NTP jump)
            expect(stop(2)).toBeUndefined()
        } finally {
            Object.defineProperty(globalThis, "performance", { configurable: true, value: realPerf })
        }
    })

    it("مدت واقعاً اندازه‌گیری می‌شود، نه صفرِ ساختگی", async () => {
        const stop = startAiCallTimer()
        await new Promise((resolve) => setTimeout(resolve, 25))
        const telemetry = stop(1)
        expect(telemetry?.durationMs).toBeGreaterThanOrEqual(20)
    })

    /* --- privacy: فقط عدد، بدون محتوا ----------------------------- */

    it("carrier هیچ فیلدی به خودِ شیء خطا اضافه نمی‌کند", () => {
        const error = new Error("boom")
        const before = Object.keys(error).length
        attachAiCallTelemetry(error, { durationMs: 10 })
        expect(Object.keys(error).length).toBe(before)
        expect(JSON.stringify(error)).toBe("{}")
        expect(readAiCallTelemetry(error)).toEqual({ durationMs: 10 })
    })

    it("payload ثبت‌شده فقط کلیدهای عددی دارد", async () => {
        const { client, eventUpdate } = makeEventSpy()
        const failure = attachAiCallTelemetry(new Error("boom"), { durationMs: 77, attempts: 2 })
        await releaseQuota(
            client,
            "req-privacy",
            undefined,
            { failureCode: "AI_PROVIDER_UNAVAILABLE", periodStart: PERIOD },
            readAiCallTelemetry(failure),
        )
        for (const [key, value] of Object.entries(lastEventData(eventUpdate) ?? {})) {
            expect(typeof value === "string" || typeof value === "number").toBe(true)
            expect(["status", "failureCode", "durationMs", "attempts"]).toContain(key)
        }
    })

    it("carrier روی مقدار غیرشیء یا بدون داده، بی‌اثر است", () => {
        expect(readAiCallTelemetry(undefined)).toBeUndefined()
        expect(readAiCallTelemetry("string")).toBeUndefined()
        expect(readAiCallTelemetry(42)).toBeUndefined()
        expect(readAiCallTelemetry({})).toBeUndefined()
    })
})
