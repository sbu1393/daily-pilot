// فاز ۵ — گام ۱۲: Subscription/entitlement read route (سند §25، §16، §17، §27، §33)
//
// جریان LOCKED (سند §25 «GET /api/billing/subscription»):
//   authentication → service read (lazy expiration + effective plan) → پاسخ امن
//
// مرزها:
// - route نازک است و هیچ منطق دامنه‌ای ندارد (سند §27): انقضای lazy و resolve شدن effective plan
//   فقط داخل `entitlement.service` (از طریق `billing.service.getSubscriptionView`) انجام می‌شود.
// - هیچ provider callی وجود ندارد؛ تنها mutation ممکن همان materialize شدن `ACTIVE→EXPIRED` +
//   `User.plan=FREE` در lazy expiration است (سند §17).
// - پاسخ فقط فیلدهای امن D1/§25 است: plan · entitlement(status/provider/دوره‌ی جاری) · renewal.
//   هیچ شناسه‌ی حساسی (Entitlement.id، userId، authority، reference، شناسه‌ی سفارش/کاربر) برنمی‌گردد
//   و هیچ provider payload/secret/cookie/Authorization لاگ نمی‌شود (سند §33).
// - کاربر بدون entitlement یا FREE یک پاسخ 200 با `entitlement: null` می‌گیرد — هرگز 404 (D3).
// - rate limit اعمال نمی‌شود: Blueprint برای این route عددی تعیین نکرده است (A6).
// - خارج از scope این گام: schema/migration، frontend، quota، admin و هر تغییر در
//   checkout/callback/finalizeVerifiedPayment.

import { NextRequest } from "next/server"

import { getCurrentUser } from "@/app/lib/getCurrentUser"
import { getPrisma } from "@/app/lib/getPrisma"
import { errorResponse, okResponse, toServiceErrorResponse, unauthorizedResponse } from "@/app/lib/apiResponse"
import { getSubscriptionView } from "@/app/lib/services/billing.service"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"

// GET /api/billing/subscription — نمای خواندنی و امن وضعیت اشتراک/دسترسی کاربر (سند §25)
export async function GET(_req: NextRequest) {
    const context = createObservabilityContext("/api/billing/subscription", "billing")
    try {
        // ۱) authentication — نبود نشست → همان 401 موجود
        const user = await getCurrentUser()
        if (!user) return unauthorizedResponse(context.requestId)
        context.userId = user.id

        // ۲) خواندن وضعیت: lazy expiration + effective plan از entitlement.service (سند §16/§17/§27)
        const view = await getSubscriptionView(getPrisma(), user.id)

        // ۳) پاسخ امن در همان envelope موجود (ADR-04)
        return okResponse(view, { requestId: context.requestId })
    } catch (error) {
        await recordError(error, context)
        const mapped = toServiceErrorResponse(error, context.requestId)
        if (mapped) return mapped
        return errorResponse(500, "INTERNAL", "Server error", undefined, context.requestId)
    }
}
