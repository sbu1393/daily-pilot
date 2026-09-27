// Phase 1 (AI Daily Plan) — deterministic non-production mock
// -----------------------------------------------------------
// قرارداد mock (سند فاز ۱: mock فقط برای تستِ قابل‌پیش‌بینی است، نه یک AI تقلبیِ پیچیده):
// - همهٔ تسک‌های ورودی را دقیقاً یک‌بار برمی‌گرداند (بدون unscheduled).
// - estimatedMinutes/score/priority معتبر از همان mockAnalyze موجود می‌آید (reuse).
// - order قطعی: امتیاز نزولی، سپس taskId صعودی.
// - ورودی یکسان → خروجی یکسان (deterministic).

import { mockAnalyze } from "./mock"
import type { PlanInput } from "./planContract"
import type { AiBatchPlan } from "./planSchema"

const clamp = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, Math.round(value)))

export function mockBatchPlan(input: PlanInput): AiBatchPlan {
    // تحلیل قطعی هر تسک با همان mock تک‌تسکی موجود (بدون منطق تکراری)
    const analyzed = input.tasks.map((task) => {
        const analysis = mockAnalyze(task.title)
        return {
            taskId: task.taskId,
            estimatedMinutes: clamp(analysis.estimatedMinutes, 5, 480),
            score: clamp(analysis.score, 0, 100),
            priority: analysis.priority,
        }
    })

    // order قطعی: امتیاز نزولی، سپس taskId صعودی
    const ordered = [...analyzed].sort((a, b) => b.score - a.score || a.taskId - b.taskId)
    const orderOf = new Map(ordered.map((item, index) => [item.taskId, index + 1]))

    const items = analyzed
        .map((item) => ({
            taskId: item.taskId,
            estimatedMinutes: item.estimatedMinutes,
            score: item.score,
            priority: item.priority,
            order: orderOf.get(item.taskId) as number,
        }))
        .sort((a, b) => a.order - b.order)

    return {
        items,
        summary: `پیشنهاد آزمایشی برای ${input.tasks.length} کار`,
    }
}
