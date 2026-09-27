"use client"

import { useEffect, useMemo, useSyncExternalStore } from "react"

import {
    createPlanProposalOrchestrator,
    type ApplyPlanOutcome,
    type GeneratePlanOutcome,
    type PlanProposalFlowState,
} from "@/app/lib/planner/planProposalFlow"

export type {
    PlanProposal,
    ApplyPlanOutcome,
    GeneratePlanOutcome,
} from "@/app/lib/planner/planProposalFlow"

export type UsePlanProposalResult = PlanProposalFlowState & {
    /** Generate: proposal + پیام خطای احتمالی (بدون پرتاب استثنا). */
    generate: (dayKey: string) => Promise<GeneratePlanOutcome>
    /** Apply: proposal فعلی را به روزِ خودش (basis.dayKey) به endpoint موجود Apply می‌فرستد. */
    apply: () => Promise<ApplyPlanOutcome>
    /** Discard محلی proposal — هیچ mutation ای انجام نمی‌دهد. */
    clear: () => void
}

/**
 * usePlanProposal — orchestration سمت کلاینت برای «ایجاد برنامه» (Generate) و تأیید (Apply).
 *
 * - منطق واقعی در `planProposalFlow.ts` (store مستقل از React و کاملاً تست‌پذیر) است؛ این هوک
 *   فقط با useSyncExternalStore به آن وصل می‌شود.
 * - Generate فقط dayKey را می‌فرستد؛ task/capacity/allocated/planVersion هرگز از کلاینت نمی‌آید.
 * - Apply دقیقاً همان proposal برگشتی Generate را round-trip می‌کند.
 * - AI advisory است؛ این هوک هیچ allocation/status/task را تغییر نمی‌دهد.
 * - §15: هر mutation برنامه (`planner:mutated`) proposal باز را discard می‌کند تا هرگز proposal
 *   کهنه اعمال نشود (backend هم به‌هرحال با PLAN_STALE رد می‌کند).
 * - بدون persistence: proposal فقط in-memory است.
 */
export function usePlanProposal(): UsePlanProposalResult {
    const flow = useMemo(() => createPlanProposalOrchestrator(), [])
    const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState)

    // mutation invalidation — فقط همان event سراسری موجود (بدون سیستم event دوم)
    useEffect(() => {
        const onMutated = () => flow.clear()
        window.addEventListener("planner:mutated", onMutated)
        return () => window.removeEventListener("planner:mutated", onMutated)
    }, [flow])

    return {
        ...state,
        generate: flow.generate,
        apply: flow.apply,
        clear: flow.clear,
    }
}
