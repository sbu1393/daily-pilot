// Phase 4.3 — PlanProposal view model (PURE)
// ---------------------------------------------------------------------------
// proposal خام backend + لیست فعلی تسک‌های UI → نمای آماده برای رندر.
// - کاملاً PURE: بدون I/O، بدون fetch، بدون محاسبهٔ مجدد ظرفیت/تخصیص.
// - مقادیر خلاصهٔ ظرفیت مستقیماً از proposal گرفته می‌شوند (باز‌محاسبه نمی‌شوند).
// - عنوان‌ها با لیست فعلی تسک‌ها resolve می‌شوند (بدون fetch per-task)؛ ارجاع گم‌شده
//   fallback امن می‌گیرد و proposal هرگز تغییر نمی‌کند.
// - `order` = rank قطعی موتور (authority)؛ `aiOrder` فقط advisory است و هرگز به‌عنوان
//   time-slot/ساعت واقعی تفسیر نمی‌شود (مدل فعلی time-slot ندارد).

import { faDigits } from "@/app/lib/time"

import type { TaskItem } from "./taskTypes"
import type {
    PlanProposal,
    PlanProposalPriority,
    PlanProposalUnfittedItem,
} from "@/app/lib/planner/planProposalFlow"

export type PlanProposalViewRow = {
    taskId: number
    /** عنوان resolve‌شده از لیست فعلی تسک‌ها؛ در نبود تسک، fallback امن. */
    title: string
    /** false = تسک در لیست فعلی UI پیدا نشد (fallback نمایش داده شده) */
    titleResolved: boolean
    estimatedMinutes: number
    priority: PlanProposalPriority | null
    score: number | null
    weight: number
    /**
     * دلیل کوتاه AI برای این تسک — فقط متن نمایشی.
     * null/absent یعنی AI دلیلی نداده و UI باید بی‌سروصدا آن را نپوشاند.
     */
    reason: string | null
    /** ترتیب نمایش برای planned (rank قطعی موتور)؛ برای unfitted null */
    order: number | null
    /** فقط advisory — نه time-slot */
    aiOrder: number | null
    /** planned فقط */
    suggestedMinutes: number | null
    /** planned فقط */
    partial: boolean
}

export type PlanProposalViewSummary = {
    availableMinutes: number
    plannedMinutes: number
    remainingMinutes: number
    plannedCount: number
    unfittedCount: number
    taskCount: number
}

export type PlanProposalView = {
    summary: PlanProposalViewSummary
    planned: PlanProposalViewRow[]
    unfitted: PlanProposalViewRow[]
    /** شناسه‌های ارجاع‌شده که در لیست فعلی UI نبودند (فقط برای شفافیت؛ proposal تغییر نمی‌کند) */
    missingTaskIds: number[]
    source: string
    summaryText?: string
}

/** عنوان امن در نبود تسک — بدون crash و بدون تغییر proposal */
function fallbackTitle(taskId: number): string {
    return `کار ${faDigits(taskId)}`
}

/**
 * نرمال‌سازی دلیل AI برای نمایش.
 * رشته‌ی خالی/فقط‌فاصله یا غیررشته‌ای → null (UI اصلاً بلوک «دلیل» را رندر نمی‌کند).
 * در غیر این صورت شکل نمایش تغییر نمی‌کند — فقط متن trim می‌شود.
 */
function normalizeReason(value: unknown): string | null {
    if (typeof value !== "string") return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}

function resolveTitle(
    taskId: number,
    byId: Map<number, TaskItem>,
): { title: string; resolved: boolean } {
    const task = byId.get(taskId)
    if (task) return { title: task.title, resolved: true }
    return { title: fallbackTitle(taskId), resolved: false }
}

export function buildPlanProposalView(
    proposal: PlanProposal,
    tasks: TaskItem[],
): PlanProposalView {
    const byId = new Map(tasks.map((task) => [task.id, task]))
    const missingTaskIds: number[] = []

    const planned: PlanProposalViewRow[] = proposal.planned.map((item) => {
        const { title, resolved } = resolveTitle(item.taskId, byId)
        if (!resolved) missingTaskIds.push(item.taskId)
        return {
            taskId: item.taskId,
            title,
            titleResolved: resolved,
            estimatedMinutes: item.estimatedMinutes,
            priority: item.priority,
            score: item.score,
            weight: item.weight,
            reason: normalizeReason(item.reason),
            order: item.order,
            aiOrder: item.aiOrder,
            suggestedMinutes: item.suggestedMinutes,
            partial: item.partial,
        }
    })

    const unfitted: PlanProposalViewRow[] = proposal.unfitted.map((item: PlanProposalUnfittedItem) => {
        const { title, resolved } = resolveTitle(item.taskId, byId)
        if (!resolved) missingTaskIds.push(item.taskId)
        return {
            taskId: item.taskId,
            title,
            titleResolved: resolved,
            estimatedMinutes: item.estimatedMinutes,
            priority: item.priority,
            score: item.score,
            weight: item.weight,
            reason: normalizeReason(item.reason),
            order: null,
            aiOrder: item.aiOrder,
            suggestedMinutes: null,
            partial: false,
        }
    })

    return {
        summary: {
            // مستقیماً از proposal — هرگز دوباره محاسبه نمی‌شود
            availableMinutes: proposal.basis.availableMinutes,
            plannedMinutes: proposal.plannedMinutes,
            remainingMinutes: proposal.remainingMinutes,
            plannedCount: planned.length,
            unfittedCount: unfitted.length,
            taskCount: proposal.basis.taskCount,
        },
        planned,
        unfitted,
        missingTaskIds,
        source: proposal.source,
        summaryText: proposal.summary,
    }
}

// ---------- نمایش فراداده ----------

const PRIORITY_LABEL: Record<PlanProposalPriority, string> = {
    HIGH: "بالا",
    MEDIUM: "متوسط",
    LOW: "کم",
}

/** برچسب فارسی اولویت؛ null → «بدون اولویت» */
export function priorityLabel(priority: PlanProposalPriority | null): string {
    return priority ? PRIORITY_LABEL[priority] : "بدون اولویت"
}
