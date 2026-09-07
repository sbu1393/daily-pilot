import { NextRequest, NextResponse } from "next/server"
import { getPrisma } from "@/app/lib/getPrisma"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { rebalanceDay } from "@/app/lib/planner/rebalance"
import { getDaySummary } from "@/app/lib/planner/summary"
import { todayKey } from "../../../lib/jalili"
import { dayPlanSchema } from "@/app/schema/plannerSchema"

// GET: خلاصهی روز (بودجه / تخصیص / وقت آزاد / سیو شده)
export async function GET(req: NextRequest) {
    try {
        const user = await getCurrentUser()
        if (!user) return NextResponse.json({ message: "Unauthorized" }, { status: 401 })

        const dayKey = req.nextUrl.searchParams.get("dayKey") ?? todayKey()
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
            return NextResponse.json({ message: "فرمت روز نامعتبر است" }, { status: 400 })
        }

        const summary = await getDaySummary(user.id, dayKey)
        return NextResponse.json({ summary }, { status: 200 })
    } catch (error) {
        console.error("GET DAY SUMMARY ERROR:", error)
        return NextResponse.json({ message: "Server error" }, { status: 500 })
    }
}

// POST: تنظیم/ویرایش بودجهی روز + بازتوزیع
export async function POST(req: NextRequest) {
    try {
        const user = await getCurrentUser()
        if (!user) return NextResponse.json({ message: "Unauthorized" }, { status: 401 })

        const body = await req.json()
        const parsed = dayPlanSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json(
                { message: "اطلاعات نامعتبر است", errors: parsed.error.flatten() },
                { status: 400 },
            )
        }

        const { dayKey, availableMinutes } = parsed.data
        const prisma = getPrisma()

        const plan = await prisma.dailyPlan.upsert({
            where: { userId_dayKey: { userId: user.id, dayKey } },
            create: { userId: user.id, dayKey, availableMinutes },
            update: { availableMinutes },
        })

        const summary = await rebalanceDay(user.id, dayKey)

        return NextResponse.json({ data: plan, summary }, { status: 200 })
    } catch (error) {
        console.error("SET DAY PLAN ERROR:", error)
        return NextResponse.json({ message: "Server error" }, { status: 500 })
    }
}
