// Phase 2 (AI Daily Plan) — plan generation context + mappers
// -----------------------------------------------------------
// مسئولیت: خواندنِ فقط-خواندنیِ روزِ کاربر و تبدیل مدل‌های فعلی پروژه به ورودی‌های فاز ۱.
// این سرویس هیچ AI، هیچ quota، هیچ HTTP و هیچ mutation ای انجام نمی‌دهد:
//   - نه rebalance می‌زند، نه DailyPlan را عوض می‌کند، نه Task را mutate می‌کند.
//   - مالکیت داده با userId تضمین می‌شود (client هرگز task ظرفیت/task را تحمیل نمی‌کند).
// quota/route در لایه route است؛ اینجا فقط داده و mapping.

import { getPrisma } from "@/app/lib/getPrisma"
import type { PlanInput, PlanTaskInput } from "@/app/lib/ai/planContract"
import type { SuggestionTaskInput } from "@/app/lib/planner/suggestion"

import { DayPlanNotSetError, NoPlannableTasksError } from "./errors"

type PlanPriority = "HIGH" | "MEDIUM" | "LOW"

/** شکل حداقلی Task که برای mapping لازم است (بدون وابستگی به کل رکورد Prisma). */
export type PlanGenerationTask = {
    id: number
    title: string
    category: string | null
    estimatedTime: number | null
    score: number | null
    priority: PlanPriority | null
    status: "TODO" | "IN_PROGRESS" | "DONE"
    allocatedMinutes: number | null
}

/** نگاشت Task دامنه → ورودی AI (فیلدهای موجود به شکل existing*). */
export function toPlanTaskInput(task: PlanGenerationTask): PlanTaskInput {
    return {
        taskId: task.id,
        title: task.title,
        category: task.category,
        existingEstimatedMinutes: task.estimatedTime,
        existingScore: task.score,
        existingPriority: task.priority,
    }
}

/** نگاشت Task دامنه → ورودی canonical موتور قطعی (همان شکل suggestDay). */
export function toSuggestionTaskInput(task: PlanGenerationTask): SuggestionTaskInput {
    return {
        id: task.id,
        estimatedTime: task.estimatedTime,
        score: task.score,
        priority: task.priority,
        status: task.status,
        allocatedMinutes: task.allocatedMinutes,
    }
}

/** ساخت PlanInput برای AI از مجموعهٔ کامل کارهای بازِ یک روز. */
export function buildPlanInput(
    dayKey: string,
    availableMinutes: number,
    tasks: PlanGenerationTask[],
): PlanInput {
    return {
        dayKey,
        availableMinutes,
        tasks: tasks.map(toPlanTaskInput),
    }
}

export type PlanGenerationContext = {
    planVersion: number
    rebalancedVersion: number | null
    availableMinutes: number
    /** ورودی AI — مجموعهٔ کامل کارهای بازِ روز */
    input: PlanInput
    /** ورودی scheduler قطعی — همان کارها با شکل canonical موتور */
    suggestionTasks: SuggestionTaskInput[]
}

/**
 * getPlanGenerationContext — خواندنِ فقط-خواندنیِ زمینهٔ تولید پلن.
 *
 * - مالکیت: plan و taskها فقط برای همان userId (client هیچ taskی تحمیل نمی‌کند).
 * - ظرفیت: فقط از DailyPlan خودِ کاربر؛ هرگز از body کلاینت (سند فاز ۲ §۸/§۹).
 * - کارها: فقط کارهای باز (DONE تاریخچه است و وارد برنامه‌ریزی نمی‌شود).
 * - بدون plan یا ظرفیت ≤ ۰ → DayPlanNotSetError؛ بدون کار باز → NoPlannableTasksError.
 */
export async function getPlanGenerationContext(
    userId: number,
    dayKey: string,
): Promise<PlanGenerationContext> {
    const prisma = getPrisma()

    const plan = await prisma.dailyPlan.findUnique({
        where: { userId_dayKey: { userId, dayKey } },
        select: { availableMinutes: true, planVersion: true, rebalancedVersion: true },
    })

    if (!plan || plan.availableMinutes <= 0) {
        throw new DayPlanNotSetError()
    }

    const tasks = await prisma.task.findMany({
        where: { userId, dayKey, status: { not: "DONE" } },
        select: {
            id: true,
            title: true,
            category: true,
            estimatedTime: true,
            score: true,
            priority: true,
            status: true,
            allocatedMinutes: true,
        },
    })

    if (tasks.length === 0) {
        throw new NoPlannableTasksError()
    }

    return {
        planVersion: plan.planVersion,
        rebalancedVersion: plan.rebalancedVersion,
        availableMinutes: plan.availableMinutes,
        input: buildPlanInput(dayKey, plan.availableMinutes, tasks),
        suggestionTasks: tasks.map(toSuggestionTaskInput),
    }
}
