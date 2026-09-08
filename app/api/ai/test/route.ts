import { NextResponse } from "next/server"
import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { runAiSamples } from "@/app/lib/services/analysis.service"
import { unauthorizedResponse } from "@/app/lib/apiResponse"

export async function GET() {
    // این اندپوینت هر بار چند فراخوانی AI انجام می‌دهد → فقط برای کاربران واردشده
    const user = await getCurrentUser()
    if (!user) return unauthorizedResponse()

    const results = await runAiSamples()

    return NextResponse.json(results)
}