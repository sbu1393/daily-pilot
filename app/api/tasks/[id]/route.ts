import { NextRequest, NextResponse } from "next/server"
import { getPrisma } from "@/app/lib/getPrisma"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { rebalanceDay } from "@/app/lib/planner/rebalance"

export async function DELETE(
    _req: NextRequest,
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

        const prisma = getPrisma()
        const task = await prisma.task.findFirst({ where: { id: taskId, userId: user.id } })
        if (!task) return NextResponse.json({ message: "تسک پیدا نشد" }, { status: 404 })

        await prisma.task.delete({ where: { id: task.id } })

        // اگه تسک باز بوده، سهمش به استخرِ همون روز برمیگرده


        let summary = null

        if (task.status !== "DONE") {
            if (!task.dayKey) {
                return NextResponse.json(
                    { message: "تاریخ برنامه‌ریزی تسک نامعتبر است" },
                    { status: 400 }
                )
            }
        
            summary = await rebalanceDay(user.id, task.dayKey)
        }


        return NextResponse.json(
            { message: "تسک حذف شد", data: { id: task.id, summary } },
            { status: 200 },
        )
    } catch (error) {
        console.error("DELETE TASK ERROR:", error)
        return NextResponse.json({ message: "Server error" }, { status: 500 })
    }
}
