// فاز ۴ — Step 7: Admin Frontend — ViewModelهای خالص (Pure)
//
// الگوی رسمی repo برای تست UI بدون jsdom (AdvisorCard.test.ts):
// «منطقِ نمایش pure استخراج و تست می‌شود». این ماژول تمام منطق تصمیم‌گیری UI را
// نگه می‌دارد تا صفحات فقط render کنند. هیچ I/O، هیچ DOM، هیچ React در این لایه.
//
// Privacy (§21): فقط داده‌ی API مصرف می‌شود؛ هیچ unmask/reconstruction انجام نمی‌شود
// و stack/metadata خام هرگز در viewmodel گسترش نمی‌یابد.

import type {
    AdminActivityPage,
    AdminBillingSummary,
    AdminErrorLogsPage,
    AdminErrorLogView,
    AdminOverview,
    AdminUserDetail,
    AdminUsersPage,
    AdminAiUsagePage,
} from "./adminTypes"

// ---------- Status صفحه (loading/empty/error/data) ----------

export type AdminListStatus = "loading" | "empty" | "error" | "data"

export function resolveListStatus(loading: boolean, error: string | null, itemCount: number): AdminListStatus {
    if (loading) return "loading"
    if (error !== null) return "error"
    return itemCount > 0 ? "data" : "empty"
}

// ---------- Authorization UX (فقط UX؛ امنیت سمت سرور با requireAdmin است) ----------

export type AdminAccessStatus = "checking" | "unauthenticated" | "forbidden" | "allowed"

export function resolveAccessStatus(error: string | null, loading: boolean): AdminAccessStatus {
    if (loading && error === null) return "checking"
    if (error !== null) {
        if (error.includes("401") || error.includes("UNAUTHORIZED")) return "unauthenticated"
        if (error.includes("403") || error.includes("ADMIN_FORBIDDEN")) return "forbidden"
    }
    return "allowed"
}

/** پیام فارسی مطابق convention repo (envelope messages فارسی‌اند؛ این fallback محلی است). */
export function accessMessage(status: AdminAccessStatus): string {
    switch (status) {
        case "unauthenticated":
            return "برای مشاهده‌ی این بخش ابتدا وارد حساب خود شوید."
        case "forbidden":
            return "این بخش فقط برای حساب‌های مدیریتی در دسترس است."
        default:
            return ""
    }
}

// ---------- Query string builder (allowlist؛ هیچ param خام تزریق نمی‌شود) ----------

export type AdminUsersQuery = {
    q?: string
    plan?: "" | "FREE" | "PRO"
    role?: "" | "USER" | "ADMIN"
    page: number
    limit: number
}

/** فقط کلیدهای مجاز را serialize می‌کند؛ limit هرگز > 100 نمی‌شود (قرارداد سرویس). */
export function buildUsersQueryString(query: AdminUsersQuery): string {
    const sp = new URLSearchParams()
    const q = (query.q ?? "").trim()
    if (q.length > 0) sp.set("q", q)
    if (query.plan === "FREE" || query.plan === "PRO") sp.set("plan", query.plan)
    if (query.role === "USER" || query.role === "ADMIN") sp.set("role", query.role)
    sp.set("page", String(Math.max(1, Math.floor(query.page))))
    sp.set("limit", String(clampLimit(query.limit)))
    return sp.toString()
}

export type AdminErrorsQuery = {
    code?: string
    category?: string
    severity?: string
    endpoint?: string
    userId?: string
    from?: string
    to?: string
    page: number
    limit: number
}

/** فیلترهای §10 — فقط کلیدهای مجاز؛ مقادیر خالی حذف می‌شوند. */
export function buildErrorsQueryString(query: AdminErrorsQuery): string {
    const sp = new URLSearchParams()
    for (const [key, raw] of [
        ["code", query.code],
        ["category", query.category],
        ["severity", query.severity],
        ["endpoint", query.endpoint],
        ["userId", query.userId],
        ["from", query.from],
        ["to", query.to],
    ] as const) {
        const value = (raw ?? "").trim()
        if (value.length > 0) sp.set(key, value)
    }
    sp.set("page", String(Math.max(1, Math.floor(query.page))))
    sp.set("limit", String(clampLimit(query.limit)))
    return sp.toString()
}

/** per-user activity/AI/errors — فقط page/limit (+فیلترهای مجاز per endpoint). */
export function buildPerUserQueryString(
    extra: { eventName?: string; status?: string; severity?: string; category?: string } = {},
    page = 1,
    limit = ADMIN_PER_USER_PAGE_SIZE,
): string {
    const sp = new URLSearchParams()
    const eventName = (extra.eventName ?? "").trim()
    if (eventName.length > 0) sp.set("event", eventName)
    const status = (extra.status ?? "").trim()
    if (status === "RESERVED" || status === "CONSUMED" || status === "RELEASED") sp.set("status", status)
    const severity = (extra.severity ?? "").trim()
    if (severity.length > 0) sp.set("severity", severity)
    const category = (extra.category ?? "").trim()
    if (category.length > 0) sp.set("category", category)
    sp.set("page", String(Math.max(1, Math.floor(page))))
    sp.set("limit", String(clampLimit(limit)))
    return sp.toString()
}

export const ADMIN_PER_USER_PAGE_SIZE = 10

function clampLimit(limit: number): number {
    if (!Number.isFinite(limit)) return 20
    return Math.min(100, Math.max(1, Math.floor(limit)))
}

// ---------- Users list viewmodel ----------

export type UsersPageVM = {
    status: AdminListStatus
    items: AdminUsersPage["items"]
    page: number
    totalPages: number
    total: number
    hasPrev: boolean
    hasNext: boolean
}

export function buildUsersPageVM(data: AdminUsersPage | null, loading: boolean, error: string | null): UsersPageVM {
    if (data === null) {
        return {
            status: resolveListStatus(loading, error, 0),
            items: [],
            page: 1,
            totalPages: 1,
            total: 0,
            hasPrev: false,
            hasNext: false,
        }
    }
    const totalPages = Math.max(1, Math.ceil(data.total / Math.max(1, data.limit)))
    return {
        status: resolveListStatus(loading, error, data.items.length),
        items: data.items,
        page: data.page,
        totalPages,
        total: data.total,
        hasPrev: data.page > 1,
        hasNext: data.hasMore || data.page < totalPages,
    }
}

// ---------- Errors list viewmodel ----------

export type ErrorsPageVM = {
    status: AdminListStatus
    items: AdminErrorLogsPage["items"]
    page: number
    totalPages: number
    total: number
    hasPrev: boolean
    hasNext: boolean
}

export function buildErrorsPageVM(data: AdminErrorLogsPage | null, loading: boolean, error: string | null): ErrorsPageVM {
    if (data === null) {
        return {
            status: resolveListStatus(loading, error, 0),
            items: [],
            page: 1,
            totalPages: 1,
            total: 0,
            hasPrev: false,
            hasNext: false,
        }
    }
    const totalPages = Math.max(1, Math.ceil(data.total / Math.max(1, data.limit)))
    return {
        status: resolveListStatus(loading, error, data.items.length),
        items: data.items,
        page: data.page,
        totalPages,
        total: data.total,
        hasPrev: data.page > 1,
        hasNext: data.hasMore || data.page < totalPages,
    }
}

// ---------- Overview viewmodel ----------

/**
 * سقف ردیف‌های فید خطاهای اخیر داشبورد. سرور `ADMIN_OVERVIEW_RECENT_ERRORS` ردیف bounded می‌دهد؛
 * UI هرگز بیشتر از این تعداد رندر نمی‌کند (مرز سخت سمت نمایش).
 */
export const ADMIN_OVERVIEW_ERROR_FEED_LIMIT = 10

/**
 * نمای کلی داشبورد — هر widget مستقل است (§12):
 * `null` یعنی همان بخش unavailable بوده و UI فقط همان بخش را مخفی می‌کند.
 * `users.total` نیز nullable است (شمارش کل ثبت‌نام‌شده‌ها می‌تواند ناموفق باشد).
 */
export type OverviewVM = {
    users: { total: number | null; dau: number; wau: number; mau: number }
    activity: AdminOverview["activity"] | null
    aiQuota: AdminOverview["aiQuota"] | null
    aiUsage: AdminOverview["aiUsage"] | null
    errors: AdminOverview["errors"] | null
    billing: AdminOverview["billing"] | null
    recentErrors: AdminErrorLogView[]
}

/**
 * widgetهای مستقل (§12): شکست هر بخش داده فقط همان بخش را unavailable می‌کند.
 * هیچ metric جدیدی از داده‌ی موجود ساخته نمی‌شود — فقط show/hide و قالب‌بندی.
 * فید خطاهای اخیر با projection صریح (allowlist) ساخته می‌شود؛ metadata/stack هرگز وارد UI نمی‌شود.
 */
export function buildOverviewVM(overview: AdminOverview | null): OverviewVM {
    if (overview === null) {
        return {
            users: { total: null, dau: 0, wau: 0, mau: 0 },
            activity: null,
            aiQuota: null,
            aiUsage: null,
            errors: null,
            billing: null,
            recentErrors: [],
        }
    }
    const users = overview.users
    return {
        users: {
            total: typeof users?.total === "number" ? users.total : null,
            dau: typeof users?.dau === "number" ? users.dau : 0,
            wau: typeof users?.wau === "number" ? users.wau : 0,
            mau: typeof users?.mau === "number" ? users.mau : 0,
        },
        activity: isActivityWidget(overview.activity) ? overview.activity : null,
        aiQuota: isAiQuotaWidget(overview.aiQuota) ? overview.aiQuota : null,
        aiUsage: isAiUsageWidget(overview.aiUsage) ? overview.aiUsage : null,
        errors: isErrorStatsWidget(overview.errors) ? overview.errors : null,
        billing: isBillingWidget(overview.billing) ? overview.billing : null,
        recentErrors: toRecentErrorFeed(overview.recentErrors),
    }
}

function isActivityWidget(value: unknown): value is AdminOverview["activity"] {
    if (value === null || typeof value !== "object") return false
    const v = value as Record<string, unknown>
    return typeof v.totalInWindow === "number" && Array.isArray(v.byEventName)
}

function isAiQuotaWidget(value: unknown): value is AdminOverview["aiQuota"] {
    if (value === null || typeof value !== "object") return false
    const v = value as Record<string, unknown>
    return typeof v.reservedUnits === "number" && typeof v.consumedUnits === "number"
}

function isErrorStatsWidget(value: unknown): value is AdminOverview["errors"] {
    if (value === null || typeof value !== "object") return false
    const v = value as Record<string, unknown>
    return typeof v.totalInWindow === "number" && Array.isArray(v.bySeverity)
}

function isAiUsageWidget(value: unknown): value is NonNullable<AdminOverview["aiUsage"]> {
    if (value === null || typeof value !== "object") return false
    const v = value as Record<string, unknown>
    return (
        typeof v.totalRequests === "number" &&
        typeof v.requestsInWindow === "number" &&
        Array.isArray(v.byStatus)
    )
}

function isBillingWidget(value: unknown): value is NonNullable<AdminOverview["billing"]> {
    if (value === null || typeof value !== "object") return false
    const v = value as Record<string, unknown>
    return (
        typeof v.activeSubscriptions === "number" &&
        typeof v.paidInWindow === "number" &&
        Array.isArray(v.recentPayments)
    )
}

/**
 * فید خطاهای اخیر — projection allowlist روی DTO سرور.
 * ردیف ناقص حذف می‌شود و `metadata` عمداً وارد نمی‌شود (فید به آن نیازی ندارد و UI
 * هرگز JSON خام را render نمی‌کند). خروجی حداکثر `ADMIN_OVERVIEW_ERROR_FEED_LIMIT` ردیف است.
 */
function toRecentErrorFeed(value: unknown): AdminErrorLogView[] {
    if (!Array.isArray(value)) return []
    const feed: AdminErrorLogView[] = []
    for (const row of value) {
        if (row === null || typeof row !== "object") continue
        const r = row as Record<string, unknown>
        const id = r.id
        const endpoint = r.endpoint
        const errorCode = r.errorCode
        const severity = r.severity
        const message = r.message
        const createdAt = r.createdAt
        if (typeof id !== "string" || typeof endpoint !== "string") continue
        if (typeof errorCode !== "string" || typeof severity !== "string") continue
        if (typeof message !== "string" || typeof createdAt !== "string") continue
        feed.push({
            id,
            requestId: typeof r.requestId === "string" ? r.requestId : null,
            userId: typeof r.userId === "number" ? r.userId : null,
            endpoint,
            feature: typeof r.feature === "string" ? r.feature : null,
            errorCode,
            statusCode: typeof r.statusCode === "number" ? r.statusCode : 0,
            category: typeof r.category === "string" ? r.category : "UNKNOWN",
            severity,
            message,
            environment: typeof r.environment === "string" ? r.environment : null,
            createdAt,
        })
        if (feed.length >= ADMIN_OVERVIEW_ERROR_FEED_LIMIT) break
    }
    return feed
}

// ---------- User detail viewmodel ----------

export type UserDetailVM = {
    user: AdminUserDetail["user"] | null
    activitySummary: AdminUserDetail["activitySummary"]
    aiQuotaSummary: AdminUserDetail["aiQuotaSummary"]
    recentErrors: AdminErrorLogView[]
    /** فاز ۵ §۲۴ — read-only؛ null یعنی widget بیلیینگ unavailable است. */
    billingSummary: AdminBillingSummary | null
}

/**
 * بخش‌های مستقل detail (§15): activitySummary/aiQuotaSummary/billingSummary می‌توانند null باشند
 * (حالت عادی — widget فقط مخفی می‌شود)؛ recentErrors خالی یعنی خطایی در پنجره نبوده.
 */
export function buildUserDetailVM(detail: AdminUserDetail | null): UserDetailVM {
    if (detail === null || detail.user === null || typeof detail.user !== "object") {
        return {
            user: null,
            activitySummary: null,
            aiQuotaSummary: null,
            recentErrors: [],
            billingSummary: null,
        }
    }
    return {
        user: detail.user,
        activitySummary:
            detail.activitySummary !== null && typeof detail.activitySummary === "object"
                ? detail.activitySummary
                : null,
        aiQuotaSummary:
            detail.aiQuotaSummary !== null && typeof detail.aiQuotaSummary === "object"
                ? detail.aiQuotaSummary
                : null,
        recentErrors: Array.isArray(detail.recentErrors) ? detail.recentErrors : [],
        billingSummary: isBillingSummary(detail.billingSummary) ? detail.billingSummary : null,
    }
}

/** گارد شکل widget بیلیینگ — رکورد نامعتبر/ناقص → null (بدون render داده‌ی ناقص). */
function isBillingSummary(value: unknown): value is AdminBillingSummary {
    if (value === null || typeof value !== "object") return false
    const v = value as Record<string, unknown>
    return (
        typeof v.plan === "string" &&
        (v.entitlement === null || typeof v.entitlement === "object") &&
        (v.latestPayment === null || typeof v.latestPayment === "object") &&
        Array.isArray(v.errorLogs)
    )
}

// ---------- Per-user sub-lists viewmodels ----------

export function buildActivityPageVM(
    data: AdminActivityPage | null,
    loading: boolean,
    error: string | null,
): { status: AdminListStatus; items: AdminActivityPage["items"] } {
    const items = data === null ? [] : Array.isArray(data.items) ? data.items : []
    return { status: resolveListStatus(loading, error, items.length), items }
}

export function buildAiUsagePageVM(
    data: AdminAiUsagePage | null,
    loading: boolean,
    error: string | null,
): { status: AdminListStatus; items: AdminAiUsagePage["items"]; quota: AdminAiUsagePage | null } {
    if (data === null) return { status: resolveListStatus(loading, error, 0), items: [], quota: null }
    const items = Array.isArray(data.items) ? data.items : []
    return { status: resolveListStatus(loading, error, items.length), items, quota: data }
}

// ---------- KPI helpers (pure — فقط aggregate مستقیم روی داده‌ی سرور) ----------

/** همان طبقه‌بندی severity که سرویس/UI استفاده می‌کند؛ هر مقدار ناشناخته → OTHER. */
export type SeverityCounts = {
    CRITICAL: number
    ERROR: number
    WARNING: number
    INFO: number
    OTHER: number
}

/**
 * شمارش خطاها به تفکیک شدت از `bySeverity` سرور — بدون هیچ derive آماری جدید.
 * مقدار تکراری جمع نمی‌شود (آخرین مقدار برنده نیست): همه‌ی ردیف‌های یک شدت با هم جمع می‌شوند.
 */
export function countBySeverity(rows: { severity: string; count: number }[]): SeverityCounts {
    const counts: SeverityCounts = { CRITICAL: 0, ERROR: 0, WARNING: 0, INFO: 0, OTHER: 0 }
    if (!Array.isArray(rows)) return counts
    for (const row of rows) {
        const raw = typeof row?.count === "number" && Number.isFinite(row.count) ? row.count : 0
        switch (row?.severity) {
            case "CRITICAL":
                counts.CRITICAL += raw
                break
            case "ERROR":
                counts.ERROR += raw
                break
            case "WARNING":
                counts.WARNING += raw
                break
            case "INFO":
                counts.INFO += raw
                break
            default:
                counts.OTHER += raw
        }
    }
    return counts
}

/**
 * ماسک شناسه‌ی داخلی سفارش پرداخت برای نمایش (`••••1234`).
 * هیچ شناسه‌ی کاملی در UI نمایش داده نمی‌شود؛ ورودی کوتاه/خالی → ماسک کامل.
 */
export function maskIdTail(id: string): string {
    const trimmed = id.trim()
    if (trimmed.length === 0) return "—"
    if (trimmed.length <= 4) return "••••"
    return `••••${trimmed.slice(-4)}`
}

// ---------- Formatting helpers (pure) ----------

const FA_DATE_TIME = new Intl.DateTimeFormat("fa-IR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Tehran",
})

/** نمایش timestamp — خواندنی؛ هیچ داده‌ی جدیدی derive نمی‌شود. */
export function formatTimestamp(iso: string | null): string {
    if (iso === null || iso === "") return "—"
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return "—"
    try {
        return FA_DATE_TIME.format(date)
    } catch {
        return "—"
    }
}

/** درصد بدون اعشار — فقط برای utilization که API خودش می‌دهد (0..1). */
export function formatUtilization(utilization: number): string {
    if (!Number.isFinite(utilization) || utilization < 0) return "۰٪"
    return `${faDigits(Math.min(100, Math.round(utilization * 100)))}٪`
}

/** faDigits فقط برای اعداد در UI — همان helper رسمی repo. */
export function faDigits(input: number | string): string {
    return String(input).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)])
}

/** برچسب‌های فارسی ثابت — بدون هیچ منطق امنیتی. */
export function planLabel(plan: string): string {
    return plan === "PRO" ? "حرفه‌ای" : "رایگان"
}

export function roleLabel(role: string): string {
    return role === "ADMIN" ? "مدیر" : "کاربر"
}

/**
 * برچسب وضعیت entitlement — فقط نمایش؛ مقدار ناشناخته **بدون اختراع** همان کد خام را نشان می‌دهد.
 * (فاز ۵ §۳۰/§۲۴: state ذخیره‌شده‌ی سرور، بدون هیچ derive/effective-plan در UI.)
 */
export function entitlementStatusLabel(status: string): string {
    switch (status) {
        case "ACTIVE":
            return "فعال"
        case "EXPIRED":
            return "منقضی"
        default:
            return status
    }
}

/** برچسب وضعیت سفارش پرداخت — فقط نمایش؛ مقدار ناشناخته همان کد خام می‌ماند. */
export function paymentStatusLabel(status: string): string {
    switch (status) {
        case "PENDING":
            return "در انتظار پرداخت"
        case "PAID":
            return "پرداخت‌شده"
        case "FAILED":
            return "ناموفق"
        case "EXPIRED":
            return "منقضی"
        case "CANCELED":
            return "لغو‌شده"
        default:
            return status
    }
}

export function severityTone(severity: string): "critical" | "error" | "warning" | "info" | "neutral" {
    switch (severity) {
        case "CRITICAL":
            return "critical"
        case "ERROR":
            return "error"
        case "WARNING":
            return "warning"
        case "INFO":
            return "info"
        default:
            return "neutral"
    }
}
