import { describe, expect, it } from "vitest"

/* ------------------------------------------------------------------ */
/* Phase 1 — AI Daily Plan: buildPlanProposal                          */
/* هدف: اثبات Option A — AI فقط وزن‌ها را تغذیه می‌کند و scheduler      */
/* قطعی موجود (suggestDay) تنها authority تخصیص/ترتیب است.             */
/* ------------------------------------------------------------------ */

import type { AiBatchPlan, AiPlanItem } from "@/app/lib/ai/planSchema"
import { planApplyRequestSchema, planProposalSchema } from "@/app/schema/plannerSchema"
import { buildPlanProposal, type PlanProposal } from "./planProposal"
import { suggestDay, type SuggestionTaskInput } from "./suggestion"

const task = (
    id: number,
    overrides: Partial<SuggestionTaskInput> = {},
): SuggestionTaskInput => ({
    id,
    estimatedTime: null,
    score: null,
    priority: null,
    status: "TODO",
    allocatedMinutes: null,
    ...overrides,
})

const item = (
    taskId: number,
    order: number,
    overrides: Partial<AiPlanItem> = {},
): AiPlanItem => ({
    taskId,
    estimatedMinutes: 30,
    score: 50,
    priority: "MEDIUM",
    order,
    ...overrides,
})

const plan = (items: AiPlanItem[], unscheduled?: number[], summary?: string): AiBatchPlan => ({
    items,
    ...(unscheduled ? { unscheduledTaskIds: unscheduled } : {}),
    ...(summary ? { summary } : {}),
})

const args = (
    tasks: SuggestionTaskInput[],
    ai: AiBatchPlan,
    availableMinutes = 120,
    extra: Partial<Parameters<typeof buildPlanProposal>[0]> = {},
) => ({
    dayKey: "2026-09-27",
    planVersion: 5,
    rebalancedVersion: 5,
    availableMinutes,
    source: "1xai" as const,
    ai,
    tasks,
    ...extra,
})

describe("buildPlanProposal — basis", () => {
    it("carries dayKey, planVersion, capacity, task count and a fresh state", () => {
        const proposal = buildPlanProposal(
            args([task(1), task(2, { status: "DONE" })], plan([item(1, 1)])),
        )
        expect(proposal.basis).toEqual({
            dayKey: "2026-09-27",
            planVersion: 5,
            rebalancedVersion: 5,
            availableMinutes: 120,
            taskCount: 2,
            state: "fresh",
        })
    })

    it("carries the AI source and summary, and defaults unscheduled to []", () => {
        const withSummary = buildPlanProposal(args([task(1)], plan([item(1, 1)], undefined, "خلاصه")))
        expect(withSummary.source).toBe("1xai")
        expect(withSummary.summary).toBe("خلاصه")
        expect(withSummary.aiUnscheduledTaskIds).toEqual([])
    })

    it("echoes AI's advisory unscheduled ids", () => {
        const proposal = buildPlanProposal(
            args([task(1), task(2)], plan([item(1, 1)], [2])),
        )
        expect(proposal.aiUnscheduledTaskIds).toEqual([2])
    })
})

/* ------------------------------------------------------------------ */
/* Producer/Schema parity — the false-VALIDATION_ERROR regression       */
/*                                                                     */
/* The production bug: buildPlanProposal kept AI-unscheduled tasks in */
/* the deterministic engine's input (by design — the engine only      */
/* knows estimate/score/priority), so the engine could schedule a     */
/* task the AI had declared unscheduled. planApplyRequestSchema then  */
/* rejected that overlap with                                        */
/* «aiUnscheduledTaskIds نمی‌تواند با planned هم‌پوشانی داشته باشد»    */
/* and Apply returned 400 on a perfectly valid proposal.               */
/*                                                                     */
/* Contract (ADR-08): AI is advisory, suggestDay/distribute is the    */
/* sole scheduler. Disagreement between the two is a legitimate       */
/* outcome, not a malformed proposal — so producer and consumer must  */
/* agree that this output is valid.                                    */
/* ------------------------------------------------------------------ */

describe("buildPlanProposal — producer/schema parity (AI advisory vs engine authority)", () => {
    it("emits an Apply-valid proposal when the engine schedules a task AI called unscheduled", () => {
        // Exact shape of the reported production bug:
        //   AI: items=[1], unscheduledTaskIds=[2]  |  availableMinutes=120
        // Engine: task 2 has no AI item → keeps its own values (default estimate 30)
        //         → fits comfortably → lands in `planned`.
        const proposal = buildPlanProposal(
            args([task(1), task(2)], plan([item(1, 1)], [2]), 120),
        )

        // The disagreement is real and must be preserved, not filtered away
        expect(proposal.aiUnscheduledTaskIds).toEqual([2])
        expect(proposal.planned.map((p) => p.taskId)).toEqual([1, 2])

        // The invariant that was broken: producer output must satisfy BOTH schemas
        expect(planProposalSchema.safeParse(proposal).success).toBe(true)
        const applied = planApplyRequestSchema.safeParse({
            dayKey: proposal.basis.dayKey,
            expectedPlanVersion: proposal.basis.planVersion,
            proposal,
        })
        expect(applied.success).toBe(true)
    })

    it("accepts the realistic production payload (7 planned, 3 of them AI-unscheduled)", () => {
        // Regression fixture mirroring the reported day:
        //   planned              = [34, 39, 47, 22, 23, 35, 21]
        //   unfitted             = [19, 48, 20, 31, 32]
        //   aiUnscheduledTaskIds = [23, 35, 48, 47]   ← 23/35/47 ∈ planned, 48 ∈ unfitted
        // Overlap with BOTH engine buckets is allowed; it is a disagreement, not corruption.
        const proposal: PlanProposal = {
            basis: {
                dayKey: "2026-09-27",
                planVersion: 3,
                rebalancedVersion: 3,
                availableMinutes: 360,
                taskCount: 12,
                state: "fresh",
            },
            planned: [34, 39, 47, 22, 23, 35, 21].map((taskId, i) => ({
                taskId,
                estimatedMinutes: 45,
                suggestedMinutes: 45,
                order: i + 1,
                aiOrder: taskId,
                reason: null,
                priority: "MEDIUM" as const,
                score: 50,
                weight: 56.25,
                partial: false,
            })),
            unfitted: [19, 48, 20, 31, 32].map((taskId) => ({
                taskId,
                estimatedMinutes: 60,
                weight: 75,
                aiOrder: null,
                reason: null,
                priority: "LOW" as const,
                score: 30,
            })),
            plannedMinutes: 315,
            remainingMinutes: 45,
            aiUnscheduledTaskIds: [23, 35, 48, 47],
            source: "1xai",
        }

        const plannedIds = new Set(proposal.planned.map((p) => p.taskId))
        const unfittedIds = new Set(proposal.unfitted.map((p) => p.taskId))
        expect([23, 35, 47].every((id) => plannedIds.has(id))).toBe(true)
        expect(unfittedIds.has(48)).toBe(true)

        expect(planProposalSchema.safeParse(proposal).success).toBe(true)
        const applied = planApplyRequestSchema.safeParse({
            dayKey: proposal.basis.dayKey,
            expectedPlanVersion: proposal.basis.planVersion,
            proposal,
        })
        expect(applied.success).toBe(true)
    })

    it("keeps the engine authoritative: an AI-unscheduled task still lands in unfitted when it does not fit", () => {
        // Mirror image of the first case — the advisory signal must not talk the
        // engine into dropping something it can fit, nor into keeping something it can't.
        const proposal = buildPlanProposal(
            args([task(1), task(2)], plan([item(1, 1, { estimatedMinutes: 60 })], [2]), 20),
        )
        expect(proposal.aiUnscheduledTaskIds).toEqual([2])
        expect(proposal.planned.map((p) => p.taskId)).toEqual([])
        // هر دو زیرِ MIN_ALLOCATION(۱۵) می‌افتند؛ ۲ کم‌وزن‌تر است و اول می‌آید
        expect(proposal.unfitted.map((u) => u.taskId)).toEqual([2, 1])
        expect(planProposalSchema.safeParse(proposal).success).toBe(true)
    })
})

describe("buildPlanProposal — AI feeds weights, engine decides (Option A)", () => {
    it("uses AI estimatedMinutes/score for the deterministic allocation", () => {
        // ظرفیت ۳۰، یک تسک با تخمین AI = ۶۰ → سهم جزئی، نه تخمین قبلی (۱۰)
        const tasks = [task(1, { estimatedTime: 10 })]
        const proposal = buildPlanProposal(
            args(tasks, plan([item(1, 1, { estimatedMinutes: 60 })]), 30),
        )
        expect(proposal.planned).toHaveLength(1)
        expect(proposal.planned[0].estimatedMinutes).toBe(60)
        expect(proposal.planned[0].partial).toBe(true)
    })

    it("keeps the deterministic plan identical to suggestDay on the mapped inputs", () => {
        const tasks = [task(1), task(2), task(3)]
        const ai = plan([
            item(1, 3, { estimatedMinutes: 60, score: 80 }),
            item(2, 1, { estimatedMinutes: 30, score: 20 }),
            item(3, 2, { estimatedMinutes: 45, score: 50 }),
        ])

        const proposal = buildPlanProposal(args(tasks, ai, 90))
        const expected = suggestDay(90, [
            { ...task(1), estimatedTime: 60, score: 80, priority: "MEDIUM" },
            { ...task(2), estimatedTime: 30, score: 20, priority: "MEDIUM" },
            { ...task(3), estimatedTime: 45, score: 50, priority: "MEDIUM" },
        ])

        expect(proposal.planned.map((p) => p.taskId)).toEqual(expected.planned.map((p) => p.taskId))
        expect(proposal.plannedMinutes).toBe(expected.plannedMinutes)
        expect(proposal.remainingMinutes).toBe(expected.remainingMinutes)
    })

    it("treats AI order as advisory: ranked order stays deterministic regardless of AI order", () => {
        const tasks = [task(1), task(2), task(3)]
        // AI order کاملاً معکوس ترتیب وزنی قطعی است
        const ai = plan([
            item(1, 3, { estimatedMinutes: 60, score: 90 }),
            item(2, 2, { estimatedMinutes: 60, score: 50 }),
            item(3, 1, { estimatedMinutes: 60, score: 10 }),
        ])

        const proposal = buildPlanProposal(args(tasks, ai, 45))

        // order نهایی = rank قطعی موتور (نه order AI)
        expect(proposal.planned.map((p) => p.order)).toEqual(
            proposal.planned.map((_, i) => i + 1),
        )
        // aiOrder مقدار advisory خودش را نگه می‌دارد
        const first = proposal.planned[0]
        expect(first.aiOrder).toBe(3) // وزن بالاتر → task 1 → AI order 3
        // ترتیب قطعی: وزن نزولی (score 90 > 50 > 10)؛ کم‌وزن‌ترین (score 10) جا نمی‌شود
        expect(proposal.planned.map((p) => p.taskId)).toEqual([1, 2])
        expect(proposal.unfitted.map((u) => u.taskId)).toEqual([3])
    })

    it("feeds AI items into a single scheduler (no second scheduler behavior)", () => {
        const tasks = [task(1), task(2)]
        const ai = plan([item(1, 1, { estimatedMinutes: 30 }), item(2, 2, { estimatedMinutes: 30 })])
        const a = buildPlanProposal(args(tasks, ai, 60))
        const b = buildPlanProposal(args(tasks, ai, 60))
        expect(a).toEqual(b) // deterministic
    })
})

describe("buildPlanProposal — capacity / unfitted", () => {
    it("lists tasks outside capacity as unfitted and reports remaining minutes", () => {
        const tasks = [task(1), task(2)]
        const ai = plan([
            item(1, 1, { estimatedMinutes: 60, score: 90 }),
            item(2, 2, { estimatedMinutes: 60, score: 10 }),
        ])
        const proposal = buildPlanProposal(args(tasks, ai, 30))

        expect(proposal.planned).toHaveLength(1)
        expect(proposal.unfitted).toHaveLength(1)
        expect(proposal.unfitted[0].taskId).toBe(2)
        expect(proposal.plannedMinutes + proposal.remainingMinutes).toBeLessThanOrEqual(30)
    })

    it("gives unfitted tasks their advisory aiOrder too", () => {
        const tasks = [task(1), task(2)]
        const ai = plan([item(1, 1, { estimatedMinutes: 60, score: 90 }), item(2, 5, { estimatedMinutes: 60, score: 5 })])
        const proposal = buildPlanProposal(args(tasks, ai, 20))
        expect(proposal.planned).toEqual([])
        // unfitted با وزن صعودی مرتب می‌شود (کم‌وزن‌ترین اول) — aiOrder همراه می‌ماند
        expect(proposal.unfitted.map((u) => [u.taskId, u.aiOrder])).toEqual([
            [2, 5],
            [1, 1],
        ])
    })

    it("carries AI metadata (score/priority/estimate) for unfitted tasks", () => {
        // ظرفیت ۲۰ با دو تخمین ۶۰ → هر دو زیر MIN_ALLOCATION می‌افتند و unfitted می‌شوند
        const tasks = [task(1), task(2)]
        const ai = plan([
            item(1, 1, { estimatedMinutes: 60, score: 90, priority: "HIGH" }),
            item(2, 2, { estimatedMinutes: 60, score: 10, priority: "LOW" }),
        ])
        const proposal = buildPlanProposal(args(tasks, ai, 20))

        expect(proposal.planned).toEqual([])
        const unfitted = proposal.unfitted.find((u) => u.taskId === 2)!
        // metadata از همان AI item اصلی propagate شده — نه صرفاً estimatedMinutes
        expect(unfitted).toMatchObject({
            taskId: 2,
            estimatedMinutes: 60,
            score: 10,
            priority: "LOW",
            aiOrder: 2,
        })
        expect(typeof unfitted.weight).toBe("number")
    })

    it("keeps tasks with no AI item using their existing engine values", () => {
        const tasks = [task(1, { estimatedTime: 45, score: 70, priority: "HIGH" })]
        // AI برای تسک ۱ آیتمی ندارد (فقط یک id بی‌ربط) → تسک با مقادیر موجود خودش وارد موتور می‌شود
        const proposal = buildPlanProposal(args(tasks, plan([item(999, 1)]), 120))
        const planned = proposal.planned.find((p) => p.taskId === 1)
        expect(planned).toBeDefined()
        expect(planned?.aiOrder).toBeNull()
        expect(planned?.priority).toBe("HIGH")
        expect(planned?.score).toBe(70)
    })
})

describe("buildPlanProposal — AI reason (informational only)", () => {
    it("carries the AI's short reason on planned items", () => {
        const ai = plan([item(1, 1, { reason: "نیاز به انجام در ابتدای روز دارد" })])
        const proposal = buildPlanProposal(args([task(1)], ai))

        expect(proposal.planned[0]?.reason).toBe("نیاز به انجام در ابتدای روز دارد")
    })

    it("carries the AI's short reason on unfitted items too", () => {
        // ظرفیت ۳۰ با دو تخمین ۶۰ → تسکِ کم‌وزن‌تر (شماره ۲) جا نمی‌شود
        const ai = plan([
            item(1, 1, { estimatedMinutes: 60, score: 90, reason: "اولویت بالا" }),
            item(2, 2, { estimatedMinutes: 60, score: 10, reason: "در ظرفیت امروز جا نمی‌شود" }),
        ])
        const proposal = buildPlanProposal(args([task(1), task(2)], ai, 30))

        expect(proposal.planned).toHaveLength(1)
        expect(proposal.unfitted).toHaveLength(1)
        expect(proposal.unfitted[0]?.reason).toBe("در ظرفیت امروز جا نمی‌شود")
    })

    it("normalizes a missing reason to null (planned and unfitted)", () => {
        // AI دلیلی نداده است — proposal باید graceful بماند، نه crash کند
        const ai = plan([
            item(1, 1, { estimatedMinutes: 60, score: 90 }),
            item(2, 2, { estimatedMinutes: 60, score: 10 }),
        ])
        const proposal = buildPlanProposal(args([task(1), task(2)], ai, 30))

        expect(proposal.planned[0]?.reason).toBeNull()
        expect(proposal.unfitted[0]?.reason).toBeNull()
    })

    it("never lets reason influence the deterministic engine's decisions", () => {
        // همان ورودی، دو بار — یکی با reason و یکی بدون: خروجی موتور باید یکسان باشد
        const withoutReason = plan([item(1, 1, { estimatedMinutes: 60 })])
        const withReason = plan([item(1, 1, { estimatedMinutes: 60, reason: "دلیل کاملاً متفاوت" })])

        const a = buildPlanProposal(args([task(1)], withoutReason))
        const b = buildPlanProposal(args([task(1)], withReason))

        // تمام تصمیم‌های موتور یکسان‌اند؛ تنها difference باید خودِ reason باشد
        const strip = (p: ReturnType<typeof buildPlanProposal>) => ({
            planned: p.planned.map(({ reason: _reason, ...rest }) => rest),
            unfitted: p.unfitted.map(({ reason: _reason, ...rest }) => rest),
            plannedMinutes: p.plannedMinutes,
            remainingMinutes: p.remainingMinutes,
        })

        expect(strip(b)).toEqual(strip(a))
    })
})

describe("buildPlanProposal — purity", () => {
    it("does not mutate the input tasks or AI output", () => {
        const tasks = [task(1, { estimatedTime: 10 })]
        const ai = plan([item(1, 1, { estimatedMinutes: 60 })])
        const tasksSnapshot = JSON.stringify(tasks)
        const aiSnapshot = JSON.stringify(ai)

        buildPlanProposal(args(tasks, ai, 30))

        expect(JSON.stringify(tasks)).toBe(tasksSnapshot)
        expect(JSON.stringify(ai)).toBe(aiSnapshot)
    })
})
