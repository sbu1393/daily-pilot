import { NextRequest, NextResponse } from "next/server"
import { getPrisma } from "@/app/lib/getPrisma"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { analyzeTask } from "../../lib/ai/analyzeTask"
import { rebalanceDay } from "@/app/lib/planner/rebalance"
import { getDaySummary } from "@/app/lib/planner/summary"
import { fromDayKey, todayKey } from "../../lib/jalili"
import { createTaskSchema } from "@/app/schema/plannerSchema"

// POST: ساخت تسک → تحلیل AI → ذخیره → بازتوزیع بودجهی روز
export async function POST(req: NextRequest) {
    try {
        const user = await getCurrentUser()
        if (!user) return NextResponse.json({ message: "Unauthorized" }, { status: 401 })

        const body = await req.json()
        const parsed = createTaskSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json(
                { message: "اطلاعات نامعتبر است", errors: parsed.error.flatten() },
                { status: 400 },
            )
        }

        const { text, dayKey } = parsed.data
        const prisma = getPrisma()

        // ۱) تحلیل با هوش مصنوعی (اگه کلید نباشه → Mock)
        const { source, analysis } = await analyzeTask(text)

        // ۲) ذخیرهی تسک
        const task = await prisma.task.create({
            data: {
                text,
                dayKey,
                category: analysis.category,
                priority: analysis.priority,
                score: analysis.score,
                reason: analysis.reason,
                estimatedTime: analysis.estimatedMinutes,
                scheduledDate: fromDayKey(dayKey), // لحظهی نیمهشب تهران
                userId: user.id,
            },
        })

        // ۳) بازتوزیع (اگه روز پلن و بودجهی مثبت داشته باشه، وگرنه دست نمیزنه)
        const summary = await rebalanceDay(user.id, dayKey)

        return NextResponse.json({ data: task, aiSource: source, summary }, { status: 201 })
    } catch (error) {
        console.error("CREATE TASK ERROR:", error)
        return NextResponse.json({ message: "Server error" }, { status: 500 })
    }
}

// GET: تسکهای یک روز + خلاصه (پیشفرض: امروز)
export async function GET(req: NextRequest) {
    try {
        const user = await getCurrentUser()
        if (!user) return NextResponse.json({ message: "Unauthorized" }, { status: 401 })

        const dayKey = req.nextUrl.searchParams.get("dayKey") ?? todayKey()
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
            return NextResponse.json({ message: "فرمت روز نامعتبر است" }, { status: 400 })
        }

        const prisma = getPrisma()
        const tasks = await prisma.task.findMany({ where: { userId: user.id, dayKey } })

        // مرتبسازی: انجامشدهها آخر، بعد بر اساس score نزولی
        tasks.sort((a, b) => {
            const doneA = a.status === "DONE" ? 1 : 0
            const doneB = b.status === "DONE" ? 1 : 0
            if (doneA !== doneB) return doneA - doneB
            return (b.score ?? -1) - (a.score ?? -1) || a.createdAt.getTime() - b.createdAt.getTime()
        })

        const summary = await getDaySummary(user.id, dayKey)

        return NextResponse.json({ data: tasks, summary }, { status: 200 })
    } catch (error) {
        console.error("GET TASKS ERROR:", error)
        return NextResponse.json({ message: "Server error" }, { status: 500 })
    }
}
