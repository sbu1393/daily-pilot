import { NextResponse } from "next/server"
import { analyzeTask } from "@/app/lib/ai/analyzeTask"
import { getCurrentUser } from "@/app/lib/getCurrentUser"

export async function GET() {
    // این اندپوینت هر بار چند فراخوانی AI انجام می‌دهد → فقط برای کاربران واردشده
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ message: "Unauthorized" }, { status: 401 })

    const samples = [
        "گزارش فوری پروژه مشتری را آماده کن",
        "خرید نان از نانوایی",
        "تمرین زبان برای آزمون هفته بعد",
    ]

    const results = []
    for (const text of samples) {
        results.push(await analyzeTask(text))
    }

    return NextResponse.json(results)
}
