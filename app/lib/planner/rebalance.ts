import { getPrisma } from "@/app/lib/getPrisma"
import { savedForTask } from "./summary"

const MIN_ALLOCATION = 15 // کمتر از این → کاندیدای انتقال به فردا
const GRANULARITY = 5 // همهی تخصیصها مضرب ۵ دقیقه
const DEFAULT_ESTIMATE = 30 // وقتی تخمین AI نداریم
const MAX_ESTIMATE = 480
const MAX_SCORE = 100

type OpenTask = {
    id: number
    estimatedTime: number | null
    score: number | null
    priority: "HIGH" | "MEDIUM" | "LOW"
    status: "TODO" | "IN_PROGRESS" | "DONE"
}

// تخمین امن (سقف تخصیص هر تسک)
export function estimateOf(t: Pick<OpenTask, "estimatedTime">): number {
    const v = t.estimatedTime ?? DEFAULT_ESTIMATE
    return Math.min(MAX_ESTIMATE, Math.max(5, v))
}

// وزن رقابت: فرمول توافقشده — w = تخمین × (0.5 + score/200)
export function weightOf(t: OpenTask): number {
    const est = estimateOf(t)
    const score = Math.min(MAX_SCORE, Math.max(0, t.score ?? 50))
    return est * (0.5 + score / 200)
}

export type DistItem = { id: number; weight: number; cap: number }
export type DistResult = {
    allocations: Record<number, number> // taskId -> دقیقه (فقط مقادیر مثبت)
    dropped: number[] // سهم زیر ۱۵ دقیقه → کاندیدای rollover
    pool: number // وقتِ توزیعنشده که به استخر برمیگرده
}

/**
 * توزیع بودجه بین تسکها:
 * - اگه مجموع سقفها ≤ بودجه → هر تسک دقیقاً تخمینش رو میگیره، مازاد → استخر.
 * - اگه کمبود بودجه هست (overbook) → توزیع تناسبیِ وزندار با سقف = تخمین؛
 *   سهمهای زیر ۱۵ دقیقه کنار گذاشته میشن (کماهمیتترین اول) و بودجهشون
 *   بین بقیه پخش میشه. نتیجه به مضرب ۵ گرد میشه.
 */
export function distribute(budget: number, items: DistItem[]): DistResult {
    const allocations: Record<number, number> = {}
    const dropped: number[] = []

    if (budget <= 0 || items.length === 0) {
        return { allocations, dropped: items.map((i) => i.id), pool: Math.max(0, budget) }
    }

    // مسیر سریع: ظرفیت کافیه
    const totalCap = items.reduce((s, i) => s + i.cap, 0)
    if (totalCap <= budget) {
        for (const it of items) allocations[it.id] = it.cap
        return { allocations, dropped, pool: budget - totalCap }
    }

    // کسایی که سقفشون از حداقلِ قابل قبول کمتره اصلاً رقابت نمیکنن
    for (const it of items) {
        if (it.cap < MIN_ALLOCATION) dropped.push(it.id)
    }
    let active = items.filter((i) => i.cap >= MIN_ALLOCATION)

    let remaining = budget
    let guard = 0

    while (active.length > 0 && remaining >= MIN_ALLOCATION && guard++ < 50) {
        const totalW = active.reduce((s, i) => s + i.weight, 0)
        if (totalW <= 0) break

        // سهم پیشنهادی (اعشاری)
        const proposed = new Map<number, number>()
        for (const it of active) proposed.set(it.id, (remaining * it.weight) / totalW)

        // ۱) سقف = تخمین: هر کی سهمش به سقفش رسید، فقط سقفش رو میگیره
        let cappedSum = 0
        const capped = new Set<number>()
        for (const it of active) {
            if (proposed.get(it.id)! >= it.cap) {
                allocations[it.id] = it.cap
                capped.add(it.id)
                cappedSum += it.cap
            }
        }
        if (capped.size > 0) {
            remaining -= cappedSum
            active = active.filter((i) => !capped.has(i.id))
            continue
        }

        // ۲) حداقل سهم: زیر ۱۵ → کنار بذار (کمترین وزن اول) و بودجهش رو پخش کن
        const small = active
            .filter((it) => proposed.get(it.id)! < MIN_ALLOCATION)
            .sort((a, b) => a.weight - b.weight || a.id - b.id)
        if (small.length > 0) {
            const smallIds = new Set<number>()
            for (const it of small) {
                smallIds.add(it.id)
                dropped.push(it.id)
                allocations[it.id] = 0
            }
            active = active.filter((i) => !smallIds.has(i.id))
            continue
        }

        // ۳) پایدار شد → گرد به مضرب ۵ و ثبت نهایی
        for (const it of active) {
            const share = Math.floor(proposed.get(it.id)! / GRANULARITY) * GRANULARITY
            allocations[it.id] = share
        }
        break
    }

    // بودجهی خردِ باقیمانده (< ۱۵) قابل توزیع نیست
    for (const it of active) {
        if (!(it.id in allocations)) {
            dropped.push(it.id)
            allocations[it.id] = 0
        }
    }

    const assigned = Object.values(allocations).reduce((a, b) => a + b, 0)
    return { allocations, dropped, pool: Math.max(0, budget - assigned) }
}

export type RebalanceOutput = {
    dayKey: string
    availableMinutes: number
    spentMinutes: number
    savedMinutes: number
    openBudgetMinutes: number
    committedMinutes: number
    poolMinutes: number
    overCommittedMinutes: number
    droppedTaskIds: number[] // → پیشنهاد rollover به UI
    allocations: { taskId: number; allocatedMinutes: number | null }[]
}

/**
 * بازتوزیع کامل یک روز. صدا زدنش امنه (idempotent):
 * همون ورودی → همون خروجی. بعد از هر رویداد (ساخت/حذف/اتمام/rollover) دوباره صدا زده میشه.
 *
 * قراردادها:
 * - بودجهی قابل توزیع = availableMinutes − Σ زمانِ واقعیِ مصرفشده (تسکهای DONE همین روز)
 * - تسکهای DONE هرگز تغییر نمیکنن (تخصیصشون سند تاریخیِ «زمان سیو شده»ئه)
 * - تسک IN_PROGRESS که تخصیص گرفته، محافظت میشه و سهمش کم نمیشه
 * - بدون پلن یا بودجهی صفر → دست نمیزنیم (وضعیت «برنامهریزی نشده»)
 * - خروجی `allocatedMinutes` هیچوقت صفر نیست؛ یا مثبته یا null
 */
export async function rebalanceDay(userId: number, dayKey: string): Promise<RebalanceOutput> {
    const prisma = getPrisma()

    const [plan, tasks] = await Promise.all([
        prisma.dailyPlan.findUnique({ where: { userId_dayKey: { userId, dayKey } } }),
        prisma.task.findMany({ where: { userId, dayKey } }),
    ])

    const done = tasks.filter((t) => t.status === "DONE")
    const open = tasks.filter((t) => t.status !== "DONE")

    const availableMinutes = plan?.availableMinutes ?? 0
    const spentMinutes = done.reduce((s, t) => s + (t.spentMinutes ?? 0), 0)
    const savedMinutes = done.reduce((s, t) => s + savedForTask(t), 0)
    const openBudgetMinutes = Math.max(0, availableMinutes - spentMinutes)

    // بدون پلن یا بودجهی صفر → توزیع معنی نداره
    if (!plan || availableMinutes <= 0) {
        const committedMinutes = open.reduce((s, t) => s + (t.allocatedMinutes ?? 0), 0)
        return {
            dayKey,
            availableMinutes,
            spentMinutes,
            savedMinutes,
            openBudgetMinutes,
            committedMinutes,
            poolMinutes: 0,
            overCommittedMinutes: Math.max(0, committedMinutes - openBudgetMinutes),
            droppedTaskIds: [],
            allocations: open.map((t) => ({ taskId: t.id, allocatedMinutes: t.allocatedMinutes })),
        }
    }

    // حفاظت از تسکهای در حال اجرا (سهم فعلیشون ثابت میمونه)
    const protectedIds = new Set(
        open
            .filter((t) => t.status === "IN_PROGRESS" && t.allocatedMinutes != null)
            .map((t) => t.id),
    )
    const protectedSum = open.reduce(
        (s, t) => s + (protectedIds.has(t.id) ? (t.allocatedMinutes ?? 0) : 0),
        0,
    )

    const todoItems = open
        .filter((t) => !protectedIds.has(t.id))
        .map((t) => ({ id: t.id, weight: weightOf(t), cap: estimateOf(t) }))

    const { allocations, dropped, pool } = distribute(
        Math.max(0, openBudgetMinutes - protectedSum),
        todoItems,
    )

    // ذخیرهی نتیجه فقط برای تسکهای بازِ غیرمحافظتشده
    const updates = open
        .filter((t) => !protectedIds.has(t.id))
        .map((t) =>
            prisma.task.update({
                where: { id: t.id },
                data: { allocatedMinutes: allocations[t.id] ? allocations[t.id] : null },
            }),
        )
    if (updates.length > 0) await prisma.$transaction(updates)

    const finalAllocations = open.map((t) => ({
        taskId: t.id,
        allocatedMinutes: protectedIds.has(t.id)
            ? t.allocatedMinutes
            : allocations[t.id] ?? null,
    }))
    const committedMinutes = finalAllocations.reduce(
        (s, a) => s + (a.allocatedMinutes ?? 0),
        0,
    )

    return {
        dayKey,
        availableMinutes,
        spentMinutes,
        savedMinutes,
        openBudgetMinutes,
        committedMinutes,
        poolMinutes: pool,
        overCommittedMinutes: Math.max(0, committedMinutes - openBudgetMinutes),
        droppedTaskIds: dropped,
        allocations: finalAllocations,
    }
}
