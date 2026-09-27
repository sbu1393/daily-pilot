// Phase 3 (AI Daily Plan) — Apply orchestrator + stale protection
// ------------------------------------------------------------------
// یک proposal گذرا (خروجی Phase 2) را اتمیک روی وضعیت روز اعمال می‌کند.
//
// اصول معماری (LOCKED):
// - AI هرگز scheduler نیست. این سرویس proposal را مستقیماً به allocatedMinutes تبدیل **نمی‌کند**.
//   فقط metadataِ تسک‌ها (estimatedTime/score/priority) را از proposal می‌نویسد؛ تخصیص نهایی
//   همان‌طور که همیشه از موتور قطعی (suggestDay / distribute) می‌آید — از مسیر lazy rebalance موجود.
// - نسخه‌بندی موجود reuse می‌شود: writer دومی برای DailyPlan ساخته نمی‌شود. گاردِ نسخه همان
//   عملیات اتمیکِ increment است که markDayStale/setDayPlan استفاده می‌کنند، فقط **شرطی** شده تا
//   optimistic guard باشد. setDayPlan عمداً صدا زده نمی‌شود چون Apply ظرفیت روز را تغییر نمی‌دهد.
// - هیچ AI call، هیچ quota، هیچ route-to-route HTTP.
//
// Trust boundary (§۵): proposal از client می‌آید و untrusted است. schema (route) ساختار را چک
// می‌کند؛ این سرویس مالکیت/روز/وضعیت/نسخه را در برابر DB چک می‌کند. هر عدم تطابق → 409 PLAN_STALE
// و **صفر mutation** (§۴/§۱۲).

import type { Prisma, Task } from "@prisma/client"

import { getPrisma } from "@/app/lib/getPrisma"
import { shiftCanonicalKey } from "@/app/lib/canonicalDay"
import type { PlanProposal } from "@/app/lib/planner/planProposal"
import { buildRolloverOps } from "@/app/lib/planner/rolloverOps"

import { getDayTasks } from "./tasks.service"
import { PlanStaleError } from "./errors"

export type ApplyPlanInput = {
    dayKey: string
    expectedPlanVersion: number
    proposal: PlanProposal
    /** timezone کاربر — فقط برای محاسبهٔ نیمه‌شب محلیِ روز مقصد (بدون آن، از DB خوانده نمی‌شود) */
    timezone: string
    /**
     * Phase 4.4 — گزینهٔ اختیاری «انتقال موارد خارج از ظرفیت به فردا».
     * پیش‌فرض false؛ بدون آن رفتار Apply **دقیقاً** همان رفتار قبلی می‌ماند
     * (هیچ تسکی جابه‌جا نمی‌شود، هیچ نسخه‌ای بیشتر bump نمی‌شود).
     */
    moveUnfittedToTomorrow?: boolean
}

export type ApplyPlanResult = {
    applied: true
    dayKey: string
    planVersion: number
    rebalancedVersion: number | null
    availableMinutes: number
    plannedMinutes: number
    remainingMinutes: number
    tasks: Task[]
    /**
     * Phase 4.4 (additive) — شناسهٔ تسک‌هایی که واقعاً به روز بعد منتقل شدند.
     * اگر هیچ چیز منتقل نشد (گزینه خاموش، یا `unfitted` خالی) آرایهٔ خالی است.
     * توجه: شناسه‌ها در این پروژه عددی‌اند (Prisma Int) — مثل `aiUnscheduledTaskIds`.
     */
    movedTaskIds: number[]
    /** روز مقصد انتقال — فقط وقتی واقعاً چیزی منتقل شده باشد مقدار دارد. */
    destinationDayKey?: string
}

/**
 * applyPlan — اعمال اتمیک یک proposal روی روز کاربر.
 *
 * جریان:
 *   ۱) تطابق basis (روز/نسخه) با request → در غیر این صورت PLAN_STALE (قبل از هر I/O).
 *   ۲) بارگذاری plan + taskهای ارجاع‌شده (فقط برای همان userId) → مالکیت/روز/وضعیت.
 *   ۳) تراکنش: گاردِ اتمیکِ نسخه (conditional increment) + نوشتن metadata روی تسک‌های TODO.
 *   ۴) lazy rebalance (مسیر read موجود) + خواندن وضعیت نهایی.
 *
 * اگر گاردِ نسخه count=0 بدهد، کل تراکنش rollback می‌شود → هیچ تسکی تغییر نمی‌کند.
 */
export async function applyPlan(userId: number, input: ApplyPlanInput): Promise<ApplyPlanResult> {
    const { dayKey, expectedPlanVersion, proposal, timezone } = input
    const moveUnfittedToTomorrow = input.moveUnfittedToTomorrow ?? false

    // (۱) Trust boundary — proposal باید به همین روز و همین نسخه تعلق داشته باشد.
    if (
        proposal.basis.dayKey !== dayKey ||
        proposal.basis.planVersion !== expectedPlanVersion
    ) {
        throw new PlanStaleError()
    }

    const prisma = getPrisma()

    const referencedIds = [
        ...proposal.planned.map((item) => item.taskId),
        ...proposal.unfitted.map((item) => item.taskId),
    ]

    const [plan, tasks] = await Promise.all([
        prisma.dailyPlan.findUnique({
            where: { userId_dayKey: { userId, dayKey } },
            select: { planVersion: true },
        }),
        prisma.task.findMany({
            where: { id: { in: referencedIds }, userId },
            // scheduledDate فقط وقتی لازم است که انتقالِ جا‌نشده‌ها خواسته شده باشد؛
            // با همان select خوانده می‌شود تا Apply یک query بیشتر نزند.
            select: { id: true, dayKey: true, status: true, scheduledDate: true },
        }),
    ])

    // (۲) Fast-path stale check (گاردِ واقعی، اتمیک، پایین‌تر است).
    if (!plan || plan.planVersion !== expectedPlanVersion) throw new PlanStaleError()

    const taskById = new Map(tasks.map((task) => [task.id, task]))
    for (const id of new Set(referencedIds)) {
        const task = taskById.get(id)
        // task ناشناخته/حذف‌شده/متعلق به کاربر دیگر، منتقل‌شده به روز دیگر، یا تمام‌شده بعد از
        // Generate → proposal دیگر با روز سازگار نیست.
        if (!task || task.dayKey !== dayKey || task.status === "DONE") throw new PlanStaleError()
    }

    // (۳) فقط تسک‌های TODO metadata می‌گیرند (semantics موجود: فیلدهای AI فقط برای کار قابل‌برنامه‌ریزی
    // نوشته می‌شوند؛ تخصیص IN_PROGRESS محافظت‌شده است و DONE تاریخچه). چون گاردِ نسخه بالا می‌رود و
    // تغییر status هم به‌صورت اتمیک planVersion را bump می‌کند، هر تسکِ TODO اینجا در زمان Generate
    // هم TODO بوده است.
    //
    // Phase 4.2 — metadata از planned و unfitted هر دو persist می‌شود: AI برای همهٔ تسک‌ها
    // estimate/score/priority داده و split فقط نتیجهٔ ظرفیت است؛ اگر metadataِ unfitted از دست برود،
    // rebalance پس از Apply با Proposalِ نمایش‌داده‌شده یکی نمی‌شود (invariant «Apply ≈ State shown»).
    const todoIds = new Set(tasks.filter((task) => task.status === "TODO").map((task) => task.id))
    const metadataUpdates = [...proposal.planned, ...proposal.unfitted]
        .filter((item) => todoIds.has(item.taskId))
        .map((item) => ({
            taskId: item.taskId,
            estimatedTime: item.estimatedMinutes,
            score: item.score,
            priority: item.priority,
        }))

    // Phase 4.4 — «انتقال موارد خارج از ظرفیت به فردا».
    //
    // قاعدهٔ مقصد (LOCKED): همیشه `shiftCanonicalKey(proposal.basis.dayKey, 1)` —
    // یعنی **فردا نسبت به روزِ خودِ proposal**، نه فردا نسبت به امروز. برای
    // پیشنهادِ مربوط به یک روز گذشته هم همین قاعده عیناً اعمال می‌شود؛ بنابراین
    // شاخهٔ «عقب‌افتاده → امروز»ِ مسیر عمومی rollover اینجا عمداً استفاده نمی‌شود.
    //
    // فقط تسک‌های TODO جابه‌جا می‌شوند: تخصیص IN_PROGRESS محافظت‌شده است و
    // DONE (که اصلاً در proposal نیست) پیش‌تر با PLAN_STALE رد شده است.
    const destinationDayKey = shiftCanonicalKey(proposal.basis.dayKey, 1)
    const unfittedIds = new Set(proposal.unfitted.map((item) => item.taskId))
    const movableUnfitted = moveUnfittedToTomorrow
        ? tasks.filter((task) => task.status === "TODO" && unfittedIds.has(task.id))
        : []
    const rolloverPlan = movableUnfitted.length
        ? buildRolloverOps(
              movableUnfitted.map((task) => ({
                  id: task.id,
                  dayKey: task.dayKey,
                  scheduledDate: task.scheduledDate,
              })),
              destinationDayKey,
              timezone,
          )
        : null
    const movedTaskIds = rolloverPlan ? rolloverPlan.moved.map((m) => m.id) : []

    await prisma.$transaction(async (tx) => {
        // گاردِ اتمیک نسخه: increment شرطی. اگر روز بین Generate و Apply حرکت کرده باشد
        // (task اضافه/حذف/تمام/منتقل، تغییر ظرفیت، تغییر status... همه planVersion را bump می‌کنند)
        // count=0 می‌شود و کل تراکنش بدون هیچ نوشتنی شکست می‌خورد.
        const guard = await tx.dailyPlan.updateMany({
            where: { userId, dayKey, planVersion: expectedPlanVersion },
            data: { planVersion: { increment: 1 } },
        })
        if (guard.count !== 1) throw new PlanStaleError()

        for (const update of metadataUpdates) {
            const data: Prisma.TaskUpdateManyMutationInput = {
                estimatedTime: update.estimatedTime,
            }
            // priority/score فقط وقتی حاضرند overwrite می‌شوند (هرگز با null پاک نمی‌شوند)
            if (update.score != null) data.score = update.score
            if (update.priority != null) data.priority = update.priority

            const res = await tx.task.updateMany({
                where: { id: update.taskId, userId, dayKey, status: "TODO" },
                data,
            })
            // دفاعی: اگر تسک بین pre-check و تراکنش تغییر کرده باشد، هیچ نوشتنی commit نمی‌شود
            if (res.count !== 1) throw new PlanStaleError()
        }

        // گام ۳ — انتقال جا‌نشده‌ها (فقط وقتی گزینه روشن باشد). planning-only:
        // فقط dayKey/scheduledDate/previousScheduledDate/allocatedMinutes تغییر می‌کنند و
        // status/category/priority/score/estimatedTime/reason دست‌نخورده می‌مانند.
        for (const op of rolloverPlan?.taskOps ?? []) {
            const res = await tx.task.updateMany({
                where: { id: op.taskId, userId, dayKey, status: "TODO" },
                data: {
                    dayKey: op.toDayKey,
                    scheduledDate: op.scheduledDate,
                    previousScheduledDate: op.previousScheduledDate,
                    allocatedMinutes: op.allocatedMinutes,
                },
            })
            // همان دفاع قبلی: تغییر هم‌زمان ⇒ کل تراکنش بدون نوشتن برمی‌گردد
            if (res.count !== 1) throw new PlanStaleError()
        }

        // گام ۴ — رویداد ROLLED_OVER برای هر تسکِ منتقل‌شده (همان semantics مسیر rollover)
        for (const event of rolloverPlan?.eventOps ?? []) {
            await tx.taskEvent.create({
                data: {
                    taskId: event.taskId,
                    type: "ROLLED_OVER",
                    payload: { fromDayKey: event.fromDayKey, toDayKey: event.toDayKey },
                },
            })
        }

        // گام ۵ — فقط روز مقصد bump می‌شود؛ روز مبدأ در گام ۱ (گارد) bump شده و
        // دوباره bump نمی‌شود. نبودِ DailyPlan در مقصد یعنی no-op (همان رفتار rollover).
        if (rolloverPlan) {
            await tx.dailyPlan.updateMany({
                where: { userId, dayKey: destinationDayKey },
                data: { planVersion: { increment: 1 } },
            })
        }
    })

    // (۴) تخصیص از مسیر lazy rebalance موجود دوباره محاسبه می‌شود (همان scheduler قطعی). این یک
    // گام idempotent و مشتق از state persist‌شده است، نه بخشی از business transaction.
    const { tasks: dayTasks, summary } = await getDayTasks(userId, dayKey)

    const freshPlan = await prisma.dailyPlan.findUnique({
        where: { userId_dayKey: { userId, dayKey } },
        select: { planVersion: true, rebalancedVersion: true },
    })

    return {
        applied: true,
        dayKey,
        planVersion: freshPlan?.planVersion ?? 0,
        rebalancedVersion: freshPlan?.rebalancedVersion ?? null,
        availableMinutes: summary.availableMinutes,
        plannedMinutes: summary.committedMinutes,
        remainingMinutes: summary.poolMinutes,
        tasks: dayTasks,
        // additive: وقتی چیزی منتقل نشده، مقصد اصلاً معنا ندارد
        movedTaskIds,
        ...(movedTaskIds.length > 0 ? { destinationDayKey } : {}),
    }
}
