import { NextRequest } from "next/server"
import { errorResponse, okResponse, toServiceErrorResponse } from "@/app/lib/apiResponse"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import { authorizeCronRequest, CRON_SECRET_ENV } from "@/app/lib/push/cronAuth"
import { runReminderScheduler } from "@/app/lib/services/reminderScheduler.service"

// ADR-07 فاز ۳-B — endpoint زمان‌بند Reminder.
// این endpoint توسط scheduler خارجی (Cron پلتفرم/GitHub Actions/cron-job) دوره‌ای صدا زده
// می‌شود و یک batch یادآوری‌های due را ارسال می‌کند. هیچ ناحیه‌ی عمومی/بدون‌secret ندارد.
// منطق ارسال این‌جا نیست؛ route نازک است (ADR-02) و همه‌چیز در reminderScheduler.service است.
//
// این runtime صریحاً Node است: `web-push` به crypto نود نیاز دارد (edge runtime پشتیبانی نمی‌شود).
export const runtime = "nodejs"
export const maxDuration = 60

async function handle(req: NextRequest) {
    const context = createObservabilityContext("/api/push/cron", "push")
    try {
        const auth = authorizeCronRequest(req.headers, process.env[CRON_SECRET_ENV])
        if (!auth.ok) {
            return errorResponse(auth.status, auth.code, auth.message, undefined, context.requestId)
        }

        const summary = await runReminderScheduler()

        return okResponse(summary, { requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}

// برخی schedulerها GET و برخی POST می‌فرستند — هر دو با همان محافظت secret.
export const GET = handle
export const POST = handle
