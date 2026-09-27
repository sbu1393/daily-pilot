import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* AI Daily Plan — integration test of the main spec §۲۴ lifecycle      */
/*                                                                       */
/* این repo زیرساخت E2E مرورگر (Playwright/Cypress) ندارد و vitest     */
/* آن هم فقط محیط node (بدون jsdom) دارد. این فایل نزدیک‌ترین معادل    */
/* قابل‌اجرای سناریوی سند است:                                       */
/*                                                                       */
/*   A+B+C → Generate → proposal(A,B,C) → Accept → version N             */
/*        → add D  → previous plan stale                                */
/*        → Generate → proposal(A,B,C,D) → Accept → version N+1          */
/*                                                                       */
/* لایه‌های واقعی (mock نشده‌اند):                                      */
/*   plan.service (خواندن زمینه) → analyzeBatchPlan (به‌جز خودِ شبکه)    */
/*   → parseAiPlanJson → validateBatchPlan → buildPlanProposal           */
/*   → applyPlan (گارد نسخه + تراکنش) → planProposalFlow (سمت کلاینت)  */
/*                                                                       */
/* فقط لایه‌های بیرونی fake هستند: شبکهٔ provider، Prisma (با             */
/* شبیه‌سازی درست rollback) و مسیر خواندن lazy rebalance.                */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getDayTasks: vi.fn(),
    fetchProviderRaw: vi.fn(),
}))

vi.mock("@/app/lib/services/tasks.service", () => ({ getDayTasks: mocks.getDayTasks }))

// شبکهٔ provider فاکتوری است؛ بقیهٔ خط (prompt → parse → validate) واقعی می‌ماند
vi.mock("@/app/lib/ai/providerClient", () => ({
    AI_BASE_URL: "https://test.invalid/v1",
    AI_MODEL: "test-model",
    AI_MAX_ATTEMPTS: 1,
    AI_TIMEOUT_MS: 12000,
    RetryableError: class RetryableError extends Error {},
    NonRetryableError: class NonRetryableError extends Error {},
    fetchProviderRaw: mocks.fetchProviderRaw,
    retryBackoffMs: () => 0,
    sleep: async () => {},
}))

import { getPlanGenerationContext } from "@/app/lib/services/plan.service"
import { applyPlan } from "@/app/lib/services/planApply.service"
import { analyzeBatchPlan } from "@/app/lib/ai/analyzeBatchPlan"
import { parseAiPlanJson } from "@/app/lib/ai/planSchema"
import { validateBatchPlan } from "@/app/lib/ai/planContract"
import { buildPlanProposal } from "./planProposal"
import { createPlanProposalOrchestrator } from "./planProposalFlow"
import { planApplyRequestSchema, planProposalSchema } from "@/app/schema/plannerSchema"
import { PlanStaleError, AiProviderUnavailableError } from "@/app/lib/services/errors"

/* ------------------------------------------------------------------ */
/* In-memory day: نسخه، ظرفیت و کارها با rollback واقعی                 */
/* ------------------------------------------------------------------ */

const USER_ID = 7
const OTHER_USER_ID = 99
const DAY = "2026-09-27"
const TIMEZONE = "Asia/Tehran"

type Status = "TODO" | "IN_PROGRESS" | "DONE"
type TaskRow = {
    id: number
    userId: number
    dayKey: string
    status: Status
    title: string
    estimatedTime: number | null
    score: number | null
    priority: "HIGH" | "MEDIUM" | "LOW" | null
    allocatedMinutes: number | null
}

function createDay(opts: { version: number; availableMinutes: number; tasks: TaskRow[] }) {
    let version = opts.version
    let availableMinutes = opts.availableMinutes
    const tasks = new Map(opts.tasks.map((t) => [t.id, { ...t }]))

    const readVersion = () => ({ availableMinutes, planVersion: version, rebalancedVersion: version })

    const tx = {
        dailyPlan: {
            updateMany: vi.fn(async (args: { where: { planVersion?: number } }) => {
                if (args.where.planVersion !== version) return { count: 0 }
                version += 1
                return { count: 1 }
            }),
        },
        task: {
            updateMany: vi.fn(
                async (args: {
                    where: { id: number; userId: number; dayKey: string; status: string }
                    data: { estimatedTime?: number; score?: number; priority?: string }
                }) => {
                    const task = tasks.get(args.where.id)
                    if (
                        !task ||
                        task.userId !== args.where.userId ||
                        task.dayKey !== args.where.dayKey ||
                        task.status !== args.where.status
                    ) {
                        return { count: 0 }
                    }
                    Object.assign(task, args.data)
                    return { count: 1 }
                },
            ),
        },
    }

    const prisma = {
        dailyPlan: {
            findUnique: vi.fn(async () => readVersion()),
        },
        task: {
            findMany: vi.fn(async (args: any) => {
                // apply: lookup by referenced ids
                if (args?.where?.id?.in) {
                    const referenced: (TaskRow | undefined)[] = args.where.id.in.map(
                        (id: number) => tasks.get(id),
                    )
                    return referenced
                        .filter((t: TaskRow | undefined): t is TaskRow => !!t && t.userId === args.where.userId)
                        .map((t) => ({ id: t.id, dayKey: t.dayKey, status: t.status }))
                }
                // plan.service: the full open task set of the day
                return [...tasks.values()]
                    .filter(
                        (t: TaskRow) =>
                            t.userId === args.where.userId &&
                            t.dayKey === args.where.dayKey &&
                            t.status !== args.where.status.not,
                    )
                    .map((t) => ({ ...t }))
            }),
        },
        $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => {
            const snapshot = { version, availableMinutes }
            const taskSnapshot = new Map([...tasks].map(([id, t]) => [id, { ...t }]))
            try {
                return await cb(tx)
            } catch (error) {
                version = snapshot.version
                availableMinutes = snapshot.availableMinutes
                tasks.clear()
                for (const [id, t] of taskSnapshot) tasks.set(id, t)
                throw error
            }
        }),
    }

    return {
        prisma,
        getVersion: () => version,
        getTask: (id: number) => tasks.get(id),
        addTask: (t: TaskRow) => void tasks.set(t.id, { ...t }),
        removeTask: (id: number) => void tasks.delete(id),
        ids: () => [...tasks.keys()].sort((a, b) => a - b),
    }
}

let day: ReturnType<typeof createDay>

vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: () => day.prisma }))

const taskRow = (id: number, overrides: Partial<TaskRow> = {}): TaskRow => ({
    id,
    userId: USER_ID,
    dayKey: DAY,
    status: "TODO",
    title: `کار ${id}`,
    estimatedTime: null,
    score: null,
    priority: null,
    allocatedMinutes: null,
    ...overrides,
})

/** خروجی AI به شکل JSON خام — دقیقاً همان چیزی که provider برمی‌گرداند */
const aiJson = (plan: unknown) => JSON.stringify(plan)

/** اجرای واقعی خط Generate: context → AI → validate → proposal */
async function generate() {
    const ctx = await getPlanGenerationContext(USER_ID, DAY)
    const ai = await analyzeBatchPlan(ctx.input)
    const issues = validateBatchPlan(
        ai.plan,
        ctx.input.tasks.map((t) => t.taskId),
    )
    if (issues.length > 0) throw new Error("AI_PLAN_INVALID")
    return buildPlanProposal({
        dayKey: DAY,
        planVersion: ctx.planVersion,
        rebalancedVersion: ctx.rebalancedVersion,
        availableMinutes: ctx.availableMinutes,
        source: ai.source,
        ai: ai.plan,
        tasks: ctx.suggestionTasks,
    })
}

/** Estimate 30/score 50 برای هر id داده‌شده، به ترتیب */
const planFor = (ids: number[], extra: Record<string, unknown> = {}) =>
    aiJson({
        items: ids.map((id, i) => ({
            taskId: id,
            estimatedMinutes: 30,
            score: 50,
            priority: "MEDIUM",
            order: i + 1,
            reason: `دلیل ${id}`,
        })),
        ...extra,
    })

beforeEach(() => {
    vi.clearAllMocks()
    process.env.AIXAI_API_KEY = "integration-test-key"
    day = createDay({
        version: 1,
        availableMinutes: 600,
        tasks: [taskRow(1), taskRow(2), taskRow(3)],
    })
    mocks.getDayTasks.mockImplementation(async () => {
        const tasks = [1, 2, 3, 4]
            .map((id: number) => day.getTask(id))
            .filter((t): t is TaskRow => !!t)
            .map((t: TaskRow) => ({ ...t }))
        return {
            tasks,
            summary: {
                dayKey: DAY,
                availableMinutes: 600,
                committedMinutes: 90,
                poolMinutes: 510,
            },
        }
    })
})

describe("spec §24 — main lifecycle: generate → accept → add task → regenerate → accept", () => {
    it("produces version N, then version N+1 with the new task included", async () => {
        // ── مرحله ۱: کارهای A, B, C ────────────────────────────────────
        mocks.fetchProviderRaw.mockResolvedValueOnce(planFor([1, 2, 3]))

        const first = await generate()
        expect(first.planned.map((p) => p.taskId).sort()).toEqual([1, 2, 3])
        expect(first.basis.planVersion).toBe(1)
        // AI هیچ روزِ/ظرفیتی تحمیل نکرده و دلیلش هم حمل شده
        expect(first.basis.availableMinutes).toBe(600)
        expect(first.planned[0]?.reason).toBe("دلیل 1")

        // ── مرحله ۲: Accept ───────────────────────────────────────────
        const appliedFirst = await applyPlan(USER_ID, {
            dayKey: DAY,
            timezone: TIMEZONE,
            expectedPlanVersion: first.basis.planVersion,
            proposal: first,
        })
        expect(appliedFirst.applied).toBe(true)
        expect(appliedFirst.planVersion).toBe(2)
        expect(day.getVersion()).toBe(2)
        // metadata فقط روی TODO نوشته شد
        expect(day.getTask(1)?.estimatedTime).toBe(30)

        // ── مرحله ۳: کار جدید D اضافه می‌شود → نسخه بالا می‌رود ─────
        day.addTask(taskRow(4, { title: "خرید نان" }))
        const bumped = await applyPlan(USER_ID, {
            dayKey: DAY,
            timezone: TIMEZONE,
            expectedPlanVersion: 1,
            proposal: first,
        }).then(
            () => null,
            (e) => e,
        )
        // نسخهٔ قبلی حالا کهنه است (این همان «Plan becomes stale» سند است)
        expect(bumped).toBeInstanceOf(PlanStaleError)

        // ── مرحله ۴: Generate مجدد باید کل مجموعه (A,B,C,D) را ببیند ──
        mocks.fetchProviderRaw.mockResolvedValueOnce(planFor([1, 2, 3, 4]))
        const second = await generate()
        expect(second.planned.map((p) => p.taskId).sort()).toEqual([1, 2, 3, 4])
        expect(second.basis.planVersion).toBe(2)
        expect(second.basis.taskCount).toBe(4)

        // ── مرحله ۵: Accept مجدد → نسخهٔ N+1 ──────────────────────────
        const appliedSecond = await applyPlan(USER_ID, {
            dayKey: DAY,
            timezone: TIMEZONE,
            expectedPlanVersion: second.basis.planVersion,
            proposal: second,
        })
        expect(appliedSecond.planVersion).toBe(3)
        expect(day.getTask(4)?.estimatedTime).toBe(30)
    })

    it("excludes a deleted task and a foreign user's task from the new proposal", async () => {
        day.removeTask(2)
        // کار کاربر دیگری در همان روز — نباید هرگز وارد proposal شود
        day.addTask(taskRow(500, { userId: OTHER_USER_ID, title: "کار کاربر دیگری" }))
        mocks.fetchProviderRaw.mockResolvedValueOnce(planFor([1, 3]))

        const proposal = await generate()
        const ids = [...proposal.planned, ...proposal.unfitted].map((i) => i.taskId).sort()

        expect(ids).toEqual([1, 3])
        expect(ids).not.toContain(2)
        expect(ids).not.toContain(500)
        // ظرفیت/نسخه از DB آمده، نه از کلاینت
        expect(proposal.basis.taskCount).toBe(2)
    })

    it("a rejected proposal leaves the day completely untouched", async () => {
        mocks.fetchProviderRaw.mockResolvedValueOnce(planFor([1, 2, 3]))
        const flow = createPlanProposalOrchestrator({
            fetchProposal: generate,
            applyProposal: async () => {
                throw new Error("Apply نباید صدا زده شود")
            },
        })

        await flow.generate(DAY)
        flow.clear() // کاربر «فعلاً نه» را می‌زند

        const outcome = await flow.apply()
        expect(outcome.status).toBe("noop")
        expect(day.getVersion()).toBe(1)
        expect(day.getTask(1)?.estimatedTime).toBeNull()
        expect(day.getTask(1)?.score).toBeNull()
    })

    it("capacity overflow yields unfitted tasks instead of an over-committed day", async () => {
        // تقاضای کل ۴ × ۶۰ = ۲۴۰ دقیقه، ظرفیت روز فقط ۸۰ دقیقه.
        // امتیازهای نامساوی تا موتور قطعی واقعاً مجبور به انتخاب/حذف شود
        // (با وزن‌های مساوی، الگوریتم min-allocation همه‌ی کارها را یکسان کنار می‌گذارد).
        day = createDay({
            version: 1,
            availableMinutes: 80,
            tasks: [taskRow(1), taskRow(2), taskRow(3), taskRow(4)],
        })
        const scores = [95, 80, 60, 20]
        mocks.fetchProviderRaw.mockResolvedValueOnce(
            aiJson({
                items: [1, 2, 3, 4].map((id, i) => ({
                    taskId: id,
                    estimatedMinutes: 60,
                    score: scores[i],
                    priority: "MEDIUM",
                    order: i + 1,
                })),
            }),
        )

        const proposal = await generate()

        expect(proposal.planned.length).toBeGreaterThan(0)
        expect(proposal.unfitted.length).toBeGreaterThan(0)
        // روز هرگز بیش از ظرفیت واقعی کاربر برنامه‌ریزی نمی‌شود
        expect(proposal.plannedMinutes).toBeLessThanOrEqual(80)
        expect(proposal.plannedMinutes + proposal.remainingMinutes).toBeLessThanOrEqual(80)
    })
})

/* ------------------------------------------------------------------ */
/* Production regression: AI advisory unscheduled ∩ engine planned     */
/*                                                                     */
/* The reported failure: Generate returned a proposal in which tasks   */
/* 23/35/47 were BOTH in `aiUnscheduledTaskIds` and in `planned`, and  */
/* Apply rejected it with 400                                        */
/* «aiUnscheduledTaskIds نمی‌تواند با planned هم‌پوشانی داشته باشد».     */
/*                                                                     */
/* This walks the REAL chain (AI parse → validateBatchPlan →          */
/* buildPlanProposal → planProposalSchema → planApplyRequestSchema →   */
/* applyPlan) with a provider that legitimately returns                 */
/* unscheduledTaskIds, and asserts the whole round-trip succeeds.      */
/* ------------------------------------------------------------------ */
describe("regression — AI advisory unscheduled overlaps engine planned", () => {
    it("generate → apply succeeds when the engine schedules a task AI called unscheduled", async () => {
        // ظرفیت کافی: هر دو تسک جا می‌شوند، اما AI تسک ۲ را «جا نمی‌شود» اعلام کرده
        day = createDay({ version: 3, availableMinutes: 360, tasks: [taskRow(23), taskRow(35)] })
        mocks.fetchProviderRaw.mockResolvedValueOnce(
            aiJson({
                items: [
                    { taskId: 23, estimatedMinutes: 60, score: 80, priority: "HIGH", order: 1 },
                ],
                unscheduledTaskIds: [35],
            }),
        )

        const proposal = await generate()

        // اختلاف نظر واقعی است و باید حفظ شود
        expect(proposal.aiUnscheduledTaskIds).toEqual([35])
        expect(proposal.planned.map((p) => p.taskId)).toContain(35)

        // دقیقاً همان دو دروازه‌ای که قبلاً ناسازگار بودند
        expect(planProposalSchema.safeParse(proposal).success).toBe(true)
        const applyBody = {
            dayKey: DAY,
            expectedPlanVersion: proposal.basis.planVersion,
            proposal,
        }
        const parsedApply = planApplyRequestSchema.safeParse(applyBody)
        expect(parsedApply.success).toBe(true)

        // و Apply واقعاً اجرا می‌شود (گارد نسخه می‌گذرد، metadata نوشته می‌شود)
        const applied = await applyPlan(USER_ID, {
            dayKey: DAY,
            timezone: TIMEZONE,
            expectedPlanVersion: proposal.basis.planVersion,
            proposal,
        })
        expect(applied.applied).toBe(true)
        expect(applied.planVersion).toBe(4)
        // هر دو تسک metadata گرفتند — از جمله آنکه AI جا نمی‌دانستش
        expect(day.getTask(23)?.estimatedTime).toBe(60)
        expect(day.getTask(35)?.estimatedTime).toBe(30)
    })

    it("round-trips the reported 7-planned / 3-overlapping production shape end to end", async () => {
        // شکل گزارش‌شده: ۷ planned که سه‌تایشان (23/35/47) AI-unscheduled هم هستند،
        // و یک unfitted (48) که آن هم AI-unscheduled است.
        const ids = [34, 39, 47, 22, 23, 35, 21, 19, 48, 20, 31, 32]
        day = createDay({
            version: 3,
            availableMinutes: 360,
            tasks: ids.map((id) => taskRow(id)),
        })
        // AI برای هشت کار آیتم می‌دهد و چهار کار را جا نمی‌داند
        const scored = [34, 39, 22, 21, 19, 20, 31, 32]
        mocks.fetchProviderRaw.mockResolvedValueOnce(
            aiJson({
                items: scored.map((id, i) => ({
                    taskId: id,
                    estimatedMinutes: 45,
                    score: 90 - i * 5,
                    priority: "HIGH",
                    order: i + 1,
                })),
                unscheduledTaskIds: [23, 35, 48, 47],
            }),
        )

        const proposal = await generate()

        // Advisory حفظ شده و دست‌کم یکی از آن‌ها واقعاً در planned نشسته است
        expect(proposal.aiUnscheduledTaskIds).toEqual([23, 35, 48, 47])
        const plannedIds = proposal.planned.map((p) => p.taskId)
        expect(proposal.aiUnscheduledTaskIds.filter((id) => plannedIds.includes(id)).length)
            .toBeGreaterThan(0)

        // دروازه‌های قرارداد
        expect(planProposalSchema.safeParse(proposal).success).toBe(true)
        const parsedApply = planApplyRequestSchema.safeParse({
            dayKey: DAY,
            expectedPlanVersion: proposal.basis.planVersion,
            proposal,
        })
        expect(parsedApply.success).toBe(true)

        // کل روز قابل Apply است
        const applied = await applyPlan(USER_ID, {
            dayKey: DAY,
            timezone: TIMEZONE,
            expectedPlanVersion: proposal.basis.planVersion,
            proposal,
        })
        expect(applied.applied).toBe(true)
        expect(applied.planVersion).toBe(4)
    })

    it("the advisory signal never changes what the engine scheduled", async () => {
        // تسک ۲ در DB همان مقادیری را دارد که AI برایش می‌داد (۶۰/۱۰)، پس تنها
        // متغیر واقعی این است که آیا AI آن را advisory-unscheduled اعلام کرده یا نه.
        const row = (id: number) => taskRow(id, { estimatedTime: 60, score: 10 })
        day = createDay({ version: 1, availableMinutes: 90, tasks: [row(1), row(2)] })
        mocks.fetchProviderRaw.mockResolvedValueOnce(
            aiJson({
                items: [
                    { taskId: 1, estimatedMinutes: 60, score: 80, priority: "HIGH", order: 1 },
                    { taskId: 2, estimatedMinutes: 60, score: 10, priority: "LOW", order: 2 },
                ],
            }),
        )
        const scheduledByAi = await generate()

        day = createDay({ version: 1, availableMinutes: 90, tasks: [row(1), row(2)] })
        mocks.fetchProviderRaw.mockResolvedValueOnce(
            aiJson({
                items: [{ taskId: 1, estimatedMinutes: 60, score: 80, priority: "HIGH", order: 1 }],
                unscheduledTaskIds: [2],
            }),
        )
        const unscheduledByAi = await generate()

        expect(unscheduledByAi.aiUnscheduledTaskIds).toEqual([2])
        // سیگنال advisory هیچ اثری بر تصمیم موتور نگذاشت.
        // فقط فیلدهای authoritative مقایسه می‌شوند: aiOrder/priority/reason ذاتاً
        // به وجود/عدم آیتم AI وابسته‌اند و در تصمیم تخصیص/ترتیب دخالت ندارند.
        const engineView = (p: typeof scheduledByAi) => ({
            planned: p.planned.map(({ taskId, suggestedMinutes, order, partial, weight }) => ({
                taskId,
                suggestedMinutes,
                order,
                partial,
                weight,
            })),
            unfitted: p.unfitted.map(({ taskId, weight }) => ({ taskId, weight })),
            plannedMinutes: p.plannedMinutes,
            remainingMinutes: p.remainingMinutes,
        })
        expect(engineView(unscheduledByAi)).toEqual(engineView(scheduledByAi))
    })
})

describe("spec §24 — generate is always a full re-analysis, never incremental", () => {
    it("re-sends every open task of the day to the AI on the second generate", async () => {
        mocks.fetchProviderRaw.mockResolvedValueOnce(planFor([1, 2, 3]))
        await generate()

        day.addTask(taskRow(4))
        mocks.fetchProviderRaw.mockResolvedValueOnce(planFor([1, 2, 3, 4]))
        await generate()

        // دو فراخوانی، و فراخوانی دوم شامل همهٔ چهار کار است
        expect(mocks.fetchProviderRaw).toHaveBeenCalledTimes(2)
        const secondPrompt = mocks.fetchProviderRaw.mock.calls[1][0]
        const userMessage = secondPrompt.find((m: { role: string }) => m.role === "user")?.content
        for (const id of [1, 2, 3, 4]) {
            expect(userMessage).toContain(`"taskId":${id}`)
        }
    })
})

describe("spec §23 — malformed AI output is rejected before it can reach the day", () => {
    it("rejects a fabricated taskId (not part of the day's task set)", async () => {
        const ctx = await getPlanGenerationContext(USER_ID, DAY)
        const parsed = parseAiPlanJson(planFor([1, 2, 999]))
        const issues = validateBatchPlan(
            parsed,
            ctx.input.tasks.map((t) => t.taskId),
        )

        expect(issues).toEqual(expect.arrayContaining([{ code: "UNKNOWN_TASK_ID", taskId: 999 }]))
        expect(day.getVersion()).toBe(1)
    })

    it("rejects a duplicated taskId", () => {
        const raw = JSON.stringify({
            items: [
                { taskId: 1, estimatedMinutes: 30, score: 50, priority: "MEDIUM", order: 1 },
                { taskId: 1, estimatedMinutes: 30, score: 50, priority: "MEDIUM", order: 2 },
            ],
        })

        expect(() => parseAiPlanJson(raw)).toThrow()
    })

    it("rejects an invalid duration (negative / zero / out of range)", () => {
        const bad = [-30, 0, 999999]
        for (const estimatedMinutes of bad) {
            const raw = JSON.stringify({
                items: [{ taskId: 1, estimatedMinutes, score: 50, priority: "MEDIUM", order: 1 }],
            })
            expect(() => parseAiPlanJson(raw)).toThrow()
        }
    })

    it("never lets a malformed provider response corrupt the day (env policy: non-prod mock fallback)", async () => {
        mocks.fetchProviderRaw.mockResolvedValueOnce("این JSON نیست")

        const ctx = await getPlanGenerationContext(USER_ID, DAY)
        const result = await analyzeBatchPlan(ctx.input)

        // قرارداد محیطی موجود: در non-production، شکست نهایی provider به یک mock قطعی
        // برمی‌گردد (نه پاسخ خام AI). یعنی پاسخ ناقص/خراب هرگز به proposal نمی‌رسد.
        expect(result.source).toBe("mock")
        expect(validateBatchPlan(
            result.plan,
            ctx.input.tasks.map((t) => t.taskId),
        )).toEqual([])

        // و در هیچ حالتی چیزی در DB تغییر نکرده است
        expect(day.getVersion()).toBe(1)
        expect(day.getTask(1)?.estimatedTime).toBeNull()
    })

    it("throws instead of falling back to a mock in production", async () => {
        vi.stubEnv("NODE_ENV", "production")
        try {
            mocks.fetchProviderRaw.mockResolvedValue("این JSON نیست")
            const ctx = await getPlanGenerationContext(USER_ID, DAY)

            await expect(analyzeBatchPlan(ctx.input)).rejects.toBeInstanceOf(
                AiProviderUnavailableError,
            )
            expect(day.getVersion()).toBe(1)
        } finally {
            vi.unstubAllEnvs()
        }
    })
})
