import { NextRequest, NextResponse } from "next/server"
import { getPrisma } from "@/app/lib/getPrisma"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { rebalanceDay } from "@/app/lib/planner/rebalance"
import { fromDayKey, shiftDayKey, todayKey } from "../../../lib/jalili"
import { rolloverSchema } from "@/app/schema/plannerSchema"

export async function POST(req: NextRequest) {
    try {
        const user = await getCurrentUser()
        if (!user) return NextResponse.json({ message: "Unauthorized" }, { status: 401 })

        const body = await req.json()
        const parsed = rolloverSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json(
                { message: "اطلاعات نامعتبر است", errors: parsed.error.flatten() },
                { status: 400 },
            )
        }
        const { taskIds } = parsed.data

        const prisma = getPrisma()
        const tasks = await prisma.task.findMany({
            where: { id: { in: taskIds }, userId: user.id, status: { not: "DONE" } },
        })

        // فقط تسک‌هایی که روز برنامه‌ریزی دارند قابل انتقال‌اند
        const schedulable = tasks.filter(
            (t): t is (typeof tasks)[number] & { dayKey: string } => t.dayKey != null,
        )

        if (schedulable.length === 0) {
            return NextResponse.json({ message: "تسکی برای انتقال پیدا نشد" }, { status: 404 })
        }

        const today = todayKey()
        const affectedDays = new Set<string>()
        const moved: { id: number; from: string; to: string }[] = []

        await prisma.$transaction(
            schedulable.map((task) => {
                const from = task.dayKey
                // عقب‌افتاده → امروز؛ تسک امروز/آینده → فردا
                const to = from < today ? today : shiftDayKey(from, 1)
                affectedDays.add(from)
                affectedDays.add(to)
                moved.push({ id: task.id, from, to })
                return prisma.task.update({
                    where: { id: task.id },
                    data: {
                        dayKey: to,
                        scheduledDate: fromDayKey(to),
                        previousScheduledDate: task.scheduledDate,
                        allocatedMinutes: null, // تخصیص در روز مقصد دوباره تصمیم گرفته میشه
                    },
                })
            }),
        )

        // بازتوزیع روزهای متأثر (اگه پلن نداشته باشن، موتور دست نمیزنه)
        const summaries: Record<string, unknown> = {}
        for (const dayKey of affectedDays) {
            summaries[dayKey] = await rebalanceDay(user.id, dayKey)
        }

        return NextResponse.json(
            { message: "انتقال انجام شد", data: { moved, summaries } },
            { status: 200 },
        )
    } catch (error) {
        console.error("ROLLOVER ERROR:", error)
        return NextResponse.json({ message: "Server error" }, { status: 500 })
    }
}
