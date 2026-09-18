// فاز ۴ — Step 7: Admin Frontend — لایه‌ی DTO سمت کلاینت
//
// این تایپ‌ها قرارداد قفل‌شده‌ی Step 6 (admin.query.ts + routeها) را آینه می‌کنند.
// قرارداد ADR-04: موفقیت { ok, data }؛ خطا { ok:false, error:{ code, message } }.
// UI فقط با allowlist مصرف می‌کند و object خام Prisma هرگز render نمی‌شود —
// password/hash/JWT/phone/secret/prompt/raw AI response/payment هرگز در تایپ‌ها نیستند
// چون API هم برنمی‌گرداند (maskEmail سمت سرور اعمال می‌شود).

export type AdminPlan = "FREE" | "PRO"
export type AdminRole = "USER" | "ADMIN"

export const ADMIN_PAGE_LIMIT_MAX = 100
export const ADMIN_PAGE_DEFAULT_LIMIT = 20

export interface AdminUserView {
    id: number
    username: string
    emailMasked: string
    plan: AdminPlan
    role: AdminRole
    timezone: string
    lastSeenAt: string | null
}

export interface AdminUsersPage {
    items: AdminUserView[]
    page: number
    limit: number
    total: number
    hasMore: boolean
}

/** Widget کاربران فعال — fail-open: صفرها یعنی داده در دسترس نیست. */
export interface AdminActiveUsersWidget {
    dau: number
    wau: number
    mau: number
}

export interface AdminActivityWidget {
    totalInWindow: number
    byEventName: { eventName: string; count: number }[]
    byFeature: { feature: string | null; count: number }[]
    windowHours: number
}

/** Widget سهمیه AI — در overview اختیاری است (شکست → null = unavailable). */
export interface AdminAiQuotaWidget {
    periodStart: string
    reservedUnits: number
    consumedUnits: number
}

export interface AdminErrorStatsWidget {
    totalInWindow: number
    bySeverity: { severity: string; count: number }[]
    topErrors: { errorCode: string; count: number }[]
    windowHours: number
}

export interface AdminOverview {
    users: AdminActiveUsersWidget
    activity: AdminActivityWidget
    aiQuota: AdminAiQuotaWidget | null
    errors: AdminErrorStatsWidget
}

export interface AdminAiQuotaSummary {
    plan: AdminPlan
    periodType: string
    periodStart: string
    allowedUnits: number
    reservedUnits: number
    consumedUnits: number
    utilization: number // 0..1
}

/**
 * فاز ۵ §۲۴ — نمای read-only entitlement کاربر.
 * `status`/`planCode`/`provider` مقادیر ذخیره‌شده‌ی سرور هستند؛ هیچ شناسه‌ی provider این‌جا نیست.
 */
export interface AdminBillingEntitlementView {
    status: string
    planCode: string
    provider: string
    currentPeriodStart: string
    currentPeriodEnd: string
}

/**
 * فاز ۵ §۲۴/§۳۰ — آخرین سفارش پرداخت.
 * `providerReferenceMasked` همان مقدار ماسک‌شده‌ی سرور است (`••••1234`)؛ مقدار خام هرگز نمی‌آید.
 */
export interface AdminBillingPaymentView {
    status: string
    provider: string
    amount: number
    currency: string
    entitlementDays: number
    createdAt: string
    paidAt: string | null
    providerReferenceMasked: string | null
}

/**
 * خلاصه‌ی بیلیینگ (فاز ۵ §۲۴) — بخش مستقل detail است:
 * `null` یعنی خوانش ناموفق بوده (fail-open مثل سایر summaryها) و UI فقط آن بخش را مخفی می‌کند.
 */
export interface AdminBillingSummary {
    plan: AdminPlan
    entitlement: AdminBillingEntitlementView | null
    latestPayment: AdminBillingPaymentView | null
    errorLogs: AdminErrorLogView[]
}

export interface AdminUserDetail {
    user: AdminUserView
    activitySummary: {
        windowHours: number
        totalEvents: number
        byEventName: { eventName: string; count: number }[]
    } | null
    aiQuotaSummary: AdminAiQuotaSummary | null
    recentErrors: AdminErrorLogView[]
    /** فاز ۵ §۲۴ — read-only؛ `null` یعنی همین بخش unavailable است. */
    billingSummary: AdminBillingSummary | null
}

/** نمای ErrorLog — stack عمداً در قرارداد سرور حذف شده و اینجا هم وجود ندارد. */
export interface AdminErrorLogView {
    id: string
    requestId: string | null
    userId: number | null
    endpoint: string
    feature: string | null
    errorCode: string
    statusCode: number
    category: string
    severity: string
    message: string
    metadata?: Record<string, unknown>
    environment: string | null
    createdAt: string
}

export interface AdminErrorLogsPage {
    items: AdminErrorLogView[]
    page: number
    limit: number
    total: number
    hasMore: boolean
}

export interface AdminActivityEventView {
    id: string
    userId: number
    requestId: string | null
    eventName: string
    feature: string | null
    properties: Record<string, unknown> | null
    createdAt: string
}

export interface AdminActivityPage {
    items: AdminActivityEventView[]
    page: number
    limit: number
    total: number
    hasMore: boolean
}

export interface AdminAiEventView {
    id: number
    requestId: string | null
    userId: number
    feature: string
    model: string | null
    units: number
    status: string
    attempts: number
    failureCode: string | null
    durationMs: number | null
    createdAt: string
}

export interface AdminAiUsagePage {
    plan: AdminPlan
    period: { periodType: string; periodStart: string }
    allowedUnits: number
    reservedUnits: number
    consumedUnits: number
    utilization: number
    items: AdminAiEventView[]
    page: number
    limit: number
    total: number
    hasMore: boolean
}
