import { NextRequest, NextResponse } from "next/server"
import { getPrisma } from "@/app/lib/getPrisma"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { todayKey } from "../../../lib/jalili"

// GET /api/tasks/overdue → تسک‌های بازِ روزهای گذشته (کاندیدای انتقال به امروز)
// برخلاف GET /api/tasks که بدون dayKey فقط «امروز» را می‌دهد، این اندپوینت
// تمام تسک‌های ناتمامِ روزهای قبل را برمی‌گرداند تا بنر rollover واقعاً کار کند.
export async function GET(_req: NextRequest) {
    try {
        const user = await getCurrentUser()
        if (!user) return NextResponse.json({ message: "Unauthorized" }, { status: 401 })

        const today = todayKey()
        const tasks = await getPrisma().task.findMany({
            where: {
                userId: user.id,
                status: { not: "DONE" },
                dayKey: { lt: today },
            },
            orderBy: { dayKey: "desc" },
        })

        return NextResponse.json({ data: tasks }, { status: 200 })
    } catch (error) {
        console.error("GET OVERDUE TASKS ERROR:", error)
        return NextResponse.json({ message: "Server error" }, { status: 500 })
    }
}