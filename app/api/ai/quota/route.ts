import { requireVerifiedUser } from "@/app/lib/requireVerifiedUser"
import { getPrisma } from "@/app/lib/getPrisma"
import { readAiQuotaStatus } from "@/app/lib/services/aiQuotaStatus.service"
import {
    errorResponse,
    okResponse,
    toServiceErrorResponse,
    unauthorizedResponse,
} from "@/app/lib/apiResponse"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

// GET /api/ai/quota — وضعیت سهمیهٔ AI کاربر جاری (فقط خواندنی)
//
// قواعد امنیتیِ عمدی:
//   • `userId` **فقط** از `getCurrentUser()` می‌آید. این route هیچ `searchParams` یا
//     بدنه‌ای نمی‌خواند، پس «دیدن سهمیهٔ کاربر دیگر» از این مسیر اصلاً قابل بیان نیست.
//   • هیچ متد mutationی ندارد. هیچ `POST`/`PATCH`/`DELETE`‌ای صادر نمی‌شود؛ تغییر
//     سهمیه فقط از مسیر reserve/complete/release و از ادمین است.
//   • با APIهای ادمین قاطی نشده: نه `requireAdmin` دارد و نه داده‌ای از ادمین.
//   • پاسخ فقط شماره‌های لازم برای UI را دارد — نه `bucketId`، نه `requestId`، نه
//     `policyAllowedUnits`، نه ردیف audit.
//
// این endpoint هیچ analytics/touch/product-event نمی‌نویسد: یک مسیر نمایشِ
// read-only است و نباید الگوی DB write اضافه کند.
export async function GET() {
    const context = createObservabilityContext("/api/ai/quota", "ai")
    try {
        const user = await requireVerifiedUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        const status = await readAiQuotaStatus(getPrisma(), {
            userId: user.id,
            // پلن مؤثر و سرور-محور (نتیجهٔ entitlement، نه آینهٔ `User.plan`)
            plan: user.plan,
            timezone: user.timezone ?? "UTC",
        })

        return okResponse(status, { requestId: context.requestId })
    } catch (error) {
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        await recordError(error, context)
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
