// Advisor Ordering — Phase 1 (Pure Logic)
// ------------------------------------------------------------
// مرتب‌سازیِ نمایشیِ لیست کارها بر اساس «پیشنهادِ امروز» (plannedTaskIds).
//
// قواعد (به همین ترتیب):
//   ۱) کارهای حاضر در plannedTaskIds اول می‌آیند — دقیقاً به ترتیب خودِ plannedTaskIds.
//   ۲) بقیه‌ی کارهای غیر-DONE بعد از آن‌ها می‌آیند و ترتیب نسبیِ اصلی‌شان حفظ می‌شود.
//   ۳) کارهای DONE همیشه آخر — حتی اگر داخل plannedTaskIds باشند.
//
// قراردادها:
// - کاملاً PURE: بدون I/O، بدون شبکه، بدون DB، بدون AI، بدون side-effect.
// - IMMUTABLE: نه آرایه‌ی ورودی mutate می‌شود و نه ترتیب اشیای Task عوض می‌شود؛
//   همیشه یک آرایه‌ی تازه برگردانده می‌شود.
// - idهای ناشناخته/تکراری در plannedTaskIds بی‌صدا نادیده گرفته می‌شوند.

import type { TaskItem } from "@/app/components/task/taskTypes"

/**
 * ترتیبِ نمایش کارها بر اساس پیشنهاد روز.
 *
 * @param tasks لیست کارهای روز (دست‌نخورده می‌ماند)
 * @param plannedTaskIds ترتیبِ پیشنهادیِ کارهای برنامه‌ریزی‌شده (منبع: suggestion / advisor)
 * @returns آرایه‌ی تازه‌ی مرتب‌شده — هرگز همان reference ورودی
 */
export function orderTasksByAdvisor(tasks: TaskItem[], plannedTaskIds: number[]): TaskItem[] {
    // ۱) تفکیک اولیه — دو آرایه‌ی تازه؛ ورودی دست‌نخورده می‌ماند
    const done = tasks.filter((t) => t.status === "DONE")
    const active = tasks.filter((t) => t.status !== "DONE")

    // ۲) برداشت به ترتیب plannedTaskIds — هر کار فقط یک‌بار (id تکراری مشکلی نمی‌سازد)
    const remaining = [...active]
    const planned: TaskItem[] = []
    for (const id of plannedTaskIds) {
        const index = remaining.findIndex((t) => t.id === id)
        if (index === -1) continue // id ناشناخته یا DONE یا تکراری → نادیده
        planned.push(remaining[index])
        remaining.splice(index, 1)
    }

    // ۳) planned (به ترتیب پیشنهاد) ← بقیه‌ی باز (ترتیب اصلی حفظ‌شده) ← DONE
    return [...planned, ...remaining, ...done]
}
