// Phase 1 (AI Daily Plan) — batch input/operation contracts + validation semantics
// --------------------------------------------------------------------------------
// این فایل فقط «قرارداد» است: ورودی AI، خروجی AI (از planSchema)، و حجم عملیات.
// هیچ provider call، هیچ HTTP، هیچ persist و هیچ scheduler دومی اینجا نیست.
//
// ── تصمیم ترتیب (Ordering Architecture) — Option A ──────────────────────────────
// تحلیل دو گزینه طبق موتور فعلی (suggestDay / weightOf / distribute):
//
//   Option A — AI فقط وزن‌های موتور را تغذیه می‌کند (estimatedMinutes + score).
//              تخصیص و ترتیب نهایی با همان scheduler قطعی موجود تعیین می‌شود.
//   Option B — order صریح AI به یک tiebreaker قطعی در موتور تبدیل شود.
//
// انتخاب: Option A.
// دلیل: معماری LOCKED می‌گوید AI مشاور است نه authority (architecture.md §3.5 / ADR-05) و
// Rebalance Engine باید تنها scheduler باشد (§2 / ADR-03). موتور فعلی از قبل با
// weight = estimate × (0.5 + score/200) تخصیص می‌دهد؛ پس کافی است estimate/score از AI
// بیاید و order به‌صورت advisory باقی بماند. نتیجه: صفر scheduler جدید، صفر تغییر در
// suggestDay/distribute، رفتار قطعی دست‌نخورده و حداقل سطح تغییر.
//
// پیامد: order که AI می‌دهد در proposal به شکل aiOrder حمل می‌شود، اما order نهایی و
// ترتیب planned صرفاً از موتور قطعی می‌آید. برای ثبت رسمی این تصمیم در فاز ۲ باید ADR-008
// با این مضمون نوشته شود: «AI advisory ordering؛ suggestDay تنها scheduler است».
// (خود این فاز تغییر معماری ندارد؛ ADR فقط برای ثبت رسمی تصمیم در زمان integration لازم است.)

import type { AiSource } from "./analyzeTask"
import type { AiBatchPlan, PlanPriority } from "./planSchema"

/** منبع خروجی AI — همان قرارداد موجود analyzeTask (1xai واقعی / mock توسعه) */
export type BatchPlanSource = AiSource

/**
 * یک تسک در ورودی AI — بازنمایی canonical سبک از Task دامنه.
 * فیلدهای موجودِ AI فعلی (estimatedTime/score/priority) به شكل existing* پاس داده می‌شوند
 * تا AI بتواند تحلیل قبلی را ببیند و از نو تخمین بزند.
 */
export type PlanTaskInput = {
    taskId: number
    title: string
    category?: string | null
    existingEstimatedMinutes?: number | null
    existingScore?: number | null
    existingPriority?: PlanPriority | null
}

/**
 * ورودی عملیات batch — «مجموعهٔ کامل تسک‌های روز» (نه فقط تسک‌های تازه).
 * این قرارداد عمداً تنها دادهٔ لازم برای تحلیل را دارد؛ وضعیت/تخصیص موتور داخل آن نیست.
 */
export type PlanInput = {
    dayKey: string
    availableMinutes: number
    tasks: PlanTaskInput[]
}

/** نتیجهٔ عملیات batch — آینهٔ AiResult فعلی برای سازگاری semantics */
export type PlanAnalysisResult = {
    source: BatchPlanSource
    plan: AiBatchPlan
    raw?: string
    attempts: number
}

/**
 * قرارداد تابع آیندهٔ analyzeBatchPlan(input) — پیاده‌سازی provider آن در فاز ۲ است.
 * (هیچ provider abstraction دومی ساخته نمی‌شود؛ این تابع از همان زیرساخت analyzeTask
 *  و aiQuota/planPolicy استفاده خواهد کرد.)
 */
export type AnalyzeBatchPlan = (input: PlanInput) => Promise<PlanAnalysisResult>

// ── Validation semantics ────────────────────────────────────────────────────────

export type PlanValidationCode = "UNKNOWN_TASK_ID" | "MISSING_TASK_ID"

export type PlanValidationIssue = {
    code: PlanValidationCode
    taskId: number
}

/**
 * validateBatchPlan — بررسی‌های نسبی به ورودی که schema نمی‌تواند انجام دهد:
 * - هر taskId برگشتی (در items یا unscheduledTaskIds) باید در ورودی موجود باشد.
 * - هر تسک ورودی باید دقیقاً در یکی از دو لیست بیاید (completeness).
 *
 * چک‌های ساختاریِ درون‌خروجی (تکرار taskId/order، هم‌پوشانی) در خود schema
 * (aiBatchPlanSchema) اعمال می‌شوند و اینجا تکرار نمی‌شوند.
 *
 * آرایهٔ خالی = معتبر.
 */
export function validateBatchPlan(
    output: AiBatchPlan,
    inputTaskIds: number[],
): PlanValidationIssue[] {
    const known = new Set(inputTaskIds)
    const seen = new Set<number>()
    const issues: PlanValidationIssue[] = []

    for (const item of output.items) {
        if (!known.has(item.taskId)) {
            issues.push({ code: "UNKNOWN_TASK_ID", taskId: item.taskId })
        }
        seen.add(item.taskId)
    }

    for (const id of output.unscheduledTaskIds ?? []) {
        if (!known.has(id)) {
            issues.push({ code: "UNKNOWN_TASK_ID", taskId: id })
        }
        seen.add(id)
    }

    for (const id of inputTaskIds) {
        if (!seen.has(id)) {
            issues.push({ code: "MISSING_TASK_ID", taskId: id })
        }
    }

    return issues
}
