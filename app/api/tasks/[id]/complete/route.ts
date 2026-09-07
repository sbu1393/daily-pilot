import { NextRequest, NextResponse } from "next/server"
import { getPrisma } from "@/app/lib/getPrisma"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { rebalanceDay } from "@/app/lib/planner/rebalance"
import { fromDayKey, todayKey } from "../../../../lib/jalili"
import { completeTaskSchema } from "@/app/schema/plannerSchema"

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> },
) {
    try {
        const user = await getCurrentUser()
        if (!user) return NextResponse.json({ message: "Unauthorized" }, { status: 401 })

        const { id } = await params
        const taskId = Number(id)
        if (!Number.isInteger(taskId) || taskId <= 0) {
            return NextResponse.json({ message: "شناسه نامعتبر است" }, { status: 400 })
        }

        const body = await req.json()
        const parsed = completeTaskSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json(
                { message: "اطلاعات نامعتبر است", errors: parsed.error.flatten() },
                { status: 400 },
            )
        }
        const { durationMinutes } = parsed.data

        const prisma = getPrisma()
        const task = await prisma.task.findFirst({ where: { id: taskId, userId: user.id } })



        if (!task) return NextResponse.json({ message: "تسک پیدا نشد" }, { status: 404 })
        if (task.status === "DONE") {
            return NextResponse.json({ message: "این تسک قبلاً تمام شده است" }, { status: 400 })
        }

        const oldDayKey = task.dayKey

        if (!oldDayKey) {
            return NextResponse.json(
                { message: "تاریخ برنامه‌ریزی تسک نامعتبر است" },
                { status: 400 }
            )
        }

        const targetDayKey = todayKey() // تسک همیشه روی «روز اتمامِ واقعی» بسته میشه

        // مقایسه با تخصیص → سیو شده یا بیشمصرفی
        const allocated = task.allocatedMinutes ?? task.estimatedTime ?? durationMinutes
        const savedMinutes = Math.max(0, allocated - durationMinutes)
        const overspentMinutes = Math.max(0, durationMinutes - allocated)

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
            spentMinutes: durationMinutes,
            completedAt: new Date(),
            completedOn: targetDayKey,
        }

        // اگه تسک هیچ تخصیصی نداشت، پایه رو ذخیره کن تا مارکرها/تاریخچه با همین جواب یکی باشن
        if (task.allocatedMinutes == null) {
            data.allocatedMinutes = allocated
        }


        // تسک از روز دیگهای مونده بود → اول به امروز منتقل میشه تا حسابداری درست باشه
        if (oldDayKey !== targetDayKey) {
            data.dayKey = targetDayKey
            data.scheduledDate = fromDayKey(targetDayKey)
            data.previousScheduledDate = fromDayKey(oldDayKey)
        }


        const updated = await prisma.task.update({ where: { id: task.id }, data })

        // بازتوزیع روزهای متأثر (زمان آزادشده بین بقیه پخش میشه یا تریم میشن)
        const affectedDays = new Set<string>([oldDayKey, targetDayKey])
        const summaries: Record<string, unknown> = {}
        for (const dayKey of affectedDays) {
            summaries[dayKey] = await rebalanceDay(user.id, dayKey)
        }

        return NextResponse.json(
            {
                data: updated,
                result: { savedMinutes, overspentMinutes },
                summaries,
            },
            { status: 200 },
        )
    } catch (error) {
        console.error("COMPLETE TASK ERROR:", error)
        return NextResponse.json({ message: "Server error" }, { status: 500 })
    }
}
