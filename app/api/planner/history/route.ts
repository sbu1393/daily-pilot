import { NextRequest, NextResponse } from "next/server"
import { getPrisma } from "@/app/lib/getPrisma"
import { getCurrentUser } from "@/app/lib/getCurrentUser"

// GET /api/planner/history?from=1403-05-01&to=1403-05-31
// کلیدهای جلالی صفر-پد هستن → مقایسهی رشتهای from/to درسته
export async function GET(req: NextRequest) {
    try {
        const user = await getCurrentUser()
        if (!user) return NextResponse.json({ message: "Unauthorized" }, { status: 401 })

        const from = req.nextUrl.searchParams.get("from")
        const to = req.nextUrl.searchParams.get("to")
        if (!from || !to || from > to) {
            return NextResponse.json({ message: "بازهی نامعتبر" }, { status: 400 })
        }

        const tasks = await getPrisma().task.findMany({
            where: {
                userId: user.id,
                status: "DONE",
                completedOn: { gte: from, lte: to },
            },
            select: { completedOn: true, allocatedMinutes: true, spentMinutes: true },
        })

        // گروهبندی در JS — چون max(0, allocated−spent) با groupBy جمعپذیر نیست
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

        const markers = Array.from(map, ([dayKey, m]) => ({ dayKey, ...m }))
        return NextResponse.json({ data: markers })
    } catch (error) {
        console.error("HISTORY ERROR:", error)
        return NextResponse.json({ message: "Server error" }, { status: 500 })
    }
}
