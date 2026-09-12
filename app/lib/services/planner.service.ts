import { getPrisma } from "@/app/lib/getPrisma"
import { getDaySummary as getPlannerSummary, type DaySummary } from "@/app/lib/planner/summary"
import { ensureDayRebalanced, type RebalanceOutput } from "@/app/lib/planner/rebalance"
import { suggestDay } from "@/app/lib/planner/suggestion"
import type { DailyPlan } from "@prisma/client"

// خلاصه‌ی روز — A3 (ADR-03): ورود به نمای روز اول stale بودن را بررسی و در صورت نیاز
// Rebalance را اجرا می‌کند، سپس خلاصه را از همان تابع دامنه‌ی موجود می‌گیرد.
export async function getDaySummary(userId: number, dayKey: string): Promise<DaySummary> {
    await ensureDayRebalanced(userId, dayKey)
    return getPlannerSummary(userId, dayKey)
}

// ---------- تنظیم بودجه‌ی روز — mutation مؤثر بر برنامه → bump اتمیک ----------
export async function setDayPlan(
    userId: number,
    dayKey: string,
    availableMinutes: number,
): Promise<{ plan: DailyPlan; summary: RebalanceOutput | null }> {
    const prisma = getPrisma()

    // §6.3.3: ساخت در مسیر mutation → planVersion از 1 شروع می‌شود (همان mutation اولین bump است)
    // و rebalancedVersion = null می‌ماند → read بعدی آن را stale تشخیص داده و Rebalance می‌کند.
    const plan = await prisma.dailyPlan.upsert({
        where: { userId_dayKey: { userId, dayKey } },
        create: { userId, dayKey, availableMinutes, planVersion: 1 },
        update: { availableMinutes, planVersion: { increment: 1 } },
    })

    // A3: بازتوزیع lazy است — read بعدی stale را تشخیص داده و Rebalance را اجرا می‌کند
    return { plan, summary: null }
}

// ---------- ADR-006 (Phase S2) — پیشنهاد روز: فقط خواندنی، بدون persist، بدون AI ----------
// ورود به نمای روز → اول lazy rebalance (همان read path خلاصه) تا تخصیص‌های فعلی
// به‌روز باشند؛ سپس موتورِ خالص suggestDay روی وضعیت فعلی اجرا می‌شود.
export type DaySuggestionResponse = ReturnType<typeof suggestDay> & {
    dayKey: string
}

export async function getDaySuggestion(
    userId: number,
    dayKey: string,
): Promise<DaySuggestionResponse> {
    await ensureDayRebalanced(userId, dayKey)

    const prisma = getPrisma()
    const [plan, tasks] = await Promise.all([
        prisma.dailyPlan.findUnique({
            where: { userId_dayKey: { userId, dayKey } },
            select: { availableMinutes: true },
        }),
        prisma.task.findMany({
            where: { userId, dayKey },
            select: {
                id: true,
                estimatedTime: true,
                score: true,
                priority: true,
                status: true,
            },
        }),
    ])

    const suggestion = suggestDay(plan?.availableMinutes ?? 0, tasks)

    return { dayKey, ...suggestion }
}

export type HistoryMarker = {
    dayKey: string
    doneCount: number
    savedMinutes: number
    overspentMinutes: number
}

// ---------- مارکرهای تاریخچه (DONE در بازه) — گروه‌بندی در JS ----------
export async function getHistoryMarkers(
    userId: number,
    from: string,
    to: string,
): Promise<HistoryMarker[]> {
    const tasks = await getPrisma().task.findMany({
        where: {
            userId,
            status: "DONE",
            completedOn: { gte: from, lte: to },
        },
        select: { completedOn: true, allocatedMinutes: true, spentMinutes: true },
    })

    // گروه‌بندی در JS — چون max(0, allocated−spent) با groupBy جمع‌پذیر نیست
    const map = new Map<string, { doneCount: number; savedMinutes: number; overspentMinutes: number }>()
    for (const t of tasks) {
        const key = t.completedOn!
        const entry = map.get(key) ?? { doneCount: 0, savedMinutes: 0, overspentMinutes: 0 }
        entry.doneCount += 1
        const allocated = t.allocatedMinutes ?? 0
        const spent = t.spentMinutes ?? 0
        entry.savedMinutes += Math.max(0, allocated - spent)
        entry.overspentMinutes += Math.max(0, spent - allocated)
        map.set(key, entry)
    }

    return Array.from(map, ([dayKey, m]) => ({ dayKey, ...m }))
}