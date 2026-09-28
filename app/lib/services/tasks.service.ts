import { getPrisma } from "@/app/lib/getPrisma"
import { analyzeTask, type AiSource } from "@/app/lib/ai/analyzeTask"
import { attachAiCallTelemetry, type AiCallTelemetry } from "@/app/lib/ai/aiDuration"
import {
    ensureDayRebalanced,
    markDayStale,
    type RebalanceOutput,
} from "@/app/lib/planner/rebalance"
import { getDaySummary, type DaySummary } from "@/app/lib/planner/summary"
import { buildRolloverOps } from "@/app/lib/planner/rolloverOps"
import {
    canonicalKeyToLocalMidnight,
    getCanonicalDayKey,
    getCanonicalToday,
    shiftCanonicalKey,
} from "@/app/lib/canonicalDay"
import type { Prisma, PrismaPromise, Task } from "@prisma/client"
import {
    assertCategorySelection,
    normalizeCategorySelection,
    type CustomCategoryIcon,
} from "@/app/lib/categories"
import {
    TaskNotFoundError,
    MissingDayKeyError,
    TaskAlreadyDoneError,
    TaskNotAnalyzeableError,
    OverdueTaskError,
    NoRolloverCandidatesError,
    PlanStaleError,
} from "./errors"

// ---------- ساخت تسک (مستقل از AI — فیلدهای تحلیل null می‌مانند تا Analyze صریح) ----------
// دسته‌بندی استثنا است: در این محصول **اجباری** است و یا یک کلید canonical (preset)
// می‌آید یا یک برچسب سفارشی + آیکنِ عضو allowlist. برای preset آیکن ذخیره
// نمی‌شود (null) تا تغییر آیکن presetها migration داده‌ای نخواهد. بقیهٔ فیلدهای AI
// (priority/score/reason/estimatedTime) همچنان null می‌مانند تا «تحلیل مجدد»
// صریح آن‌ها را پر کند — این رفتار تغییری نکرده است.
// §6.2.2.1: dayKey هرگز از Client پذیرفته نمی‌شود — از scheduledDate + user.timezone سمت سرور محاسبه می‌شود.
// scheduledDate ذخیره‌شده هم به نیمه‌شب محلیِ همان روز (canonicalKeyToLocalMidnight) نرمال می‌شود.
// A3: ساخت = mutation مؤثر بر برنامه → planVersion روز در همان transaction اتمیک افزایش می‌یابد.
export async function createTask(
    userId: number,
    timezone: string,
    input: {
        title: string
        scheduledDate: Date
        category: string
        categoryIcon?: CustomCategoryIcon | string | null
    },
): Promise<{ task: Task }> {
    const { title, scheduledDate, category } = input
    const prisma = getPrisma()

    // Fail-fast: سرویس هرگز نباید «دستهٔ غایب/نامعتبر» را به null تبدیل کند.
    // این خط دفاعی است — schema مسیر HTTP قبلاً رد کرده، اما هر مسیر دیگری
    // (مثلاً یک caller داخلی یا صف آفلاین) نمی‌تواند بی‌صدا یک Task بدون دسته
    // یا یک custom ناقص بسازد.
    assertCategorySelection(category, input.categoryIcon)
    const selection = normalizeCategorySelection(category, input.categoryIcon)!

    const dayKey = getCanonicalDayKey(scheduledDate, timezone)
    const localMidnight = canonicalKeyToLocalMidnight(dayKey, timezone)

    const task = await prisma.$transaction(async (tx) => {
        const created = await tx.task.create({
            data: {
                title,
                dayKey,
                scheduledDate: localMidnight,
                userId,
                // در همان transaction ذخیره می‌شود: Task یا با دسته ساخته می‌شود
                // یا اصلاً ساخته نمی‌شود.
                category: selection.category,
                categoryIcon: selection.categoryIcon,
            },
        })

        // bump اتمیک — اگه پلن روز وجود نداشته باشد، no-op است (روز برنامه‌ریزی‌نشده)
        await tx.dailyPlan.updateMany({
            where: { userId, dayKey },
            data: { planVersion: { increment: 1 } },
        })

        // A2: رویداد CREATED در همان transaction (§6.3.6)
        await tx.taskEvent.create({ data: { taskId: created.id, type: "CREATED" } })

        return created
    })

    return { task }
}

// ---------- خواندن تک تسک (Ownership: فقط تسک‌های userId خودش) ----------
export async function getTask(userId: number, taskId: number): Promise<Task> {
    const task = await getPrisma().task.findFirst({ where: { id: taskId, userId } })
    if (!task) throw new TaskNotFoundError()
    return task
}

// ---------- تسک‌های یک روز + خلاصه (پیش‌فرض dayKey در Route تعیین می‌شود) ----------
export async function getDayTasks(
    userId: number,
    dayKey: string,
): Promise<{ tasks: Task[]; summary: DaySummary }> {
    const prisma = getPrisma()

    // A3 (ADR-03): ورود به نمای روز — اگه برنامه stale باشد، اول Rebalance اجرا می‌شود
    await ensureDayRebalanced(userId, dayKey)

    const tasks = await prisma.task.findMany({ where: { userId, dayKey } })

    // مرتب‌سازی: انجام‌شده‌ها آخر، بعد بر اساس score نزولی
    tasks.sort((a, b) => {
        const doneA = a.status === "DONE" ? 1 : 0
        const doneB = b.status === "DONE" ? 1 : 0
        if (doneA !== doneB) return doneA - doneB
        return (b.score ?? -1) - (a.score ?? -1) || a.createdAt.getTime() - b.createdAt.getTime()
    })

    const summary = await getDaySummary(userId, dayKey)

    return { tasks, summary }
}

// ---------- تسک‌های بازِ روزهای گذشته (کاندیدای rollover) ----------
export async function getOverdueTasks(userId: number, timezone: string): Promise<Task[]> {
    const today = getCanonicalToday(timezone)
    return getPrisma().task.findMany({
        where: {
            userId,
            status: { not: "DONE" },
            dayKey: { lt: today },
        },
        orderBy: { dayKey: "desc" },
    })
}

// ---------- حذف تسک ----------
// A3: به‌جای eager rebalance → روز stale می‌شود (bump).
// توجه: به‌دلیل quirk «حذف-سپس-400»، bump جدا از delete است (رفتار فعلی حفظ می‌شود).
export async function deleteTask(
    userId: number,
    taskId: number,
): Promise<{ id: number; summary: RebalanceOutput | null }> {
    const prisma = getPrisma()
    const task = await prisma.task.findFirst({ where: { id: taskId, userId } })
    if (!task) throw new TaskNotFoundError()

    await prisma.task.delete({ where: { id: task.id } })

    // رفتار فعلی حفظ می‌شود: تسک حذف شده و سپس در صورت نبودن dayKey خطای 400 برمی‌گردد
    let summary: RebalanceOutput | null = null

    if (task.status !== "DONE") {
        if (!task.dayKey) throw new MissingDayKeyError()

        await markDayStale(userId, task.dayKey)
    }

    return { id: task.id, summary }
}

// ---------- اتمام تسک و Time Tracking (§3.10-C / §5.4.1) ----------
// §5.4.1: spentMinutes = مدت واقعی صرف‌شده روی Task ذخیره می‌شود (پایهی مقایسهی planned vs actual).
export async function completeTask(
    userId: number,
    timezone: string,
    taskId: number,
    input: { spentMinutes: number },
): Promise<{
    task: Task
    result: { savedMinutes: number; overspentMinutes: number }
    summaries: Record<string, RebalanceOutput>
}> {
    const prisma = getPrisma()
    const task = await prisma.task.findFirst({ where: { id: taskId, userId } })
    if (!task) throw new TaskNotFoundError()
    if (task.status === "DONE") throw new TaskAlreadyDoneError()

    const oldDayKey = task.dayKey
    if (!oldDayKey) throw new MissingDayKeyError()

    const targetDayKey = getCanonicalToday(timezone) // تسک همیشه روی «روز اتمامِ واقعی» بسته می‌شود

    const { spentMinutes } = input

    // مقایسه با تخصیص → سیو شده یا بیش‌مصرفی
    const allocated = task.allocatedMinutes ?? task.estimatedTime ?? spentMinutes
    const savedMinutes = Math.max(0, allocated - spentMinutes)
    const overspentMinutes = Math.max(0, spentMinutes - allocated)

    const data: {
        status: "DONE"
        spentMinutes: number
        completedAt: Date
        completedOn: string
        allocatedMinutes?: number
        dayKey?: string
        scheduledDate?: Date
        previousScheduledDate?: Date
    } = {
        status: "DONE",
        spentMinutes,
        completedAt: new Date(),
        completedOn: targetDayKey,
    }

    // اگه تسک هیچ تخصیصی نداشت، پایه رو ذخیره کن تا مارکرها/تاریخچه با همین جواب یکی باشن
    if (task.allocatedMinutes == null) {
        data.allocatedMinutes = allocated
    }

    // تسک از روز دیگه‌ای مونده بود → اول به امروز منتقل می‌شه تا حسابداری درست باشه
    if (oldDayKey !== targetDayKey) {
        data.dayKey = targetDayKey
        data.scheduledDate = canonicalKeyToLocalMidnight(targetDayKey, timezone)
        data.previousScheduledDate = canonicalKeyToLocalMidnight(oldDayKey, timezone)
    }

    // A3: روزهای متأثر در همان transaction اتمام، stale می‌شوند (bump اتمیک)
    // H4 (audit) — گارد اتمیک ضد double-completion:
    // نوشتن به‌صورت شرطی (status != DONE) و داخل یک transaction تعاملی انجام می‌شود. اگر دو
    // درخواست هم‌زمان برسند، دومی count = 0 می‌گیرد → TaskAlreadyDoneError و هیچ
    // TaskEvent/بمپ planVersion نوشته نمی‌شود (برخلاف چک pre-flight قبلی که TOCTOU داشت).
    const affectedDays = new Set<string>([oldDayKey, targetDayKey])
    const updated = await prisma.$transaction(async (tx) => {
        const guard = await tx.task.updateMany({
            where: { id: task.id, userId, status: { not: "DONE" } },
            data,
        })
        if (guard.count !== 1) throw new TaskAlreadyDoneError()

        for (const dayKey of affectedDays) {
            await tx.dailyPlan.updateMany({
                where: { userId, dayKey },
                data: { planVersion: { increment: 1 } },
            })
        }

        // A2: رویداد COMPLETED در همان transaction (§6.3.6 — payload مثال: spentMinutes)
        await tx.taskEvent.create({
            data: {
                taskId: task.id,
                type: "COMPLETED",
                payload: { spentMinutes, savedMinutes, overspentMinutes },
            },
        })

        // حالت نهایی همان رکورد از دیتابیس خوانده می‌شود (منبع حقیقت، نه بازسازی محلی)
        const fresh = await tx.task.findFirst({ where: { id: task.id, userId } })
        if (!fresh) throw new TaskNotFoundError()
        return fresh
    })

    // A3: بازتوزیع در زمان mutation اجرا نمی‌شود — read بعدی آن را lazy اجرا می‌کند
    const summaries: Record<string, RebalanceOutput> = {}

    return { task: updated, result: { savedMinutes, overspentMinutes }, summaries }
}

// ---------- انتقال (rollover) تسک‌های عقب‌افتاده ----------
// A1 Phase 4: گارد نسخه‌ی blueprint (اختیاری). اگر Client نسخه‌ای بفرستد، انتقال فقط وقتی
// انجام می‌شود که planVersion روزهای مبدأ هنوز همان باشد؛ در غیر این صورت 409 PLAN_STALE
// و هیچ نوشتنی رخ نمی‌دهد (بدون state کثیف). مسیرهای دیگر (کارهای عقب‌افتاده) نسخه نمی‌فرستند
// → رفتارشان بدون تغییر می‌ماند.
export async function rolloverTasks(
    userId: number,
    timezone: string,
    taskIds: number[],
    expectedPlanVersion?: number,
): Promise<{ moved: { id: number; from: string; to: string }[]; summaries: Record<string, RebalanceOutput> }> {
    const prisma = getPrisma()
    const tasks = await prisma.task.findMany({
        where: { id: { in: taskIds }, userId, status: { not: "DONE" } },
    })

    // فقط تسک‌هایی که روز برنامه‌ریزی دارند قابل انتقال‌اند
    const schedulable = tasks.filter(
        (t): t is (typeof tasks)[number] & { dayKey: string } => t.dayKey != null,
    )

    if (schedulable.length === 0) throw new NoRolloverCandidatesError()

    // §6.3.2 — optimistic read قبل از هر نوشتن: blueprint کهنه = هیچ تغییری اعمال نمی‌شود.
    // نبود رکورد DailyPlan معادل planVersion صفر است (§6.3.3)، همان مقداری که blueprint خوانده بود.
    if (expectedPlanVersion !== undefined) {
        const sourceDays = Array.from(new Set(schedulable.map((t) => t.dayKey)))
        const plans = await Promise.all(
            sourceDays.map((dayKey) =>
                prisma.dailyPlan.findUnique({ where: { userId_dayKey: { userId, dayKey } } }),
            ),
        )
        const stale = plans.some((plan) => (plan?.planVersion ?? 0) !== expectedPlanVersion)
        if (stale) throw new PlanStaleError()
    }

    const today = getCanonicalToday(timezone)
    const affectedDays = new Set<string>()
    const moved: { id: number; from: string; to: string }[] = []

    // قاعدهٔ «روز مقصد» در همین مسیر عمومی عیناً حفظ شده و دست‌نخورده است:
    // عقب‌افتاده → امروز؛ تسک امروز/آینده → فردا.
    // فقط *محاسبهٔ نوشتن‌ها* به هستهٔ خالصِ rolloverOps سپرده شده تا مسیر Apply هم
    // دقیقاً همان معنا را داشته باشد (بدون هیچ تغییری در رفتار این مسیر).
    // گروه‌بندی بر اساس روز مقصد انجام می‌شود تا ترتیب تسک‌ها/روزها مثل قبل بماند.
    const groups = new Map<string, typeof schedulable>()
    for (const task of schedulable) {
        const to = task.dayKey < today ? today : shiftCanonicalKey(task.dayKey, 1)
        const bucket = groups.get(to)
        if (bucket) bucket.push(task)
        else groups.set(to, [task])
    }

    const ops: PrismaPromise<unknown>[] = []
    for (const [to, group] of groups) {
        const plan = buildRolloverOps(group, to, timezone)

        for (const op of plan.taskOps) {
            affectedDays.add(op.fromDayKey)
            affectedDays.add(op.toDayKey)
            ops.push(
                prisma.task.update({
                    where: { id: op.taskId },
                    data: {
                        dayKey: op.toDayKey,
                        scheduledDate: op.scheduledDate,
                        previousScheduledDate: op.previousScheduledDate,
                        allocatedMinutes: op.allocatedMinutes,
                    },
                }),
            )
        }

        // A2: رویداد ROLLED_OVER per-task در همان transaction (§6.3.6 — payload مثال)
        for (const event of plan.eventOps) {
            ops.push(
                prisma.taskEvent.create({
                    data: {
                        taskId: event.taskId,
                        type: "ROLLED_OVER",
                        payload: { fromDayKey: event.fromDayKey, toDayKey: event.toDayKey },
                    },
                }),
            )
        }

        moved.push(...plan.moved)
    }

    // A3: روزهای متأثر در همان transaction rollover stale می‌شوند (bump اتمیک)
    for (const dayKey of affectedDays) {
        ops.push(
            prisma.dailyPlan.updateMany({
                where: { userId, dayKey },
                data: { planVersion: { increment: 1 } },
            }),
        )
    }

    await prisma.$transaction(ops)

    // A3: بازتوزیع در زمان mutation اجرا نمی‌شود — read بعدی آن را lazy اجرا می‌کند
    const summaries: Record<string, RebalanceOutput> = {}

    return { moved, summaries }
}

// ---------- تحلیل مجدد تسک با AI (فقط TODO) ----------
export async function reanalyzeTask(
    userId: number,
    timezone: string,
    taskId: number,
    textOverride?: string,
): Promise<{
    task: Task
    aiSource: AiSource
    /** provider مؤثر + آیا fallback رخ داده — فقط برای observability. */
    aiProvider?: string
    fallbackUsed?: boolean
    /** مدت واقعی عملیات AI + شمارندهٔ تلاش (مرحلهٔ ۴.۲) — فقط برای observability. */
    aiTelemetry?: AiCallTelemetry
    summary: RebalanceOutput | null
}> {
    const prisma = getPrisma()
    const task = await prisma.task.findFirst({ where: { id: taskId, userId } })
    if (!task) throw new TaskNotFoundError()

    // فقط TODO قابل تحلیل مجدد است — DONE تاریخچه را می‌سازد و IN_PROGRESS سهمش محافظت شده
    if (task.status !== "TODO") {
        throw new TaskNotAnalyzeableError(task.status === "DONE" ? "DONE" : "IN_PROGRESS")
    }

    if (!task.dayKey) throw new MissingDayKeyError()

    // تسک عقب‌افتاده؟ اول باید به امروز منتقل شود تا بازتوزیع روی روز درست انجام شود
    if (task.dayKey < getCanonicalToday(timezone)) {
        throw new OverdueTaskError()
    }

    const newText = (textOverride ?? task.title).trim()
    const { source, analysis, aiProvider, fallbackUsed, aiTelemetry } = await analyzeTask(newText)

    // A3: Analyze = mutation مؤثر بر برنامه (7.7 Analyze ≠ Rebalance) →
    // روز در همان transaction stale می‌شود؛ بازتوزیع lazy است.
    let updated: Task
    try {
        ;[updated] = await prisma.$transaction([
            prisma.task.update({
                where: { id: task.id },
                data: {
                    title: newText,
                    priority: analysis.priority,
                    score: analysis.score,
                    reason: analysis.reason,
                    category: task.category ?? analysis.category, // قانون 7.5: فقط وقتی null باشد مقداردهی می‌شود
                    estimatedTime: analysis.estimatedMinutes,
                },
            }),
            prisma.dailyPlan.updateMany({
                where: { userId, dayKey: task.dayKey },
                data: { planVersion: { increment: 1 } },
            }),
            // A2: رویداد ANALYZED در همان transaction (§6.3.6 / 7.12 gap 3)
            prisma.taskEvent.create({ data: { taskId: task.id, type: "ANALYZED" } }),
        ])
    } catch (error) {
        // مرحلهٔ ۴.۲ — AI موفق بوده ولی نوشتن DB شکست خورده است. مدت اندازه‌گیری‌شده
        // بیرون از خودِ شیء خطا نگه داشته می‌شود تا route آن را کنار failureCode
        // بنویسد؛ خودِ خطا دقیقاً همان شیء قبلی است و رفتار تغییر نمی‌کند.
        throw attachAiCallTelemetry(error, aiTelemetry)
    }

    // A3: بازتوزیع در زمان mutation اجرا نمی‌شود — read بعدی آن را lazy اجرا می‌کند
    return { task: updated, aiSource: source, aiProvider, fallbackUsed, aiTelemetry, summary: null }
}

// ---------- ویرایش تسک (A1 — کلاس‌های Content و Planning-only، §6.3.5) ----------
// Content (تغییر title) → گروه AI (score/priority/estimatedTime/reason) null می‌شود + EDITED + bump.
// Planning-only (scheduledDate / status) → فیلدهای AI untouched + bump روزهای affected، بدون EDITED.
// dayKey از scheduledDate + user.timezone سمت سرور محاسبه می‌شود (§6.2.2.1)؛ مقدار client هیچ‌وقت source of truth نیست.
// category فراداده‌ی کاربر است: در Content untouched می‌ماند و ویرایشش bump/EDITED ندارد.
export async function updateTask(
    userId: number,
    timezone: string,
    taskId: number,
    input: {
        title?: string
        status?: "TODO" | "IN_PROGRESS"
        scheduledDate?: Date
        category?: string | null
        categoryIcon?: string | null
    },
): Promise<{ task: Task; changed: boolean; changedFields: string[] }> {
    const prisma = getPrisma()
    const task = await prisma.task.findFirst({ where: { id: taskId, userId } })
    if (!task) throw new TaskNotFoundError()

    // دسته و آیکن یک **واحد فراداده** هستند: هر تغییر یکی از آن‌ها هر دو را
    // با هم می‌نویسد تا Task هرگز در حالت نیمه‌کاره (custom بدون آیکن، یا preset
    // با آیکن بیگانه) نیفتد. آیکن بدون دسته در PATCH مجاز نیست (schema رد می‌کند).
    // «حذف دسته» = category=null؛ مقدارِ نوشتنی مستقیماً null نگه داشته می‌شود
    // (نه یک sentinel مثل "") تا با task.category از نوع null مقایسه شود و PATCH
    // تکراری روی تسکِ بدون دسته، no-op بماند — دقیقاً مثل رفتار پیش از custom.
    let nextCategory: string | null | undefined
    let nextCategoryIcon: CustomCategoryIcon | null | undefined
    if (input.category !== undefined) {
        if (input.category === null) {
            nextCategory = null
            nextCategoryIcon = null
        } else {
            assertCategorySelection(input.category, input.categoryIcon)
            const selection = normalizeCategorySelection(input.category, input.categoryIcon)!
            nextCategory = selection.category
            nextCategoryIcon = selection.categoryIcon
        }
    }

    const categoryChanged =
        nextCategory !== undefined &&
        (nextCategory !== task.category || nextCategoryIcon !== task.categoryIcon)

    const data: Prisma.TaskUpdateInput = {}
    let titleChanged = false
    let dayChanged = false
    let statusChanged = false

    if (input.title !== undefined) {
        const trimmed = input.title.trim()
        if (trimmed !== task.title) {
            titleChanged = true
            data.title = trimmed
        }
    }
    if (input.scheduledDate !== undefined) {
        const dayKey = getCanonicalDayKey(input.scheduledDate, timezone)
        if (dayKey !== task.dayKey) {
            dayChanged = true
            data.dayKey = dayKey
            data.scheduledDate = canonicalKeyToLocalMidnight(dayKey, timezone)
            data.previousScheduledDate = task.scheduledDate
        }
    }
    if (input.status !== undefined && input.status !== task.status) {
        statusChanged = true
        data.status = input.status
    }
    if (categoryChanged) {
        // null یعنی «حذف دسته» و مجاز است تا کاربر بتواند تسک را به حالت بدون
        // دسته برگرداند؛ بقیهٔ زمان‌ها یک جفت معتبر و نرمال‌شده می‌نویسند.
        data.category = nextCategory!
        data.categoryIcon = nextCategoryIcon!
    }

    const isContent = titleChanged // §6.3.5: تغییر متن = Content Mutation
    if (!titleChanged && !dayChanged && !statusChanged && !categoryChanged) {
        // درخواست بدون تغییر واقعی → no-op؛ گام ۸: changed=false صریح در قرارداد بازگشتی
        return { task, changed: false, changedFields: [] }
    }

    // گام ۸: نام فیلدهای واقعاً تغییرکرده (فقط نام‌ها؛ هرگز مقادیر — §8 قرارداد ProductEvent)
    const changedFields: string[] = []
    if (titleChanged) changedFields.push("title")
    if (dayChanged) changedFields.push("day")
    if (statusChanged) changedFields.push("status")
    if (categoryChanged) changedFields.push("category")

    if (isContent) {
        // §6.3.5/§7.6: فقط گروه AI null می‌شود؛ category و allocatedMinutes untouched می‌مانند.
        data.score = null
        data.estimatedTime = null
        data.reason = null
        data.priority = null
    }

    // ویرایش فقط category → فراداده‌ی کاربر: نه اثر برنامه‌ریزی دارد و نه EDITED (§6.3.6)
    const isPlanningAffecting = titleChanged || dayChanged || statusChanged
    if (!isPlanningAffecting) {
        const updated = await prisma.task.update({ where: { id: task.id }, data })
        return { task: updated, changed: true, changedFields }
    }

    // روزهای affected: روز فعلی + روز مقصد (در صورت reschedule)
    const affectedDays = new Set<string>()
    affectedDays.add(task.dayKey)
    if (dayChanged && input.scheduledDate) {
        affectedDays.add(getCanonicalDayKey(input.scheduledDate, timezone))
    }

    const ops: PrismaPromise<unknown>[] = [prisma.task.update({ where: { id: task.id }, data })]
    for (const dayKey of affectedDays) {
        ops.push(
            prisma.dailyPlan.updateMany({
                where: { userId, dayKey },
                data: { planVersion: { increment: 1 } },
            }),
        )
    }
    if (isContent) {
        // §6.3.6: EDITED فقط در Content Mutation ثبت می‌شود
        ops.push(prisma.taskEvent.create({ data: { taskId: task.id, type: "EDITED" } }))
    }

    const [updated] = (await prisma.$transaction(ops)) as [Task]
    return { task: updated, changed: true, changedFields }
}