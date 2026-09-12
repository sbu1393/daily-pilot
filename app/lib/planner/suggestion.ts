// ADR-006 — Daily Schedule Suggestion Engine (Advisor Layer) — Phase S1
// ---------------------------------------------------------------------
// پیشنهادِ «چه کارهایی در ظرفیت امروز جا می‌شوند» — PURE و Deterministic.
//
// قراردادهای ADR-006:
// - بدون LLM: ریاضیاتِ همان Weighted Proportional Allocation در rebalance.ts.
// - بدون persist: خروجی فقط پیشنهاد است؛ هیچ Task/DailyPlan تغییر نمی‌کند.
// - بدون تصمیم خودکار: انتقال کارها فقط با تأیید صریح کاربر (rollover موجود).
//
// سازگاری با موتور واقعی: از همان estimateOf/weightOf/distribute استفاده می‌کنیم
// تا پیشنهاد هرگز با نتیجه‌ی Rebalance که کاربر واقعاً می‌بیند تناقض نداشته باشد.
// برخلاف rebalanceDay (که allocate می‌کند)، این تابع هیچ I/O و هیچ side-effect ندارد.

import { distribute, estimateOf, weightOf } from "./rebalance"

/** ورودی خنثی از Prisma — فقط فیلدهایی که موتور به آن‌ها نیاز دارد */
export type SuggestionTaskInput = {
    id: number
    estimatedTime: number | null
    score: number | null
    priority: "HIGH" | "MEDIUM" | "LOW" | null
    status: "TODO" | "IN_PROGRESS" | "DONE"
    allocatedMinutes: number | null
}

export type SuggestedItem = {
    taskId: number
    estimatedMinutes: number // تخمین امن (همان estimateOf) — برای نمایش «برنامه‌ی امروز»
    suggestedMinutes: number // سهم پیشنهادی (مضرب ۵)
    partial: boolean // true = کل تخمین جا نشد و سهم کمتر از تخمین است
    weight: number
}

export type UnfittedItem = {
    taskId: number
    estimatedMinutes: number
    weight: number
}

export type DaySuggestion = {
    /** تسک‌های IN_PROGRESS که به‌خاطر تخصیص فعلی کاهش نمی‌یابند (آینه‌ی rebalanceDay) */
    protectedTaskIds: number[]
    capacityMinutes: number // ظرفیت قابل توزیع (ورودی caller)
    planned: SuggestedItem[]
    unfitted: UnfittedItem[]
    plannedMinutes: number // جمع سهم‌های پیشنهادی
    remainingMinutes: number // بودجه‌ی مصرف‌نشده (استخر آزاد)
    usedDefaultEstimate: number[] // کارهایی که estimateOf روی DEFAULT_ESTIMATE (۳۰) اعمال کرد
}

/**
 * پیشنهاد روز — Pure function (بدون I/O، بدون persist، بدون AI).
 *
 * منطق (دقیقاً همان موتور توزیع Rebalance):
 * - وزن هر کار = estimate × (0.5 + score/200) — score خالی = ۵۰.
 * - اگر مجموع تخمین‌ها ≤ ظرفیت → هر کار کل تخمینش را می‌گیرد؛ مازاد استخر می‌شود.
 * - اگر کمبود بودجه است → توزیع تناسبیِ وزندار با سقف تخمین؛
 *   سهم‌های زیر ۱۵ دقیقه کنار گذاشته می‌شوند (کم‌وزن‌ترین اول) → «جا نشدند».
 * - خروجی به مضرب ۵ گرد می‌شود (همان GRANULARITY موتور).
 */
export function suggestDay(
    capacityMinutes: number,
    tasks: SuggestionTaskInput[],
): DaySuggestion {
    const open = tasks.filter((t) => t.status !== "DONE")

    const budget = Math.max(0, Math.floor(capacityMinutes))
    const usedDefaultEstimate: number[] = []

    // تخمین پیش‌فرض روی همه‌ی تسک‌های باز (محافظت‌شده و نامحافظت‌شده) گزارش می‌شود
    for (const t of open) {
        if (t.estimatedTime == null) usedDefaultEstimate.push(t.id)
    }

    // آینه‌ی rebalanceDay: تسکِ IN_PROGRESS با تخصیص فعلی محافظت می‌شود —
    // سهمش کاهش نمی‌یابد و همان مقدار از بودجه‌ی قابل‌توزیع کم می‌شود.
    const protectedSet = new Set(
        open
            .filter((t) => t.status === "IN_PROGRESS" && t.allocatedMinutes != null)
            .map((t) => t.id),
    )
    const protectedTaskIds = open.filter((t) => protectedSet.has(t.id)).map((t) => t.id)
    const protectedSum = open.reduce(
        (s, t) => s + (protectedSet.has(t.id) ? (t.allocatedMinutes ?? 0) : 0),
        0,
    )

    const items = open
        .filter((t) => !protectedSet.has(t.id))
        .map((t) => ({ id: t.id, weight: weightOf(t), cap: estimateOf(t) }))

    const { allocations, dropped, pool } = distribute(Math.max(0, budget - protectedSum), items)

    const planned: SuggestedItem[] = []
    const unfitted: UnfittedItem[] = []

    // محافظت‌شده‌ها همیشه در «برنامه‌ی امروز» می‌مانند، با همان تخصیص فعلی
    for (const t of open) {
        if (!protectedSet.has(t.id)) continue
        const cap = estimateOf(t)
        const share = t.allocatedMinutes ?? 0
        planned.push({
            taskId: t.id,
            estimatedMinutes: cap,
            suggestedMinutes: share,
            partial: share < cap,
            weight: weightOf(t),
        })
    }

    for (const item of items) {
        const share = allocations[item.id] ?? 0
        if (share > 0) {
            planned.push({
                taskId: item.id,
                estimatedMinutes: item.cap,
                suggestedMinutes: share,
                partial: share < item.cap,
                weight: item.weight,
            })
        } else if (dropped.includes(item.id)) {
            unfitted.push({
                taskId: item.id,
                estimatedMinutes: item.cap,
                weight: item.weight,
            })
        }
        // share === 0 و در dropped نیست → فقط در بودجه‌ی صفر رخ می‌دهد؛ همان unfitted حساب می‌شود
        else {
            unfitted.push({
                taskId: item.id,
                estimatedMinutes: item.cap,
                weight: item.weight,
            })
        }
    }

    // ترتیب پایدار و قابل توضیح: وزن نزولی، سپس id صعودی (deterministic)
    planned.sort((a, b) => b.weight - a.weight || a.taskId - b.taskId)
    unfitted.sort((a, b) => a.weight - b.weight || a.taskId - b.taskId)

    const plannedMinutes = planned.reduce((s, p) => s + p.suggestedMinutes, 0)

    return {
        capacityMinutes: budget,
        planned,
        unfitted,
        plannedMinutes,
        remainingMinutes: pool,
        protectedTaskIds,
        usedDefaultEstimate,
    }
}
