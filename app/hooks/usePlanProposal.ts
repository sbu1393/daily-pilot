"use client"

import { useEffect, useMemo, useSyncExternalStore } from "react"

import {
    createPlanProposalOrchestrator,
    PLAN_PROPOSAL_STALE_MESSAGE,
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
    /** Discard محلی proposal — هیچ mutation ای انجام نمی‌دهد. (Reject/Close کاربر) */
    clear: () => void
    /** پیشنهادِ باز به‌دلیل mutation داخلی بی‌اعتبار شد (تغییر روز/کار/ظرفیت). */
    invalidate: () => void
    /** متن آمادهٔ بنر stale (بدون متن hard-code در کامپوننت). */
    staleMessage: string
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
 *   کهنه اعمال نشود (backend هم به‌هرحال با PLAN_STALE رد می‌کند). این invalidation «بی‌صدا»
 *   نیست: `isStale` روشن می‌شود تا UI به کاربر بگوید چرا مودال بسته شد و CTA بدهد.
 * - تفکیک از رد بک‌اند: PLAN_STALE (409) همچنان outcome.status === "stale" می‌دهد و
 *   `isStale` را روشن نمی‌کند — دو مسیر جدا، هر دو حفظ شده‌اند.
 * - بدون persistence: proposal فقط in-memory است.
 */
export function usePlanProposal(): UsePlanProposalResult {
    const flow = useMemo(() => createPlanProposalOrchestrator(), [])
    const state = useSyncExternalStore(flow.subscribe, flow.getState, flow.getState)

    // mutation invalidation — فقط همان event سراسری موجود (بدون سیستم event دوم)
    useEffect(() => {
        const onMutated = () => flow.invalidate()
        window.addEventListener("planner:mutated", onMutated)
        return () => window.removeEventListener("planner:mutated", onMutated)
    }, [flow])

    return {
        ...state,
        generate: flow.generate,
        apply: flow.apply,
        clear: flow.clear,
        invalidate: flow.invalidate,
        staleMessage: PLAN_PROPOSAL_STALE_MESSAGE,
    }
}
