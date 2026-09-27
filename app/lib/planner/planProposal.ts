// Phase 1 (AI Daily Plan) — pure proposal builder
// -----------------------------------------------
// AI batch خروجی را به ورودیِ همان scheduler قطعی موجود (suggestDay) می‌دهد و یک
// «پیشنهاد روز» ephemeral می‌سازد. هیچ persist، هیچ HTTP، هیچ scheduler دوم.
//
// ── Ordering decision: Option A (مستند کامل در planContract.ts) ──────────────────
// AI فقط estimatedMinutes + score را تغذیه می‌کند؛ تخصیص و ترتیب نهایی از
// suggestDay / distribute (تنها scheduler سیستم) می‌آید. order برگشتیِ AI صرفاً
// advisory است و در proposal به‌عنوان aiOrder حمل می‌شود؛ order نهایی همیشه rank
// قطعیِ موتور است. (architecture.md §3.5 / ADR-03 / ADR-05.)
//
// قراردادها:
// - کاملاً PURE: بدون I/O، بدون Prisma، بدون AI، بدون side-effect.
// - ورودی‌ها mutate نمی‌شوند (map/کپی؛ suggestDay خودش هم ورودی را دست نمی‌زند).
// - تسکِ بدون آیتم AI (مثلاً در unscheduledTaskIds) با مقادیر موجود خودش وارد موتور
//   می‌شود و تصمیم نهایی ظرفیت باز هم با planner قطعی است.
// - basis.state همیشه "fresh" است؛ فراخوان (route فاز ۲) مسئول این است که روز را
//   ابتدا rebalance/ensure کند (همان الگوی getDaySuggestion).

import type { BatchPlanSource } from "@/app/lib/ai/planContract"
import type { AiBatchPlan, AiPlanItem, PlanPriority } from "@/app/lib/ai/planSchema"

import { suggestDay, type SuggestionTaskInput } from "./suggestion"

/** مبنای محاسبهٔ پیشنهاد — نسخهٔ پلن + ظرفیت + تعداد کارهای ورودی */
export type PlanProposalBasis = {
    dayKey: string
    planVersion: number
    /** آخرین نسخه‌ای که rebalance روی آن اجرا شده (null = هرگز) — Phase 2 (§12) */
    rebalancedVersion: number | null
    availableMinutes: number
    taskCount: number
    state: "fresh"
}

export type PlanProposalPlannedItem = {
    taskId: number
    estimatedMinutes: number
    suggestedMinutes: number
    /** rank قطعیِ موتور (۱-محور) — authority */
    order: number
    /** ترتیب پیشنهادی AI — فقط advisory؛ null اگر AI آیتمی نداده باشد */
    aiOrder: number | null
    /**
     * دلیل کوتاه AI برای پیشنهادش — **فقط informational**.
     * هرگز ورودی موتور/Scheduler نیست: suggestDay آن را نمی‌خواند و در وزن/تخصیص/ترتیب
     * دخالتی ندارد. صرفاً برای شفافیت کاربر در مودال پیشنهاد حمل می‌شود؛ null اگر AI
     * دلیلی نداده باشد (UI باید graceful رفتار کند).
     */
    reason: string | null
    priority: PlanPriority | null
    score: number | null
    weight: number
    partial: boolean
}

export type PlanProposalUnfittedItem = {
    taskId: number
    estimatedMinutes: number
    weight: number
    aiOrder: number | null
    /** دلیل کوتاه AI — فقط informational؛ همان semantics آیتم‌های planned */
    reason: string | null
    /**
     * اولویت/امتیاز AI — همان semantics آیتم‌های planned.
     * Phase 4.2: بدون این دو فیلد، Apply نمی‌توانست metadata تسک‌های unfitted را persist کند
     * و rebalance پس از Apply با Proposalِ نمایش‌داده‌شده یکی نمی‌شد (gap قرارداد فاز ۱).
     */
    priority: PlanPriority | null
    score: number | null
}

export type PlanProposal = {
    basis: PlanProposalBasis
    planned: PlanProposalPlannedItem[]
    unfitted: PlanProposalUnfittedItem[]
    plannedMinutes: number
    remainingMinutes: number
    /** شناسه‌هایی که AI خودش «جا نمی‌شود» علامت زده — advisory، نه authority */
    aiUnscheduledTaskIds: number[]
    source: BatchPlanSource
    summary?: string
}

export type PlanProposalArgs = {
    dayKey: string
    planVersion: number
    /** آخرین نسخهٔ rebalance شده — برای traceability در Phase 3/4 (§12) */
    rebalancedVersion: number | null
    availableMinutes: number
    source: BatchPlanSource
    ai: AiBatchPlan
    /** تسک‌های روز با همان شکل canonical موتور (سuggestion) */
    tasks: SuggestionTaskInput[]
}

export function buildPlanProposal(args: PlanProposalArgs): PlanProposal {
    const { dayKey, planVersion, rebalancedVersion, availableMinutes, source, ai, tasks } = args

    // ۱) آیتم‌های AI را نگاشت کن — idهای ناشناخته بی‌صدا نادیده می‌روند
    //    (اعتبارسنجی نسبی در validateBatchPlan انجام می‌شود؛ اینجا فقط builder است).
    const itemByTaskId = new Map<number, AiPlanItem>()
    for (const item of ai.items) {
        if (!itemByTaskId.has(item.taskId)) itemByTaskId.set(item.taskId, item)
    }

    // ۲) ورودی موتور قطعی: estimate/score/priority تسک‌های دارای آیتم AI با تحلیل AI
    //    جایگزین می‌شود؛ بقیه (ازجمله unscheduled) با مقادیر موجود خودشان می‌مانند.
    const engineTasks: SuggestionTaskInput[] = tasks.map((task) => {
        const item = itemByTaskId.get(task.id)
        if (!item) return task
        return {
            ...task,
            estimatedTime: item.estimatedMinutes,
            score: item.score,
            priority: item.priority,
        }
    })

    // ۳) تنها scheduler سیستم — قطعی و بدون تغییر
    const suggestion = suggestDay(availableMinutes, engineTasks)

    const engineTaskById = new Map(engineTasks.map((task) => [task.id, task]))

    const planned: PlanProposalPlannedItem[] = suggestion.planned.map((item, index) => {
        const aiItem = itemByTaskId.get(item.taskId)
        const engineTask = engineTaskById.get(item.taskId)
        return {
            taskId: item.taskId,
            estimatedMinutes: item.estimatedMinutes,
            suggestedMinutes: item.suggestedMinutes,
            order: index + 1, // rank قطعی موتور — نه order AI
            aiOrder: aiItem?.order ?? null,
            // فقط نمایشی — در هیچ تصمیم موتوری دخالت ندارد
            reason: aiItem?.reason ?? null,
            priority: aiItem?.priority ?? engineTask?.priority ?? null,
            score: aiItem?.score ?? engineTask?.score ?? null,
            weight: item.weight,
            partial: item.partial,
        }
    })

    const unfitted: PlanProposalUnfittedItem[] = suggestion.unfitted.map((item) => {
        const aiItem = itemByTaskId.get(item.taskId)
        const engineTask = engineTaskById.get(item.taskId)
        return {
            taskId: item.taskId,
            estimatedMinutes: item.estimatedMinutes,
            weight: item.weight,
            aiOrder: aiItem?.order ?? null,
            // فقط نمایشی — در هیچ تصمیم موتوری دخالت ندارد
            reason: aiItem?.reason ?? null,
            // metadata از خود AI item (همان منبع آیتم‌های planned) — نه صرفاً کامل‌تر کردن JSON
            priority: aiItem?.priority ?? engineTask?.priority ?? null,
            score: aiItem?.score ?? engineTask?.score ?? null,
        }
    })

    const proposal: PlanProposal = {
        basis: {
            dayKey,
            planVersion,
            rebalancedVersion,
            availableMinutes,
            taskCount: tasks.length,
            state: "fresh",
        },
        planned,
        unfitted,
        plannedMinutes: suggestion.plannedMinutes,
        remainingMinutes: suggestion.remainingMinutes,
        aiUnscheduledTaskIds: ai.unscheduledTaskIds ?? [],
        source,
    }

    if (ai.summary !== undefined) proposal.summary = ai.summary

    return proposal
}
