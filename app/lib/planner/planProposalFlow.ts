// Phase 4.3 — AI Daily Plan: frontend orchestration flow (framework-agnostic)
// ---------------------------------------------------------------------------
// این ماژول *همهٔ* منطق Generate/Apply سمت کلاینت را در یک store مستقل از React نگه می‌دارد:
//   - state (proposal / loading / error)
//   - request-sequence guard (پاسخ کهنه هرگز روی state جدید نوشته نمی‌شود)
//   - فراخوانی endpointهای موجود backend
//   - نگاشت خطاهای دامنه به پیام فارسی
//
// چرا store مستقل؟ چون زیرساخت تست repository فقط pure-logic `.test.ts` در محیط node است
// (بدون jsdom/React Testing Library)؛ این طراحی همان رفتار را واقعاً قابل تست می‌کند و hook فقط
// با useSyncExternalStore به آن وصل می‌شود.
//
// قواعد معماری (LOCKED):
//   - AI فقط advisory است؛ این ماژول هیچ‌گاه allocation/status/task را تغییر نمی‌دهد.
//   - backend مرجع نهایی است؛ proposal بدون هیچ بازسازی/تغییری round-trip می‌شود.
//   - هیچ scheduler/calulation دومی اینجا نیست.
//   - no persistence: proposal فقط in-memory است.

import { ApiClientError, api } from "@/app/lib/api/client"

export type PlanProposalPriority = "HIGH" | "MEDIUM" | "LOW"

/** قرارداد خروجی POST /api/planner/plan — آینهٔ PlanProposal سمت سرور (فقط خواندنی). */
export type PlanProposalPlannedItem = {
    taskId: number
    estimatedMinutes: number
    suggestedMinutes: number
    order: number
    aiOrder: number | null
    /** دلیل کوتاه AI — فقط informational (هیچ نقشی در ترتیب/تخصیص ندارد) */
    reason: string | null
    priority: PlanProposalPriority | null
    score: number | null
    weight: number
    partial: boolean
}

export type PlanProposalUnfittedItem = {
    taskId: number
    estimatedMinutes: number
    weight: number
    aiOrder: number | null
    /** دلیل کوتاه AI — فقط informational (هیچ نقشی در ترتیب/تخصیص ندارد) */
    reason: string | null
    priority: PlanProposalPriority | null
    score: number | null
}

export type PlanProposalBasis = {
    dayKey: string
    planVersion: number
    rebalancedVersion: number | null
    availableMinutes: number
    taskCount: number
    state: "fresh"
}

export type PlanProposal = {
    basis: PlanProposalBasis
    planned: PlanProposalPlannedItem[]
    unfitted: PlanProposalUnfittedItem[]
    plannedMinutes: number
    remainingMinutes: number
    aiUnscheduledTaskIds: number[]
    source: "1xai" | "mock"
    summary?: string
}

// ---------- Request bodies ----------

/** Generate فقط روز را می‌فرستد؛ task/capacity/planVersion هرگز از کلاینت نمی‌آید. */
export function buildGenerateBody(dayKey: string): { dayKey: string } {
    return { dayKey }
}

/**
 * Apply دقیقاً همان proposal دریافت‌شده از Generate را round-trip می‌کند (بدون بازسازی/تغییر)
 * به‌همراه dayKey و expectedPlanVersion = basis.planVersion.
 */
export function buildApplyBody(
    dayKey: string,
    proposal: PlanProposal,
): { dayKey: string; expectedPlanVersion: number; proposal: PlanProposal } {
    return { dayKey, expectedPlanVersion: proposal.basis.planVersion, proposal }
}

// ---------- Runtime shape guard ----------

/** گارد سبک: پاسخ نامعتبر هرگز به‌عنوان proposal معتبر نمایش داده نمی‌شود. */
export function isPlanProposal(value: unknown): value is PlanProposal {
    if (typeof value !== "object" || value === null) return false
    const v = value as Record<string, unknown>
    const basis = v.basis as Record<string, unknown> | undefined
    return (
        typeof basis === "object" &&
        basis !== null &&
        typeof (basis as Record<string, unknown>).dayKey === "string" &&
        typeof (basis as Record<string, unknown>).planVersion === "number" &&
        Array.isArray(v.planned) &&
        Array.isArray(v.unfitted) &&
        typeof v.plannedMinutes === "number" &&
        typeof v.remainingMinutes === "number"
    )
}

// ---------- Default transport (endpointهای موجود backend) ----------

export async function fetchPlanProposal(dayKey: string, signal?: AbortSignal): Promise<PlanProposal> {
    const data = await api<unknown>("/api/planner/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildGenerateBody(dayKey)),
        ...(signal ? { signal } : {}),
    })
    if (!isPlanProposal(data)) throw new Error("پاسخ سرور نامعتبر است")
    return data
}

export async function applyPlanProposal(dayKey: string, proposal: PlanProposal): Promise<void> {
    await api("/api/planner/plan/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildApplyBody(dayKey, proposal)),
    })
}

// ---------- Error mapping ----------

/** نگاشت کدهای دامنهٔ backend به پیام فارسی. هیچ provider payload/stack نمایش داده نمی‌شود. */
export function planProposalErrorMessage(error: unknown): string {
    if (error instanceof ApiClientError) {
        switch (error.code) {
            case "DAY_PLAN_NOT_SET":
                return "برای این روز ظرفیتی ثبت نشده؛ اول ظرفیت روز را مشخص کن."
            case "NO_PLANNABLE_TASKS":
                return "کاری برای برنامه‌ریزی در این روز وجود ندارد."
            case "QUOTA_EXCEEDED":
                return "سهمیهٔ ماهانهٔ هوش مصنوعی تمام شده است."
            case "AI_PROVIDER_UNAVAILABLE":
                return "سرویس هوش مصنوعی در دسترس نیست؛ کمی بعد دوباره تلاش کن."
            case "AI_PLAN_INVALID":
                return "پیشنهاد هوش مصنوعی قابل استفاده نبود؛ دوباره تلاش کن."
            case "RATE_LIMITED":
                return "تعداد درخواست‌ها زیاد شده؛ کمی بعد دوباره تلاش کن."
            case "PLAN_STALE":
                return "این پیشنهاد دیگر به‌روز نیست. لطفاً دوباره برنامه را ایجاد کنید."
            default:
                return error.message || "خطای نامشخص"
        }
    }
    return error instanceof Error ? error.message : "خطای نامشخص"
}

// ---------- State + orchestrator ----------

/**
 * پیام «پیشنهاد بی‌اعتبار شد» — **فقط** برای invalidation سمت کلاینت.
 *
 * تفکیک مهم (نباید با 409 PLAN_STALE یکی شود):
 * - invalidation سمت کلاینت: یک mutation داخلی (تغییر روز، افزودن/حذف/تغییر کار، تغییر
 *   ظرفیت) پیشنهادِ باز را دور می‌ریزد. هیچ درخواستی به backend نمی‌رود و هیچ 409‌ای
 *   وجود ندارد؛ این پیام به کاربر می‌گوید چرا مودال بسته شد و چه کند.
 * - رد 409 PLAN_STALE از بک‌اند: کاربر روی پیشنهادِ قدیمی Apply زده و backend آن را رد
 *   کرده. مسیر `apply()` این حالت را جدا (outcome.status === "stale") و با پیام خودش
 *   گزارش می‌کند و رفتارش دست‌نخورده می‌ماند.
 */
export const PLAN_PROPOSAL_STALE_MESSAGE =
    "این پیشنهاد برنامه به‌دلیل تغییر در لیست کارها یا ظرفیت روز دیگر معتبر نیست. لطفاً دوباره «ایجاد برنامه» را اجرا کن."

export type PlanProposalFlowState = {
    proposal: PlanProposal | null
    isGenerating: boolean
    isApplying: boolean
    error: string | null
    /**
     * پیشنهادِ باز به‌دلیل یک mutation داخلی بی‌اعتبار شد (نه به‌دلیل رد بک‌اند).
     * فقط وقتی true می‌شود که واقعاً پیشنهادی باز بوده باشد؛ تعویض روز/رویداد بدون
     * پیشنهادِ باز هیچ پیامی تولید نمی‌کند.
     */
    isStale: boolean
}

export const initialPlanProposalState: PlanProposalFlowState = {
    proposal: null,
    isGenerating: false,
    isApplying: false,
    error: null,
    isStale: false,
}

export type ApplyPlanOutcome = {
    status: "applied" | "stale" | "error" | "noop"
    message?: string
}

export type GeneratePlanOutcome = {
    proposal: PlanProposal | null
    /** پیام خطای نگاشت‌شده — فقط وقتی proposal null است */
    message?: string
}

export type PlanProposalFlowDeps = {
    fetchProposal: (dayKey: string) => Promise<PlanProposal>
    applyProposal: (dayKey: string, proposal: PlanProposal) => Promise<void>
}

export type PlanProposalFlow = {
    getState: () => PlanProposalFlowState
    subscribe: (listener: (state: PlanProposalFlowState) => void) => () => void
    generate: (dayKey: string) => Promise<GeneratePlanOutcome>
    /** Apply همیشه به روزِ اصلیِ خودِ proposal (basis.dayKey) می‌رود — نه روزِ در حال نمایش. */
    apply: () => Promise<ApplyPlanOutcome>
    /** Reject/Close کاربر: discard محلی و بی‌صدا. هیچ mutation ای نمی‌زند. */
    clear: () => void
    /**
     * Invalidation داخلی (تغییر روز/کار/ظرفیت): مثل clear پروپوزال را دور می‌ریزد و
     * پاسخ‌های در پرواز را بی‌اعتبار می‌کند، اما به‌جای حذف بی‌صدا وضعیت stale را
     * روشن می‌کند تا UI بتواند به کاربر بگوید چرا و CTA «ایجاد برنامه جدید» بدهد.
     */
    invalidate: () => void
}

/**
 * createPlanProposalOrchestrator — store خالص (بدون React) برای Generate/Apply.
 * deps قابل تزریق است تا تست بدون شبکه اجرا شود؛ در پروداکشن همان endpointهای موجود backend.
 */
export function createPlanProposalOrchestrator(deps?: Partial<PlanProposalFlowDeps>): PlanProposalFlow {
    const resolved: PlanProposalFlowDeps = {
        fetchProposal: deps?.fetchProposal ?? ((dayKey) => fetchPlanProposal(dayKey)),
        applyProposal: deps?.applyProposal ?? applyPlanProposal,
    }

    let state: PlanProposalFlowState = initialPlanProposalState
    let seq = 0
    const listeners = new Set<(state: PlanProposalFlowState) => void>()

    const setState = (next: PlanProposalFlowState) => {
        state = next
        for (const listener of listeners) listener(state)
    }

    return {
        getState: () => state,

        subscribe(listener) {
            listeners.add(listener)
            return () => {
                listeners.delete(listener)
            }
        },

        async generate(dayKey) {
            // هر Generate جدید، seq را جلو می‌برد → پاسخ درخواست‌های قدیمی‌تر دور ریخته می‌شود
            const token = ++seq
            setState({
                proposal: null,
                isGenerating: true,
                isApplying: false,
                error: null,
                // Generate جدید جایگزین پیام stale می‌شود (کاربر دقیقاً همان کاری را که
                // stale notice از او خواسته بود انجام داده است)
                isStale: false,
            })
            try {
                const proposal = await resolved.fetchProposal(dayKey)
                if (token !== seq) return { proposal: null } // پاسخ کهنه — state دست نمی‌خورد
                setState({
                    proposal,
                    isGenerating: false,
                    isApplying: false,
                    error: null,
                    isStale: false,
                })
                return { proposal }
            } catch (error) {
                if (token !== seq) return { proposal: null }
                const message = planProposalErrorMessage(error)
                setState({
                    proposal: null,
                    isGenerating: false,
                    isApplying: false,
                    error: message,
                    isStale: false,
                })
                return { proposal: null, message }
            }
        },

        async apply() {
            const proposal = state.proposal
            if (!proposal) return { status: "noop" }
            if (state.isApplying) return { status: "noop" } // ضد Apply دوباره روی یک proposal

            setState({ ...state, isApplying: true, error: null })
            try {
                // Phase 4.4 (Step 12) — هدفِ Apply روزِ خودِ proposal است، نه روزی که UI الان
                // نمایش می‌دهد. بنابراین تعویض روز هرگز نمی‌تواند proposal را به روز دیگری
                // اعمال کند؛ proposal بدون هیچ بازسازی/تغییری به backend فرستاده می‌شود.
                await resolved.applyProposal(proposal.basis.dayKey, proposal)
                setState({
                    proposal: null,
                    isGenerating: false,
                    isApplying: false,
                    error: null,
                    isStale: false,
                })
                return { status: "applied" }
            } catch (error) {
                if (error instanceof ApiClientError && error.code === "PLAN_STALE") {
                    // proposal کهنه هرگز force-apply نمی‌شود → discard.
                    // این مسیر «رد بک‌اند» است، نه invalidation سمت کلاینت: پیام خطای
                    // مخصوص خودش را می‌گیرد و isStale عمداً false می‌ماند.
                    const message = planProposalErrorMessage(error)
                    setState({
                        proposal: null,
                        isGenerating: false,
                        isApplying: false,
                        error: message,
                        isStale: false,
                    })
                    return { status: "stale", message }
                }
                const message = planProposalErrorMessage(error)
                // خطای عمومی: proposal حفظ می‌شود تا کاربر بتواند دوباره تأیید کند
                setState({ ...state, isApplying: false, error: message })
                return { status: "error", message }
            }
        },

        clear() {
            // درخواست‌های در پرواز بی‌اعتبار می‌شوند تا پاسخ کهنه modal را باز نکند
            seq += 1
            setState(initialPlanProposalState)
        },

        invalidate() {
            // مثل clear پاسخ‌های در پرواز را بی‌اعتبار می‌کند (Generate نیمه‌کاره برای
            // روزی که دیگر انتخاب نشده نباید مودال را باز کند).
            seq += 1
            // فقط وقتی واقعاً پیشنهادی باز بوده پیام stale داده می‌شود؛ وگرنه هر تعویض روز
            // یا هر mutation بی‌ربط، بنر «برنامه‌ات کهنه شد» الکی نشان می‌داد.
            const hadProposal = state.proposal !== null
            setState({ ...initialPlanProposalState, isStale: hadProposal })
        },
    }
}
