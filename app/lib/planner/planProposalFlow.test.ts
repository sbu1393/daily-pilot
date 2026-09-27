import { describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* Phase 4.3 — planProposalFlow (Generate/Apply orchestration store)   */
/* بدون React/DOM و بدون شبکه: deps تزریق می‌شوند.                      */
/* ------------------------------------------------------------------ */

import { ApiClientError } from "@/app/lib/api/client"
import {
    buildApplyBody,
    buildGenerateBody,
    createPlanProposalOrchestrator,
    isPlanProposal,
    planProposalErrorMessage,
    type PlanProposal,
} from "./planProposalFlow"

const DAY = "2026-09-27"

const proposal = (overrides: Partial<PlanProposal> = {}): PlanProposal => ({
    basis: {
        dayKey: DAY,
        planVersion: 5,
        rebalancedVersion: 5,
        availableMinutes: 120,
        taskCount: 2,
        state: "fresh",
    },
    planned: [
        {
            taskId: 1,
            estimatedMinutes: 40,
            suggestedMinutes: 40,
            order: 1,
            aiOrder: 1,
            priority: "HIGH",
            score: 80,
            weight: 100,
            partial: false,
        },
    ],
    unfitted: [{ taskId: 2, estimatedMinutes: 30, weight: 60, aiOrder: 2, priority: "LOW", score: 30 }],
    plannedMinutes: 40,
    remainingMinutes: 80,
    aiUnscheduledTaskIds: [],
    source: "1xai",
    ...overrides,
})

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

/* ---------------- request bodies ---------------- */

describe("buildGenerateBody / buildApplyBody", () => {
    it("Generate sends only the dayKey (no tasks/capacity/planVersion from client)", () => {
        expect(buildGenerateBody(DAY)).toEqual({ dayKey: DAY })
    })

    it("Apply round-trips the exact proposal and sends expectedPlanVersion = basis.planVersion", () => {
        const p = proposal()
        const body = buildApplyBody(DAY, p)
        expect(body.dayKey).toBe(DAY)
        expect(body.expectedPlanVersion).toBe(5)
        expect(body.proposal).toBe(p) // همان reference — بدون بازسازی
    })
})

describe("isPlanProposal", () => {
    it("accepts a well-formed proposal", () => {
        expect(isPlanProposal(proposal())).toBe(true)
    })

    it("rejects malformed responses", () => {
        expect(isPlanProposal(null)).toBe(false)
        expect(isPlanProposal({})).toBe(false)
        expect(isPlanProposal({ basis: {}, planned: [], unfitted: [] })).toBe(false)
    })
})

describe("planProposalErrorMessage", () => {
    it.each([
        ["DAY_PLAN_NOT_SET"],
        ["NO_PLANNABLE_TASKS"],
        ["QUOTA_EXCEEDED"],
        ["AI_PROVIDER_UNAVAILABLE"],
        ["AI_PLAN_INVALID"],
        ["RATE_LIMITED"],
    ])("maps %s to a non-empty Persian message", (code) => {
        const msg = planProposalErrorMessage(new ApiClientError(400, code, "raw provider detail"))
        expect(msg.length).toBeGreaterThan(0)
        expect(msg).not.toBe("raw provider detail")
    })

    it("maps PLAN_STALE to the agreed user-facing message", () => {
        const msg = planProposalErrorMessage(new ApiClientError(409, "PLAN_STALE", "x"))
        expect(msg).toContain("به‌روز نیست")
    })

    it("falls back to a generic message for unknown errors", () => {
        expect(planProposalErrorMessage(new Error("boom"))).toBe("boom")
        expect(planProposalErrorMessage("weird")).toBe("خطای نامشخص")
    })
})

/* ---------------- Generate ---------------- */

describe("orchestrator — generate", () => {
    it("(1) stores the proposal and resolves loading state", async () => {
        const p = proposal()
        const flow = createPlanProposalOrchestrator({ fetchProposal: async () => p })

        const outcome = await flow.generate(DAY)

        expect(outcome.proposal).toBe(p)
        expect(flow.getState()).toEqual({ proposal: p, isGenerating: false, isApplying: false, error: null })
    })

    it("(2) does not expose an invalid proposal on error and maps the message", async () => {
        const flow = createPlanProposalOrchestrator({
            fetchProposal: async () => {
                throw new ApiClientError(404, "DAY_PLAN_NOT_SET", "no plan")
            },
        })

        const outcome = await flow.generate(DAY)

        expect(outcome.proposal).toBeNull()
        expect(outcome.message).toContain("ظرفیت")
        expect(flow.getState().proposal).toBeNull()
        expect(flow.getState().error).toContain("ظرفیت")
    })

    it("(5) a stale (older) generate response cannot overwrite a newer one", async () => {
        const first = deferred<PlanProposal>()
        const second = deferred<PlanProposal>()
        let call = 0
        const flow = createPlanProposalOrchestrator({
            fetchProposal: () => {
                call += 1
                return call === 1 ? first.promise : second.promise
            },
        })

        const p1 = flow.generate(DAY) // token 1
        const p2 = flow.generate(DAY) // token 2
        // پاسخ جدیدتر اول می‌رسد
        second.resolve(proposal({ basis: { ...proposal().basis, planVersion: 9 } }))
        await p2
        // پاسخ قدیمی بعداً می‌رسد و باید دور ریخته شود
        first.resolve(proposal({ basis: { ...proposal().basis, planVersion: 5 } }))
        await p1

        expect(flow.getState().proposal?.basis.planVersion).toBe(9)
        expect(flow.getState().isGenerating).toBe(false)
    })
})

/* ---------------- Apply ---------------- */

describe("orchestrator — apply", () => {
    it("(3)(4) sends the exact proposal returned by generate to the apply endpoint", async () => {
        const applyProposal = vi.fn().mockResolvedValue(undefined)
        const p = proposal()
        const flow = createPlanProposalOrchestrator({
            fetchProposal: async () => p,
            applyProposal,
        })

        const { proposal: generated } = await flow.generate(DAY)
        const outcome = await flow.apply()

        expect(outcome.status).toBe("applied")
        expect(generated).toBe(p)
        expect(applyProposal).toHaveBeenCalledTimes(1)
        expect(applyProposal.mock.calls[0][0]).toBe(DAY)
        expect(applyProposal.mock.calls[0][1]).toBe(p) // same object — not reconstructed
        expect(p.basis.planVersion).toBe(5)
    })

    it("(6) a successful apply clears the proposal", async () => {
        const flow = createPlanProposalOrchestrator({
            fetchProposal: async () => proposal(),
            applyProposal: async () => {},
        })
        await flow.generate(DAY)

        await flow.apply()

        expect(flow.getState().proposal).toBeNull()
        expect(flow.getState().isApplying).toBe(false)
    })

    it("(7) surfaces PLAN_STALE and discards the stale proposal (no retry)", async () => {
        const applyProposal = vi.fn().mockRejectedValue(new ApiClientError(409, "PLAN_STALE", "stale"))
        const flow = createPlanProposalOrchestrator({
            fetchProposal: async () => proposal(),
            applyProposal,
        })
        await flow.generate(DAY)

        const outcome = await flow.apply()

        expect(outcome.status).toBe("stale")
        expect(outcome.message).toContain("به‌روز نیست")
        expect(flow.getState().proposal).toBeNull()
        expect(applyProposal).toHaveBeenCalledTimes(1) // no automatic retry
    })

    it("keeps the proposal and reports the message on a generic apply failure", async () => {
        const flow = createPlanProposalOrchestrator({
            fetchProposal: async () => proposal(),
            applyProposal: async () => {
                throw new ApiClientError(429, "QUOTA_EXCEEDED", "quota")
            },
        })
        await flow.generate(DAY)

        const outcome = await flow.apply()

        expect(outcome.status).toBe("error")
        expect(flow.getState().proposal).not.toBeNull() // می‌تواند دوباره تأیید کند
    })

    it("(8) clear discards locally and never calls apply", async () => {
        const applyProposal = vi.fn().mockResolvedValue(undefined)
        const flow = createPlanProposalOrchestrator({
            fetchProposal: async () => proposal(),
            applyProposal,
        })
        await flow.generate(DAY)

        flow.clear()

        expect(flow.getState().proposal).toBeNull()
        expect(applyProposal).not.toHaveBeenCalled()
    })

    it("returns noop when there is no proposal (reject/close path)", async () => {
        const applyProposal = vi.fn().mockResolvedValue(undefined)
        const flow = createPlanProposalOrchestrator({ applyProposal })

        const outcome = await flow.apply()

        expect(outcome.status).toBe("noop")
        expect(applyProposal).not.toHaveBeenCalled()
    })

    it("prevents a duplicate apply while one is in flight", async () => {
        const gate = deferred<void>()
        const applyProposal = vi.fn().mockImplementation(() => gate.promise)
        const flow = createPlanProposalOrchestrator({
            fetchProposal: async () => proposal(),
            applyProposal,
        })
        await flow.generate(DAY)

        const first = flow.apply()
        const second = flow.apply() // در حال اعمال → noop

        gate.resolve()
        const [a, b] = await Promise.all([first, second])

        expect(a.status).toBe("applied")
        expect(b.status).toBe("noop")
        expect(applyProposal).toHaveBeenCalledTimes(1)
    })
})

/* ---------------- Phase 4.4 — day isolation & round-trip ---------------- */

describe("orchestrator — day isolation (Phase 4.4 / Step 12)", () => {
    it("apply targets the proposal's own day (basis.dayKey), not any external day", async () => {
        const applyProposal = vi.fn().mockResolvedValue(undefined)
        const pA = proposal({ basis: { ...proposal().basis, dayKey: "2026-09-27" } })
        const flow = createPlanProposalOrchestrator({ fetchProposal: async () => pA, applyProposal })

        await flow.generate("2026-09-27")
        await flow.apply()

        expect(applyProposal).toHaveBeenCalledTimes(1)
        expect(applyProposal.mock.calls[0][0]).toBe("2026-09-27")
        expect(applyProposal.mock.calls[0][1]).toBe(pA)
    })

    it("a proposal cleared by a day switch cannot be applied (no network call)", async () => {
        const applyProposal = vi.fn().mockResolvedValue(undefined)
        const flow = createPlanProposalOrchestrator({ fetchProposal: async () => proposal(), applyProposal })

        await flow.generate(DAY)
        flow.clear() // کاربر روز را عوض کرد
        const outcome = await flow.apply()

        expect(outcome.status).toBe("noop")
        expect(applyProposal).not.toHaveBeenCalled()
    })

    it("an in-flight generate from a previous day cannot reopen the modal after clear()", async () => {
        const d = deferred<PlanProposal>()
        const flow = createPlanProposalOrchestrator({ fetchProposal: () => d.promise })

        const pending = flow.generate("2026-09-27")
        flow.clear() // روز عوض شد پیش از رسیدن پاسخ
        d.resolve(proposal({ basis: { ...proposal().basis, dayKey: "2026-09-27" } }))
        const outcome = await pending

        expect(outcome.proposal).toBeNull()
        expect(flow.getState().proposal).toBeNull()
    })
})

describe("orchestrator — round-trip integrity (Phase 4.4 / Steps 3, 7)", () => {
    it("unfitted items (with score/priority) survive the full generate → apply round-trip", async () => {
        let captured: PlanProposal | null = null
        const p = proposal()
        const flow = createPlanProposalOrchestrator({
            fetchProposal: async () => p,
            applyProposal: async (_dayKey, sent) => {
                captured = sent
            },
        })

        await flow.generate(DAY)
        await flow.apply()

        expect(captured).toBe(p) // same reference — no reconstruction
        expect((captured as unknown as PlanProposal).unfitted).toEqual(p.unfitted)
        expect((captured as unknown as PlanProposal).unfitted[0]).toMatchObject({
            taskId: 2,
            score: 30,
            priority: "LOW",
        })
        // Apply payload carries expectedPlanVersion = basis.planVersion
        const body = buildApplyBody(p.basis.dayKey, p)
        expect(body.expectedPlanVersion).toBe(p.basis.planVersion)
        expect(body.dayKey).toBe(p.basis.dayKey)
    })
})

describe("orchestrator — subscription", () => {
    it("notifies subscribers on state transitions", async () => {
        const seen: string[] = []
        const flow = createPlanProposalOrchestrator({
            fetchProposal: async () => proposal(),
            applyProposal: async () => {},
        })
        const unsubscribe = flow.subscribe((s) => seen.push(`g:${s.isGenerating},p:${!!s.proposal}`))

        await flow.generate(DAY)
        flow.clear()
        unsubscribe()

        expect(seen).toContain("g:true,p:false")
        expect(seen).toContain("g:false,p:true")
        expect(seen[seen.length - 1]).toBe("g:false,p:false")
    })
})
