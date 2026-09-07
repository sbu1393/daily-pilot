import { NextRequest, NextResponse } from "next/server"
import { getPrisma } from "@/app/lib/getPrisma"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { analyzeTask } from "@/app/lib/ai/analyzeTask"
import { rebalanceDay } from "@/app/lib/planner/rebalance"
import { todayKey } from "../../../../lib/jalili"
import { reanalyzeTaskSchema } from "@/app/schema/plannerSchema"

// این route هوش مصنوعی را صدا می‌زند؛ روی Vercel وقت بیشتری لازم دارد (روی self-host بی‌اثر است)
export const maxDuration = 60

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

        const body = await req.json().catch(() => ({}))
        const parsed = reanalyzeTaskSchema.safeParse(body)
        if (!parsed.success) {
            return NextResponse.json(
                { message: "اطلاعات نامعتبر است", errors: parsed.error.flatten() },
                { status: 400 },
            )
        }
        const { text: textOverride } = parsed.data

        const prisma = getPrisma()
        const task = await prisma.task.findFirst({ where: { id: taskId, userId: user.id } })
        if (!task) return NextResponse.json({ message: "تسک پیدا نشد" }, { status: 404 })

        // فقط TODO قابل تحلیل مجدد است — DONE تاریخچه را می‌سازد و IN_PROGRESS سهمش محافظت شده
        if (task.status !== "TODO") {
            const message =
                task.status === "DONE"
                    ? "تسک انجام‌شده را نمی‌توان دوباره تحلیل کرد"
                    : "تسک در حال انجام را نمی‌توان دوباره تحلیل کرد"
            return NextResponse.json({ message }, { status: 400 })
        }

        // تسک عقب‌افتاده؟ اول باید به امروز منتقل شود تا بازتوزیع روی روز درست انجام شود
        if (!task.dayKey) {
            return NextResponse.json(
                { message: "تاریخ برنامه‌ریزی تسک نامعتبر است" },
                { status: 400 }
            )
        }


        if (task.dayKey < todayKey()) {
            return NextResponse.json(
                { message: "این تسک مربوط به روزهای گذشته است؛ اول آن را به امروز منتقل کن." },
                { status: 400 },
            )
        }

        const newText = (textOverride ?? task.text).trim()
        const { source, analysis } = await analyzeTask(newText)

        const updated = await prisma.task.update({
            where: { id: task.id },
            data: {
                text: newText,
                priority: analysis.priority,
                score: analysis.score,
                reason: analysis.reason,
                category: analysis.category,
                estimatedTime: analysis.estimatedMinutes,
            },
        })

        // توزیع دوباره: با تخمین/امتیاز جدید، سهم‌ها بازچینش می‌شوند (روز بی‌بودجه دست نمی‌خورد)

        const summary = await rebalanceDay(user.id, task.dayKey)

        return NextResponse.json({ data: updated, aiSource: source, summary }, { status: 200 })
    } catch (error) {
        console.error("RE-ANALYZE TASK ERROR:", error)
        return NextResponse.json({ message: "Server error" }, { status: 500 })
    }
}
