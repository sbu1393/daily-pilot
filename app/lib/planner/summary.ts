import { getPrisma } from "@/app/lib/getPrisma"

// زمان سیو شده برای یک تسک تمامشده (فقط گزارش — توی بودجه دوبار حساب نمیشه)
export function savedForTask(t: {
    allocatedMinutes: number | null
    spentMinutes: number | null
}): number {
    if (t.allocatedMinutes == null || t.spentMinutes == null) return 0
    return Math.max(0, t.allocatedMinutes - t.spentMinutes)
}

// بیشمصرفی (زمانی که واقعاً بیشتر از تخصیص طول کشیده)
export function overspentForTask(t: {
    allocatedMinutes: number | null
    spentMinutes: number | null
}): number {
    if (t.allocatedMinutes == null || t.spentMinutes == null) return 0
    return Math.max(0, t.spentMinutes - t.allocatedMinutes)
}

export type DaySummary = {
    dayKey: string
    hasPlan: boolean
    availableMinutes: number // بودجهی اعلامی کاربر
    spentMinutes: number // زمان واقعیِ مصرفشده (تسکهای DONE امروز)
    savedMinutes: number // سیو شدهی امروز (گزارشی)
    committedMinutes: number // جمع تخصیص تسکهای باز
    openBudgetMinutes: number // بودجهی قابل توزیع بین تسکهای باز
    overspentMinutes: number // بیشمصرفی امروز (گزارشی)
    poolMinutes: number // وقتِ واقعاً آزاد برای تسک جدید
    overCommittedMinutes: number // اگه بیشتر از بودجه تخصیص خورده (هشدار)
    totalTasks: number
    doneTasks: number
    openTasks: number
}

export async function getDaySummary(userId: number, dayKey: string): Promise<DaySummary> {
    const prisma = getPrisma()

    // تسکهای بازِ این روز (بر اساس روز برنامهریزی)
    // تسکهای تمامشدهی این روز (بر اساس روز واقعی اتمام — مثل تاریخچه)
    const [plan, openTasks, doneTasks] = await Promise.all([
        prisma.dailyPlan.findUnique({ where: { userId_dayKey: { userId, dayKey } } }),
        prisma.task.findMany({
            where: { userId, dayKey, status: { not: "DONE" } },
        }),
        prisma.task.findMany({
            where: { userId, completedOn: dayKey, status: "DONE" },
        }),
    ])

    const spentMinutes = doneTasks.reduce((s, t) => s + (t.spentMinutes ?? 0), 0)
    const savedMinutes = doneTasks.reduce((s, t) => s + savedForTask(t), 0)
    const overspentMinutes = doneTasks.reduce(
        (s, t) => s + overspentForTask(t),
        0,
    )
    const committedMinutes = openTasks.reduce((s, t) => s + (t.allocatedMinutes ?? 0), 0)

    const availableMinutes = plan?.availableMinutes ?? 0
    const openBudgetMinutes = Math.max(0, availableMinutes - spentMinutes)
    const poolMinutes = Math.max(0, openBudgetMinutes - committedMinutes)
    const overCommittedMinutes = Math.max(0, committedMinutes - openBudgetMinutes)

    return {
        dayKey,
        hasPlan: !!plan,
        availableMinutes,
        spentMinutes,
        savedMinutes,
        committedMinutes,
        overspentMinutes,
        openBudgetMinutes,
        poolMinutes,
        overCommittedMinutes,
        totalTasks: openTasks.length + doneTasks.length,
        doneTasks: doneTasks.length,
        openTasks: openTasks.length,

    }
}

// کل زمان سیو شدهی کاربر در تمام روزها (برای هدرِ لایو — فقط گزارش)
export async function getTotalSaved(userId: number): Promise<number> {
    const prisma = getPrisma()
    const done = await prisma.task.findMany({
        where: { userId, status: "DONE" },
        select: { allocatedMinutes: true, spentMinutes: true },
    })
    return done.reduce((s, t) => s + savedForTask(t), 0)
}
