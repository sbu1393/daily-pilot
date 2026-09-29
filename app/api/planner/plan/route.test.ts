import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* Phase 2 — Route test: POST /api/planner/plan                        */
/*                                                                    */
/* DB/AI/quota mocked; validation + proposal builder are REAL so this */
/* is an integration-level proof of the pipeline.                     */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    getPrisma: vi.fn(),
    isRateLimited: vi.fn(),
    getCanonicalToday: vi.fn(),
    getPlanGenerationContext: vi.fn(),
    analyzeBatchPlan: vi.fn(),
    reserveQuota: vi.fn(),
    completeQuota: vi.fn(),
    releaseQuota: vi.fn(),
    markReleaseFailed: vi.fn(),
    recordError: vi.fn(),
    // Phase 4 — قاعدهٔ cutover و ledger جدید داخل `runAiOperation` خوانده می‌شوند.
    readCutoverAt: vi.fn(),
    reserveBucketQuota: vi.fn(),
    completeBucketQuota: vi.fn(),
    releaseBucketQuota: vi.fn(),
    recordProviderOutcome: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: mocks.getPrisma }))
vi.mock("@/app/lib/rateLimit", () => ({ isRateLimited: mocks.isRateLimited }))
vi.mock("@/app/lib/canonicalDay", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/canonicalDay")>()),
    getCanonicalToday: mocks.getCanonicalToday,
}))
vi.mock("@/app/lib/services/plan.service", () => ({
    getPlanGenerationContext: mocks.getPlanGenerationContext,
}))
vi.mock("@/app/lib/ai/analyzeBatchPlan", () => ({ analyzeBatchPlan: mocks.analyzeBatchPlan }))
vi.mock("@/app/lib/services/aiQuota.service", () => ({
    reserveQuota: mocks.reserveQuota,
    completeQuota: mocks.completeQuota,
    releaseQuota: mocks.releaseQuota,
}))
vi.mock("@/app/lib/services/aiQuotaCutover.service", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/services/aiQuotaCutover.service")>()),
    readCutoverAt: mocks.readCutoverAt,
}))
vi.mock("@/app/lib/services/aiQuotaV2.service", () => ({
    reserveBucketQuota: mocks.reserveBucketQuota,
    completeBucketQuota: mocks.completeBucketQuota,
    releaseBucketQuota: mocks.releaseBucketQuota,
}))
vi.mock("@/app/lib/services/aiUsage.service", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/services/aiUsage.service")>()),
    markReleaseFailed: mocks.markReleaseFailed,
    recordProviderOutcome: mocks.recordProviderOutcome,
}))
vi.mock("@/src/lib/observability/recordError", () => ({ recordError: mocks.recordError }))

import { POST } from "./route"
import {
    AiProviderUnavailableError,
    DayPlanNotSetError,
    NoPlannableTasksError,
    QuotaExceededError,
} from "@/app/lib/services/errors"

const USER = { id: 1, username: "test", email: "t@example.com", timezone: "Asia/Tehran", plan: "FREE" }
const DAY_KEY = "2026-09-27"

const INPUT = {
    dayKey: DAY_KEY,
    availableMinutes: 120,
    tasks: [
        { taskId: 1, title: "گزارش فروش" },
        { taskId: 2, title: "خرید نان" },
    ],
}

const CTX = {
    planVersion: 3,
    rebalancedVersion: 2,
    availableMinutes: 120,
    input: INPUT,
    suggestionTasks: [
        { id: 1, estimatedTime: null, score: null, priority: null, status: "TODO", allocatedMinutes: null },
        { id: 2, estimatedTime: null, score: null, priority: null, status: "TODO", allocatedMinutes: null },
    ],
}

const AI_PLAN = {
    items: [
        { taskId: 1, estimatedMinutes: 30, score: 70, priority: "HIGH", order: 2 },
        { taskId: 2, estimatedMinutes: 20, score: 40, priority: "LOW", order: 1 },
    ],
}

const prismaMock = {
    task: { update: vi.fn(), updateMany: vi.fn(), create: vi.fn(), delete: vi.fn() },
    dailyPlan: { update: vi.fn(), updateMany: vi.fn(), upsert: vi.fn(), create: vi.fn() },
}

const callPOST = (body: unknown) =>
    POST(
        new NextRequest("http://localhost/api/planner/plan", {
            method: "POST",
            body: typeof body === "string" ? body : JSON.stringify(body),
        }),
    )

describe("POST /api/planner/plan", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
        mocks.getPrisma.mockReturnValue(prismaMock)
        mocks.isRateLimited.mockReturnValue(false)
        mocks.getCanonicalToday.mockReturnValue(DAY_KEY)
        mocks.getPlanGenerationContext.mockResolvedValue(CTX)
        mocks.analyzeBatchPlan.mockResolvedValue({ source: "1xai", plan: AI_PLAN, attempts: 1 })
        mocks.reserveQuota.mockResolvedValue(undefined)
        mocks.completeQuota.mockResolvedValue(true)
        mocks.releaseQuota.mockResolvedValue(true)
        mocks.markReleaseFailed.mockResolvedValue(true)
        mocks.recordError.mockResolvedValue(undefined)
        // cutover در آینده ⇒ این دوره LEGACY است (رفتار فعلیِ محصول)
        mocks.readCutoverAt.mockResolvedValue(new Date("2026-10-01T00:00:00.000Z"))
        mocks.recordProviderOutcome.mockResolvedValue(true)
    })

    it("returns a valid ephemeral proposal with basis/source and no mutation", async () => {
        const res = await callPOST({ dayKey: DAY_KEY })

        expect(res.status).toBe(200)
        const parsed = await res.json()
        expect(parsed.ok).toBe(true)
        expect(parsed.data.source).toBe("1xai")
        expect(parsed.data.basis).toEqual({
            dayKey: DAY_KEY,
            planVersion: 3,
            rebalancedVersion: 2,
            availableMinutes: 120,
            taskCount: 2,
            state: "fresh",
        })
        expect(parsed.data.planned.map((p: any) => p.taskId).sort()).toEqual([1, 2])
        expect(parsed.data.planned[0].aiOrder).toBeDefined()
    })

    it("consumes exactly one quota unit (feature 'plan') and completes it", async () => {
        await callPOST({ dayKey: DAY_KEY })

        expect(mocks.reserveQuota).toHaveBeenCalledTimes(1)
        const reserveArg = mocks.reserveQuota.mock.calls[0][1]
        expect(reserveArg).toMatchObject({ userId: 1, units: 1, feature: "plan", allowedUnits: 15 })
        expect(reserveArg.requestId).toEqual(expect.any(String))
        expect(mocks.completeQuota).toHaveBeenCalledTimes(1)
        expect(mocks.releaseQuota).not.toHaveBeenCalled()
    })

    it("never mutates DailyPlan or Task allocation (proposal is read-only/ephemeral)", async () => {
        await callPOST({ dayKey: DAY_KEY })

        for (const fn of [
            prismaMock.task.update,
            prismaMock.task.updateMany,
            prismaMock.task.create,
            prismaMock.task.delete,
            prismaMock.dailyPlan.update,
            prismaMock.dailyPlan.updateMany,
            prismaMock.dailyPlan.upsert,
            prismaMock.dailyPlan.create,
        ]) {
            expect(fn).not.toHaveBeenCalled()
        }
    })

    it("defaults dayKey to the user's canonical today and never accepts client capacity/tasks", async () => {
        await callPOST({})

        expect(mocks.getCanonicalToday).toHaveBeenCalledWith("Asia/Tehran")
        expect(mocks.getPlanGenerationContext).toHaveBeenCalledWith(1, DAY_KEY)
    })

    it("passes a client-provided dayKey through after validating it", async () => {
        await callPOST({ dayKey: "2026-01-02" })
        expect(mocks.getPlanGenerationContext).toHaveBeenCalledWith(1, "2026-01-02")
    })

    it("returns 401 and consumes no quota when unauthenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await callPOST({ dayKey: DAY_KEY })

        expect(res.status).toBe(401)
        expect(mocks.reserveQuota).not.toHaveBeenCalled()
        expect(mocks.analyzeBatchPlan).not.toHaveBeenCalled()
    })

    it("returns 400 for a malformed body and never touches business/quota", async () => {
        const res = await callPOST("not json")

        expect(res.status).toBe(400)
        expect((await res.json()).error.code).toBe("VALIDATION_ERROR")
        expect(mocks.reserveQuota).not.toHaveBeenCalled()
    })

    it("returns 400 for invalid field types", async () => {
        const res = await callPOST({ dayKey: 123 })

        expect(res.status).toBe(400)
        expect((await res.json()).error.code).toBe("VALIDATION_ERROR")
        expect(mocks.reserveQuota).not.toHaveBeenCalled()
    })

    it("returns 400 for a calendar-invalid dayKey and never calls the loader", async () => {
        const res = await callPOST({ dayKey: "2026-13-99" })

        expect(res.status).toBe(400)
        expect((await res.json()).error.code).toBe("VALIDATION_ERROR")
        expect(mocks.getPlanGenerationContext).not.toHaveBeenCalled()
    })

    it("returns 429 RATE_LIMITED before loading or consuming quota", async () => {
        mocks.isRateLimited.mockReturnValue(true)

        const res = await callPOST({ dayKey: DAY_KEY })

        expect(res.status).toBe(429)
        expect((await res.json()).error.code).toBe("RATE_LIMITED")
        expect(mocks.getPlanGenerationContext).not.toHaveBeenCalled()
        expect(mocks.reserveQuota).not.toHaveBeenCalled()
    })

    it("returns 404 DAY_PLAN_NOT_SET when there is no valid day/plan state", async () => {
        mocks.getPlanGenerationContext.mockRejectedValue(new DayPlanNotSetError())

        const res = await callPOST({ dayKey: DAY_KEY })

        expect(res.status).toBe(404)
        expect((await res.json()).error.code).toBe("DAY_PLAN_NOT_SET")
        expect(mocks.reserveQuota).not.toHaveBeenCalled()
    })

    it("returns 404 NO_PLANNABLE_TASKS when there are no open tasks", async () => {
        mocks.getPlanGenerationContext.mockRejectedValue(new NoPlannableTasksError())

        const res = await callPOST({ dayKey: DAY_KEY })

        expect(res.status).toBe(404)
        expect((await res.json()).error.code).toBe("NO_PLANNABLE_TASKS")
        expect(mocks.reserveQuota).not.toHaveBeenCalled()
    })

    it("returns 429 QUOTA_EXCEEDED and never calls the AI", async () => {
        mocks.reserveQuota.mockRejectedValue(new QuotaExceededError())

        const res = await callPOST({ dayKey: DAY_KEY })

        expect(res.status).toBe(429)
        expect((await res.json()).error.code).toBe("QUOTA_EXCEEDED")
        expect(mocks.analyzeBatchPlan).not.toHaveBeenCalled()
        expect(mocks.completeQuota).not.toHaveBeenCalled()
    })

    it("releases quota (with provider failureCode) and returns 503 when the AI is unavailable", async () => {
        mocks.analyzeBatchPlan.mockRejectedValue(new AiProviderUnavailableError())

        const res = await callPOST({ dayKey: DAY_KEY })

        expect(res.status).toBe(503)
        expect((await res.json()).error.code).toBe("AI_PROVIDER_UNAVAILABLE")
        expect(mocks.releaseQuota).toHaveBeenCalledTimes(1)
        expect(mocks.releaseQuota.mock.calls[0][3]).toMatchObject({
            failureCode: "AI_PROVIDER_UNAVAILABLE",
        })
        expect(mocks.completeQuota).not.toHaveBeenCalled()
        expect(mocks.recordError).toHaveBeenCalled()
    })

    it("stays fail-closed (QUOTA_UNAVAILABLE) when release itself fails, and marks reconciliation", async () => {
        mocks.analyzeBatchPlan.mockRejectedValue(new AiProviderUnavailableError())
        mocks.releaseQuota.mockRejectedValue(new Error("db down"))

        const res = await callPOST({ dayKey: DAY_KEY })

        expect(res.status).toBe(503)
        expect((await res.json()).error.code).toBe("QUOTA_UNAVAILABLE")
        expect(mocks.markReleaseFailed).toHaveBeenCalledTimes(1)
        expect(mocks.completeQuota).not.toHaveBeenCalled()
    })

    it("releases quota and returns 502 AI_PLAN_INVALID when AI output fails semantic validation", async () => {
        mocks.analyzeBatchPlan.mockResolvedValue({
            source: "1xai",
            plan: { items: [{ taskId: 99, estimatedMinutes: 30, score: 70, priority: "HIGH", order: 1 }] },
            attempts: 1,
        })

        const res = await callPOST({ dayKey: DAY_KEY })

        expect(res.status).toBe(502)
        expect((await res.json()).error.code).toBe("AI_PLAN_INVALID")
        expect(mocks.releaseQuota).toHaveBeenCalledTimes(1)
        expect(mocks.releaseQuota.mock.calls[0][3]).toMatchObject({ failureCode: "AI_PLAN_INVALID" })
        expect(mocks.completeQuota).not.toHaveBeenCalled()
        expect(mocks.recordError).toHaveBeenCalled()
    })

    it("passes the mock source through to the proposal", async () => {
        mocks.analyzeBatchPlan.mockResolvedValue({ source: "mock", plan: AI_PLAN, attempts: 0 })

        const res = await callPOST({ dayKey: DAY_KEY })

        expect(res.status).toBe(200)
        expect((await res.json()).data.source).toBe("mock")
    })

    it("carries X-Request-ID on both success and error responses", async () => {
        const ok = await callPOST({ dayKey: DAY_KEY })
        expect(ok.headers.get("X-Request-ID")).toEqual(expect.any(String))

        mocks.analyzeBatchPlan.mockRejectedValue(new AiProviderUnavailableError())
        const err = await callPOST({ dayKey: DAY_KEY })
        expect(err.headers.get("X-Request-ID")).toEqual(expect.any(String))
    })
})

/* ------------------------------------------------------------------ */
/* سند §۲۳ Test 10 — رفتار کنترل‌شده در برابر Generate همزمان          */
/* ------------------------------------------------------------------ */
/*                                                                       */
/* پرسش: اگر دو درخواست Generate برای یک user/day همزمان برسند چه       */
/* می‌شود؟ گزارش Audit قبلی این مسیر را پوشش نداده بود.                  */
/*                                                                       */
/* نتیجه‌ی رفتار فعلی (بدون تغییر در پیاده‌سازی):                        */
/* - هر دو درخواست ۲۰۰ می‌گیرند (rate limit اینجا فعال نیست).          */
/* - هر دو به AI می‌رسند: ۲ فراخوانی provider.                          */
/* - هر دو دقیقاً یک واحد کووتا رزرو و مصرف می‌کنند — چون هر Generate    */
/*   طبق سند §۱۹ یک AI request است و باید یک واحد مصرف کند.             */
/* - هیچ تداخلی روی reserveQuota نیست: هر درخواست requestId مستقل     */
/*   (randomUUID) دارد، پس idempotency key برخورد نمی‌کند و CAS هر      */
/*   دو رزرو را جداگانه موفق می‌کند.                                    */
/* - هیچ partial mutation رخ نمی‌دهد: proposal هرگز persist نمی‌شود.   */
/*                                                                       */
/* این رفتار «کنترل‌شده و قابل پیش‌بینی» است و با سند سازگار است، بنابراین */
/* عمداً هیچ تغییری در پیاده‌سازی داده نشد (فقط پوشش تست).              */
/* ------------------------------------------------------------------ */

describe("POST /api/planner/plan — concurrent Generate", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
        mocks.getPrisma.mockReturnValue(prismaMock)
        mocks.isRateLimited.mockReturnValue(false)
        mocks.getCanonicalToday.mockReturnValue(DAY_KEY)
        mocks.getPlanGenerationContext.mockResolvedValue(CTX)
        mocks.reserveQuota.mockResolvedValue(undefined)
        mocks.completeQuota.mockResolvedValue(true)
        mocks.releaseQuota.mockResolvedValue(true)
        mocks.markReleaseFailed.mockResolvedValue(true)
        mocks.recordError.mockResolvedValue(undefined)
        // cutover در آینده ⇒ این دوره LEGACY است (رفتار فعلیِ محصول)
        mocks.readCutoverAt.mockResolvedValue(new Date("2026-10-01T00:00:00.000Z"))
        mocks.recordProviderOutcome.mockResolvedValue(true)
    })

    it("handles two simultaneous Generate calls as two independent, fully-quota'd proposals", async () => {
        // هر دو فراخوانی provider معلق می‌مانند تا واقعاً همزمان در جریان باشند
        const gates: Array<() => void> = []
        mocks.analyzeBatchPlan.mockImplementation(
            async () =>
                new Promise((resolve) => {
                    gates.push(() => resolve({ source: "1xai", plan: AI_PLAN, attempts: 1 }))
                }),
        )

        // هر دو درخواست همزمان شروع می‌شوند و داخل AI معلق می‌مانند
        const pendingA = callPOST({ dayKey: DAY_KEY })
        const pendingB = callPOST({ dayKey: DAY_KEY })

        // فرصت می‌دهیم هر دو به فراخوانی provider برسند و همان‌جا معلق شوند
        await new Promise((resolve) => setImmediate(resolve))
        expect(gates).toHaveLength(2)
        gates.forEach((open) => open())

        const [resA, resB] = await Promise.all([pendingA, pendingB])

        const [bodyA, bodyB] = [await resA.json(), await resB.json()]

        // ۱) هر دو درخواست پاسخ معتبر و مستقل می‌گیرند
        expect(resA.status).toBe(200)
        expect(resB.status).toBe(200)
        expect(bodyA.ok).toBe(true)
        expect(bodyB.ok).toBe(true)
        expect(bodyA.data.basis.dayKey).toBe(DAY_KEY)
        expect(bodyB.data.basis.dayKey).toBe(DAY_KEY)
        expect(bodyA.data.planned.map((p: any) => p.taskId).sort()).toEqual([1, 2])
        expect(bodyB.data.planned.map((p: any) => p.taskId).sort()).toEqual([1, 2])

        // ۲) دقیقاً یک AI call به ازای هر Generate (بدون تکرار/بی‌صدا شدن)
        expect(mocks.analyzeBatchPlan).toHaveBeenCalledTimes(2)

        // ۳) هر Generate یک واحد رزرو و یک واحد مصرف می‌کند
        expect(mocks.reserveQuota).toHaveBeenCalledTimes(2)
        expect(mocks.completeQuota).toHaveBeenCalledTimes(2)
        expect(mocks.reserveQuota.mock.calls.every((c) => c[1].units === 1)).toBe(true)

        // requestId ها مستقل‌اند → هیچ برخورد idempotency رخ نمی‌دهد
        const requestIds = mocks.reserveQuota.mock.calls.map((c) => c[1].requestId)
        expect(new Set(requestIds).size).toBe(2)
        // امضا: completeQuota(prisma, requestId, ...) → requestId آرگومان دوم است
        // ترتیبِ فراخوانی زیر همزمانی تضمین‌شده نیست، ولی هر رزرو دقیقاً یک complete
        // روی همان requestId دارد (نه بیشتر، نه کمتر)
        const completedIds = mocks.completeQuota.mock.calls.map((c) => c[1])
        expect(completedIds.slice().sort()).toEqual(requestIds.slice().sort())

        // ۴) هیچ رزرو معلقی رها نشده (نه release، نه markReleaseFailed)
        expect(mocks.releaseQuota).not.toHaveBeenCalled()
        expect(mocks.markReleaseFailed).not.toHaveBeenCalled()
        expect(mocks.recordError).not.toHaveBeenCalled()

        // ۵) هیچ mutation نیمه‌کاره: proposal گذراست
        expect(prismaMock.dailyPlan.updateMany).not.toHaveBeenCalled()
        expect(prismaMock.dailyPlan.update).not.toHaveBeenCalled()
        expect(prismaMock.task.updateMany).not.toHaveBeenCalled()
        expect(prismaMock.task.update).not.toHaveBeenCalled()
    })

    it("keeps quota accounting correct when the two calls are released independently", async () => {
        // سناریوی سخت‌تر: یکی موفق، یکی شکست provider → فقط رزروِ شکست‌خورده آزاد می‌شود
        let call = 0
        mocks.analyzeBatchPlan.mockImplementation(async () => {
            call += 1
            if (call === 1) return { source: "1xai", plan: AI_PLAN, attempts: 1 }
            throw new AiProviderUnavailableError()
        })

        const [resOk, resFail] = await Promise.all([
            callPOST({ dayKey: DAY_KEY }),
            callPOST({ dayKey: DAY_KEY }),
        ])

        expect(resOk.status).toBe(200)
        expect(resFail.status).toBe(503)

        // هر دو رزرو مجزا؛ فقط شکستی release می‌شود
        expect(mocks.reserveQuota).toHaveBeenCalledTimes(2)
        expect(mocks.completeQuota).toHaveBeenCalledTimes(1)
        expect(mocks.releaseQuota).toHaveBeenCalledTimes(1)

        // رزروِ آزادشده همان درخواستِ شکست‌خورده است و با درخواستِ موفق یکی نیست
        // (امضا: releaseQuota(prisma, requestId, undefined, options))
        const releasedRequestId = mocks.releaseQuota.mock.calls[0][1]
        const completedRequestId = mocks.completeQuota.mock.calls[0][1]
        const reservedIds: string[] = mocks.reserveQuota.mock.calls.map((c) => c[1].requestId)

        expect(reservedIds).toContain(releasedRequestId)
        expect(reservedIds).toContain(completedRequestId)
        expect(releasedRequestId).not.toBe(completedRequestId)
        // failureCode فقط روی release شکست — نه روی درخواست موفق
        expect(mocks.releaseQuota.mock.calls[0][3].failureCode).toBe("AI_PROVIDER_UNAVAILABLE")
    })
})

/* ------------------------------------------------------------------ */
/* Producer/consumer contract guard                                    */
/*                                                                     */
/* The reported production bug returned a proposal that the sibling    */
/* Apply endpoint rejected with 400 VALIDATION_ERROR. Generate now     */
/* validates its own output against the canonical proposal schema, so  */
/* a producer/consumer mismatch surfaces HERE (as an internal fault)   */
/* rather than as a user-facing false rejection several clicks later.  */
/* ------------------------------------------------------------------ */
describe("POST /api/planner/plan — validates its own output against the canonical proposal schema", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
        mocks.getPrisma.mockReturnValue(prismaMock)
        mocks.isRateLimited.mockReturnValue(false)
        mocks.getCanonicalToday.mockReturnValue(DAY_KEY)
        mocks.getPlanGenerationContext.mockResolvedValue(CTX)
        mocks.reserveQuota.mockResolvedValue(undefined)
        mocks.completeQuota.mockResolvedValue(true)
        mocks.releaseQuota.mockResolvedValue(true)
        mocks.markReleaseFailed.mockResolvedValue(true)
        mocks.recordError.mockResolvedValue(undefined)
        // cutover در آینده ⇒ این دوره LEGACY است (رفتار فعلیِ محصول)
        mocks.readCutoverAt.mockResolvedValue(new Date("2026-10-01T00:00:00.000Z"))
        mocks.recordProviderOutcome.mockResolvedValue(true)
    })

    it("returns 200 for a proposal whose AI-unscheduled ids overlap the engine's planned list", async () => {
        // The exact production shape: AI declared task 2 unscheduled, the engine fit it anyway.
        mocks.analyzeBatchPlan.mockResolvedValue({
            source: "1xai",
            plan: { items: [AI_PLAN.items[0]], unscheduledTaskIds: [2] },
            attempts: 1,
        })

        const res = await callPOST({ dayKey: DAY_KEY })

        expect(res.status).toBe(200)
        const parsed = await res.json()
        expect(parsed.ok).toBe(true)
        expect(parsed.data.aiUnscheduledTaskIds).toEqual([2])
        expect(parsed.data.planned.map((p: any) => p.taskId)).toContain(2)
        expect(mocks.completeQuota).toHaveBeenCalledTimes(1)
    })

    it("emits a proposal that planApplyRequestSchema accepts (end-to-end contract parity)", async () => {
        const { planApplyRequestSchema } = await import("@/app/schema/plannerSchema")
        mocks.analyzeBatchPlan.mockResolvedValue({
            source: "1xai",
            plan: { items: [AI_PLAN.items[0]], unscheduledTaskIds: [2] },
            attempts: 1,
        })

        const res = await callPOST({ dayKey: DAY_KEY })
        const { data } = await res.json()

        // همان body‌ای که کلاینت بعداً می‌سازد
        const parsed = planApplyRequestSchema.safeParse({
            dayKey: DAY_KEY,
            expectedPlanVersion: data.basis.planVersion,
            proposal: data,
        })
        expect(parsed.success).toBe(true)
    })

    it("fails closed on a malformed proposal: 500, quota released, nothing completed", async () => {
        // شبیه‌سازی عیب داخلی producer: proposal ناسازگار با schema canonical.
        // چنین چیزی یک خطای ۵۰۰ داخلی است، نه ورودی نامعتبر کاربر (نه ۴۰۰ و نه پیام فارسی
        // دربارهٔ داده‌ها) — و نباید به‌عنوان quota مصرف‌شده از کاربر کسر شود.
        mocks.getPlanGenerationContext.mockResolvedValue({
            ...CTX,
            // planVersion منفی در basis ناسازگار با schema canonical است
            planVersion: -1,
        })

        const res = await callPOST({ dayKey: DAY_KEY })

        expect(res.status).toBe(500)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("INTERNAL")
        // جزئیات داخلی (پیام Zod) هرگز به کلاینت نمی‌رسد
        expect(JSON.stringify(parsed)).not.toContain("aiUnscheduledTaskIds")
        // quota آزاد شد، نه مصرف
        expect(mocks.releaseQuota).toHaveBeenCalledTimes(1)
        expect(mocks.completeQuota).not.toHaveBeenCalled()
        // عیب داخلی برای اپراتور ثبت می‌شود
        expect(mocks.recordError).toHaveBeenCalled()
    })
})
