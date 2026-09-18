// فاز ۴ — Step 5 + Step 6: Admin Dashboard — read-only query foundation
//
// فقط read؛ هیچ mutation/reserve/complete/release/quota-change در این لایه مجاز نیست.
// Authorization اینجا انجام نمی‌شود (requireAdmin در مرز route است) — duplication ممنوع.
// Privacy: DTOهای allowlist-based (هرگز object spread از Prisma model)؛ password/hash/
// JWT/cookie/secret/phone/raw AI prompt-response/payment هرگز برگردانده نمی‌شود.
// منبع هر dataset فقط primitiveهای موجود فازهای قبلی است — هیچ AdminStats table/model،
// cache یا persistent aggregate جدید ساخته نمی‌شود.
//
// Failure semantics (قرارداد Step 6، گزارش‌شده):
//   - خواندنی‌های روی primitiveهای فاز ۲/۳ (activity, stats, active users) → fail-open
//     (قرارداد قفل‌شده‌ی همان primitiveها حفظ می‌شود).
//   - خواننده‌های جدید admin (searchUsers/getUserDetail/getUserAiUsage/getAdminErrorLogs/
//     getAdminGlobalActivity) → fail-closed: خطای DB به route می‌رود → 500 مطابق §22
//     (فهرست خالیِ فریبنده برای داشبورد عملیاتی مجاز نیست).
//
// Step 6 تصمیم تأییدشده (User ordering): User.createdAt وجود ندارد → ordering لیست
// کاربران «id DESC» (tie-break deterministic با خود id — unique است)؛ بدون schema change.

import { getPrisma } from "@/app/lib/getPrisma"
import { UserNotFoundError } from "./errors"
import { getMonthlyPeriod, resolvePlanPolicy } from "./planPolicy.service"
import {
    listErrorLogs,
    getErrorStats,
    type GetErrorStatsResult,
} from "@/src/lib/observability/errorReporting"
import {
    listProductEvents,
    getEventUsageStats,
    type GetEventUsageStatsResult,
    type ProductEventQueryOptions,
    type ProductEventView,
} from "./productEvent.query"
import { getActiveUserStats } from "./userActivity.service"

// ---------- Shared bounds (الگوی productEvent.query: clamp سخت، بدون unbounded) ----------

export const ADMIN_QUERY_MAX_PAGE_SIZE = 100
export const ADMIN_QUERY_DEFAULT_PAGE_SIZE = 20
/** پنجره‌ی پیش‌فرض list endpointها بدون from/to — مطابق الگوی ۷ روزه‌ی فاز ۲/۳ (bounded). */
const ADMIN_DEFAULT_WINDOW_HOURS = 24 * 7

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback
    const floored = Math.floor(value)
    return Math.min(max, Math.max(min, floored))
}

function clampPage(page: number | undefined): number {
    return clampInt(page, 1, Number.MAX_SAFE_INTEGER, 1)
}

function isValidDate(value: Date | undefined): value is Date {
    return value instanceof Date && !Number.isNaN(value.getTime())
}

/** userId فیلتر اختیاری — فقط integer مثبت معتبر است (server-side identity). */
function optionalUserId(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value) && value > 0
        ? value
        : undefined
}

// =====================================================================
// ۲) Admin activity — ProductEvent (فاز ۳) + آمار رویداد
// =====================================================================

export interface AdminActivityView {
    events: ProductEventView[]
    page: number
    pageSize: number
    total: number
}

export interface AdminActivityInput {
    /** فیلتر اختیاری کاربر — بدون آن، رویداد همه‌ی کاربران (via getEventUsageStats) */
    userId?: number
    eventName?: string
    feature?: string
    since?: Date
    until?: Date
    page?: number
    /** ۱..۱۰۰ (پیش‌فرض ۲۰) — clamp سخت */
    pageSize?: number
}

/**
 * getAdminActivity — history رویدادهای ProductEvent یک کاربر برای Admin Dashboard.
 * منبع: فقط listProductEvents (فاز ۳) — هیچ aggregation/query جدیدی روی ProductEvent.
 * Fail-open با primitive زیرین (هرگز throw نمی‌کند). فقط read.
 */
export async function getAdminActivity(
    input: AdminActivityInput = {},
): Promise<AdminActivityView> {
    const page = clampPage(input.page)
    const pageSize = clampInt(
        input.pageSize,
        1,
        ADMIN_QUERY_MAX_PAGE_SIZE,
        ADMIN_QUERY_DEFAULT_PAGE_SIZE,
    )
    const userId = optionalUserId(input.userId)

    // listProductEvents userId الزامی دارد؛ بدون فیلتر کاربر، خروجی تهی. آمار سراسری
    // از getAdminActivityStats / getAdminGlobalActivity (پایین).
    if (userId === undefined) return { events: [], page, pageSize, total: 0 }

    return listProductEvents({
        userId,
        eventName: input.eventName,
        feature: input.feature,
        since: input.since,
        until: input.until,
        page,
        pageSize,
    })
}

export async function getAdminActivityStats(windowHours?: number) {
    return getEventUsageStats({ windowHours })
}

// =====================================================================
// ۳) Admin AI usage — AiUsage (quota) + AiUsageEvent (history)
// =====================================================================

/** DTO allowlist — هرگز model خام AiUsage برنمی‌گردد. */
export interface AdminAiUsageView {
    id: number
    userId: number
    periodType: string
    periodStart: string
    reservedUnits: number
    consumedUnits: number
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
    createdAt: string // ISO UTC
}

export interface AdminAiUsageInput {
    userId?: number
    page?: number
    /** ۱..۱۰۰ (پیش‌فرض ۲۰) — clamp سخت */
    pageSize?: number
}

export interface AdminAiUsageResult {
    quota: AdminAiUsageView[]
    events: AdminAiEventView[]
    page: number
    pageSize: number
    total: number
}

/** Client injection (الگوی productEvent.query / errorReporting فاز ۲ گام ۵). */
export interface AdminAiUsageOptions {
    prisma?: {
        aiUsage: {
            findMany: (args: unknown) => Promise<unknown[]>
        }
        aiUsageEvent: {
            findMany: (args: unknown) => Promise<unknown[]>
            count: (args: unknown) => Promise<number>
        }
    }
    now?: Date
    timeoutMs?: number
}

export const ADMIN_AI_QUERY_TIMEOUT_MS = 2000

// getPrisma در ماژول‌لود import می‌شود ولی فقط داخل فراخوانی runtime استفاده می‌شود
function getPrismaLate() {
    return getPrisma()
}

function makeDefaultAiClient(): NonNullable<AdminAiUsageOptions["prisma"]> {
    const real = getPrismaLate()
    return {
        aiUsage: {
            findMany: (args) =>
                real.aiUsage.findMany(args as Parameters<typeof real.aiUsage.findMany>[0]) as Promise<unknown[]>,
        },
        aiUsageEvent: {
            findMany: (args) =>
                real.aiUsageEvent.findMany(
                    args as Parameters<typeof real.aiUsageEvent.findMany>[0],
                ) as Promise<unknown[]>,
            count: (args) =>
                real.aiUsageEvent.count(args as Parameters<typeof real.aiUsageEvent.count>[0]) as Promise<number>,
        },
    }
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T | null> {
    try {
        return await Promise.race([
            work,
            new Promise<null>((resolve) => {
                const t = setTimeout(() => resolve(null), timeoutMs)
                if (typeof t.unref === "function") t.unref()
            }),
        ])
    } catch {
        return null
    }
}

/** allowlist projection ردیف AiUsage — فیلدهای خارج از allowlist هرگز خارج نمی‌شوند. */
function toAiUsageView(row: unknown): AdminAiUsageView | null {
    try {
        const r = row as Record<string, unknown>
        if (typeof r.id !== "number" || typeof r.userId !== "number") return null
        if (typeof r.periodType !== "string" || !(r.periodStart instanceof Date)) return null
        return {
            id: r.id,
            userId: r.userId,
            periodType: r.periodType,
            periodStart: r.periodStart.toISOString(),
            reservedUnits: typeof r.reservedUnits === "number" ? r.reservedUnits : 0,
            consumedUnits: typeof r.consumedUnits === "number" ? r.consumedUnits : 0,
        }
    } catch {
        return null
    }
}

/** allowlist projection ردیف AiUsageEvent — بدون prompt/response/payload خام. */
function toAiEventView(row: unknown): AdminAiEventView | null {
    try {
        const r = row as Record<string, unknown>
        if (typeof r.id !== "number" || typeof r.userId !== "number") return null
        if (typeof r.feature !== "string" || typeof r.status !== "string") return null
        return {
            id: r.id,
            requestId: typeof r.requestId === "string" ? r.requestId : null,
            userId: r.userId,
            feature: r.feature,
            model: typeof r.model === "string" ? r.model : null,
            units: typeof r.units === "number" ? r.units : 0,
            status: r.status,
            attempts: typeof r.attempts === "number" ? r.attempts : 0,
            failureCode: typeof r.failureCode === "string" ? r.failureCode : null,
            durationMs: typeof r.durationMs === "number" ? r.durationMs : null,
            createdAt:
                r.createdAt instanceof Date
                    ? r.createdAt.toISOString()
                    : new Date(0).toISOString(),
        }
    } catch {
        return null
    }
}

/**
 * getAdminAiUsage — quota/usage از AiUsage + history از AiUsageEvent.
 * کاملاً read-only: فقط findMany/count — هیچ reserve/complete/release.
 * Fail-open: شکست DB / timeout → نتیجه‌ی تهی با همان page/pageSize (هرگز throw).
 * Ordering deterministic: createdAt DESC سپس id DESC (هر دو ستون واقعاً موجودند).
 */
export async function getAdminAiUsage(
    input: AdminAiUsageInput = {},
    options: AdminAiUsageOptions = {},
): Promise<AdminAiUsageResult> {
    const page = clampPage(input.page)
    const pageSize = clampInt(
        input.pageSize,
        1,
        ADMIN_QUERY_MAX_PAGE_SIZE,
        ADMIN_QUERY_DEFAULT_PAGE_SIZE,
    )
    const userId = optionalUserId(input.userId)
    const empty: AdminAiUsageResult = {
        quota: [],
        events: [],
        page,
        pageSize,
        total: 0,
    }

    const client = options.prisma ?? (process.env.VITEST ? undefined : makeDefaultAiClient())
    if (!client) return empty

    const timeoutMs = options.timeoutMs ?? ADMIN_AI_QUERY_TIMEOUT_MS
    const userWhere = userId !== undefined ? { userId } : {}
    const orderBy = [{ createdAt: "desc" }, { id: "desc" }] as const

    const [quotaRows, eventRows, total] = await Promise.all([
        withTimeout(
            client.aiUsage.findMany({
                where: userWhere,
                orderBy: [{ periodStart: "desc" }, { id: "desc" }],
                take: ADMIN_QUERY_MAX_PAGE_SIZE,
            }),
            timeoutMs,
        ),
        withTimeout(
            client.aiUsageEvent.findMany({
                where: userWhere,
                orderBy,
                skip: (page - 1) * pageSize,
                take: pageSize,
            }),
            timeoutMs,
        ),
        withTimeout(client.aiUsageEvent.count({ where: userWhere }), timeoutMs),
    ])
    if (quotaRows === null || eventRows === null || total === null) return empty

    const quota: AdminAiUsageView[] = []
    for (const row of quotaRows) {
        const view = toAiUsageView(row)
        if (view !== null) quota.push(view)
    }
    const events: AdminAiEventView[] = []
    for (const row of eventRows) {
        const view = toAiEventView(row)
        if (view !== null) events.push(view)
    }

    return { quota, events, page, pageSize, total }
}

// =====================================================================
// ۴) Admin errors — wrapper روی primitive موجود Phase 2 (redaction حفظ می‌شود)
// =====================================================================

export async function getAdminErrors(
    input: Parameters<typeof listErrorLogs>[0] = {},
    options: Parameters<typeof listErrorLogs>[1] = {},
) {
    // listErrorLogs خودش fail-open است، stack را حذف می‌کند و redaction فاز ۲ را اعمال کرده —
    // این wrapper هیچ فیلد جدیدی اضافه نمی‌کند و هیچ data جدیدی expose نمی‌کند.
    return listErrorLogs(input, options)
}

export async function getAdminErrorStats(
    input: Parameters<typeof getErrorStats>[0] = {},
    options: Parameters<typeof getErrorStats>[1] = {},
) {
    return getErrorStats(input, options)
}

// =====================================================================
// ۵) Admin overview/metrics — widgetهای مستقل (§12)
// =====================================================================

export interface AdminAiQuotaWidget {
    periodStart: string
    reservedUnits: number
    consumedUnits: number
}

/** KPI کاربران — `total` = کل کاربران ثبت‌شده؛ null یعنی همان read ناموفق بوده (بدون عدد جعلی). */
export interface AdminUsersWidget {
    total: number | null
    dau: number
    wau: number
    mau: number
}

/**
 * آمار خطا برای داشبورد = همان primitive فاز ۲ (§۲۷) + شمارش کل رکوردها به‌عنوان KPI جدا.
 * `bySeverity`/`topErrors` پنجره‌ای می‌مانند (windowHours)؛ `totalAllTime` بدون پنجره است.
 */
export interface AdminErrorStatsWidget extends GetErrorStatsResult {
    /** تعداد کل رکوردهای ErrorLog — null = read ناموفق (widget مستقل، fail-open) */
    totalAllTime: number | null
}

/**
 * خلاصه‌ی درخواست‌های AI — شمارش رکوردهای AiUsageEvent (هر logical AI operation = یک رکورد).
 * واحدهای سهمیه در widget `aiQuota` گزارش می‌شوند؛ اینجا هیچ توکن/محتوایی خوانده نمی‌شود
 * (prompt/response عمداً persist نمی‌شوند).
 */
export interface AdminAiUsageSummaryWidget {
    windowHours: number
    /** کل درخواست‌های منطقی ثبت‌شده (بدون پنجره) */
    totalRequests: number
    /** همان شمارش در پنجره‌ی windowHours اخیر */
    requestsInWindow: number
    /** توزیع بر اساس وضعیت رزرو (RESERVED/CONSUMED/RELEASED) */
    byStatus: { status: string; count: number }[]
}

/** پرداخت اخیر داشبورد — allowlist صریح؛ هیچ authority/reference/payload provider اینجا نیست. */
export interface AdminDashboardPaymentView {
    id: string
    userId: number
    status: string
    amount: number
    currency: string
    entitlementDays: number
    createdAt: string
    paidAt: string | null
}

/** KPI بیلیینگ — فقط state ذخیره‌شده (بدون lazy expiration، بدون effective-plan resolve). */
export interface AdminBillingWidget {
    /** ردیف‌های ACTIVE که currentPeriodEnd آن‌ها در آینده است */
    activeSubscriptions: number
    /** سفارش‌های PAID در پنجره‌ی اخیر (روی paidAt) */
    paidInWindow: number
    windowDays: number
    recentPayments: AdminDashboardPaymentView[]
}

/** خروجی نهایی نمای کلی — هر widget مستقل است (§۱۲: شکست یکی بقیه را از کار نمی‌اندازد). */
export interface AdminOverview {
    users: AdminUsersWidget
    activity: GetEventUsageStatsResult
    aiQuota: AdminAiQuotaWidget | null
    aiUsage: AdminAiUsageSummaryWidget | null
    errors: AdminErrorStatsWidget
    billing: AdminBillingWidget | null
    recentErrors: AdminErrorLogView[]
}

/** کلاینت‌های تزریق‌پذیر widgetهای جدید داشبورد (هم‌الگوی prismaClient/prisma موجود). */
export interface AdminOverviewTotalUsersClient {
    user: { count: (args: unknown) => Promise<number> }
}

export interface AdminOverviewAiUsageClient {
    aiUsageEvent: {
        count: (args: unknown) => Promise<number>
        groupBy: (args: unknown) => Promise<unknown[]>
    }
}

export interface AdminOverviewBillingClient {
    entitlement: { count: (args: unknown) => Promise<number> }
    paymentOrder: {
        count: (args: unknown) => Promise<number>
        findMany: (args: unknown) => Promise<unknown[]>
    }
}

export interface AdminOverviewErrorClient {
    errorLog: { count: (args: unknown) => Promise<number> }
}

export interface AdminOverviewOptions {
    /** تزریق client شمارش active users (الگوی getActiveUserStats) */
    prismaClient?: Parameters<typeof getActiveUserStats>[1]
    /** تزریق client aggregate سهمیه AI برای widget aiQuota */
    prisma?: {
        aiUsage: { aggregate: (args: unknown) => Promise<unknown> }
    }
    /** تزریق client شمارش کل کاربران (KPI total) */
    totalUsersClient?: AdminOverviewTotalUsersClient
    /** تزریق client آمار AiUsageEvent (widget aiUsage) */
    aiUsageClient?: AdminOverviewAiUsageClient
    /** تزریق client آمار بیلیینگ (widget billing) */
    billingClient?: AdminOverviewBillingClient
    /** تزریق client شمارش کل ErrorLog (KPI totalAllTime) */
    errorClient?: AdminOverviewErrorClient
    /** تزریق client فید خطاهای اخیر (هم‌قرارداد getAdminErrorLogs) */
    recentErrorsClient?: NonNullable<AdminErrorLogsOptions["prisma"]>
    now?: Date
}

// ---------- Dashboard widget bounds/helpers (bounded؛ بدون اسکن تمام‌جدول) ----------

/** پنجره‌ی KPIهای داشبورد (فعال/خطا/درخواست AI) — ۲۴ ساعت. */
const ADMIN_OVERVIEW_WINDOW_HOURS = 24
/** حداکثر ردیف فید خطاهای اخیر داشبورد. */
export const ADMIN_OVERVIEW_RECENT_ERRORS = 8
/** حداکثر ردیف پرداخت‌های اخیر داشبورد. */
export const ADMIN_OVERVIEW_RECENT_PAYMENTS = 5
/** پنجره‌ی «فعالیت پرداخت اخیر» روی PaymentOrder.paidAt. */
export const ADMIN_BILLING_ACTIVITY_WINDOW_DAYS = 7

/** نتیجه‌ی groupBy وضعیت AiUsageEvent → shape امن و مرتب (نزولی). */
function toStatusCounts(rows: unknown[]): { status: string; count: number }[] {
    return rows
        .filter((row): row is Record<string, unknown> => row !== null && typeof row === "object")
        .map((row) => {
            const r = row as { status?: unknown; _count?: { _all?: unknown } }
            return {
                status: typeof r.status === "string" ? r.status : "UNKNOWN",
                count: typeof r._count?._all === "number" ? r._count._all : 0,
            }
        })
        .sort((a, b) => b.count - a.count)
}

/** projection پرداخت داشبورد — allowlist صریح؛ ردیف ناقص → null (بدون نمایش داده‌ی ناقص). */
function toAdminDashboardPaymentView(row: unknown): AdminDashboardPaymentView | null {
    try {
        const r = row as Record<string, unknown>
        if (typeof r.id !== "string" || typeof r.status !== "string") return null
        if (typeof r.userId !== "number" || typeof r.amount !== "number") return null
        if (typeof r.currency !== "string" || typeof r.entitlementDays !== "number") return null
        if (!(r.createdAt instanceof Date)) return null
        return {
            id: r.id,
            userId: r.userId,
            status: r.status,
            amount: r.amount,
            currency: r.currency,
            entitlementDays: r.entitlementDays,
            createdAt: r.createdAt.toISOString(),
            paidAt: r.paidAt instanceof Date ? r.paidAt.toISOString() : null,
        }
    } catch {
        return null
    }
}

/** فقط عدد متناهی را قبول می‌کند؛ هر چیز دیگر null (هیچ عدد جعلی ساخته نمی‌شود). */
function safeCount(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * getAdminOverview — widgetهای مستقل داشبورد عملیاتی (§12):
 *   users       → getActiveUserStats (فاز ۳؛ fail-open zeros) + total (کل ثبت‌نام‌شده‌ها؛ null = unavailable)
 *   activity    → getEventUsageStats (فاز ۳؛ ProductEvent؛ fail-open)
 *   aiQuota     → aggregate دوره‌ی جاری سهمیه (شکست → null)
 *   aiUsage     → شمارش AiUsageEvent + توزیع status (شکست → null)
 *   errors      → getErrorStats (فاز ۲؛ fail-open) + totalAllTime (null = unavailable)
 *   billing     → شمارش entitlement فعال + سفارش‌های PAID اخیر + ۵ پرداخت آخر (شکست → null)
 *   recentErrors→ getAdminErrorLogs با projection فاز ۴ (bounded؛ شکست → [])
 * همه‌ی خواندنی‌ها bounded (count/aggregate/groupBy/take) و فقط read هستند؛
 * شکست هر widget فقط همان widget را unavailable می‌کند و هیچ AdminStats/cache جدیدی ساخته نمی‌شود.
 */
export async function getAdminOverview(options: AdminOverviewOptions = {}): Promise<AdminOverview> {
    const now = isValidDate(options.now) ? options.now : new Date()
    const windowSince = new Date(now.getTime() - ADMIN_OVERVIEW_WINDOW_HOURS * 60 * 60 * 1000)

    // widget 1 — users (قرارداد fail-open فاز ۳ حفظ می‌شود)
    const prismaClient =
        options.prismaClient ??
        (process.env.VITEST
            ? undefined
            : ({
                  user: {
                      count: (args: { where: { lastSeenAt: { gte: Date } } }) =>
                          getPrismaLate().user.count(args),
                  },
              } as Parameters<typeof getActiveUserStats>[1]))
    const activeUsers = prismaClient
        ? await getActiveUserStats(now, prismaClient)
        : { dau: 0, wau: 0, mau: 0 }

    let totalUsers: number | null = null
    try {
        const totalClient =
            options.totalUsersClient ?? (process.env.VITEST ? undefined : makeDefaultAdminClient())
        if (totalClient) totalUsers = safeCount(await totalClient.user.count({}))
    } catch {
        totalUsers = null // فقط همین KPI unavailable می‌شود (§12)
    }
    const users: AdminUsersWidget = {
        total: totalUsers,
        dau: activeUsers.dau,
        wau: activeUsers.wau,
        mau: activeUsers.mau,
    }

    // widget 2 — activity (fail-open فاز ۳)
    const activity = await getEventUsageStats({ windowHours: ADMIN_OVERVIEW_WINDOW_HOURS }, { now })

    // widget 3 — aiQuota (aggregate دوره‌ی جاری؛ فقط read؛ شکست → null)
    let aiQuota: AdminAiQuotaWidget | null = null
    try {
        const aggregateClient =
            options.prisma ?? (process.env.VITEST ? undefined : makeDefaultAdminClient())
        if (aggregateClient) {
            const periodStart = getMonthlyPeriod(now).periodStart
            const agg = (await aggregateClient.aiUsage.aggregate({
                where: { periodType: "MONTHLY", periodStart },
                _sum: { reservedUnits: true, consumedUnits: true },
            })) as { _sum?: Record<string, unknown> }
            aiQuota = {
                periodStart: periodStart.toISOString(),
                reservedUnits:
                    typeof agg._sum?.reservedUnits === "number" ? agg._sum.reservedUnits : 0,
                consumedUnits:
                    typeof agg._sum?.consumedUnits === "number" ? agg._sum.consumedUnits : 0,
            }
        }
    } catch {
        aiQuota = null // widget فقط خودش unavailable می‌شود (§12)
    }

    // widget 4 — aiUsage (شمارش درخواست‌های منطقی + توزیع status؛ شکست → null)
    let aiUsage: AdminAiUsageSummaryWidget | null = null
    try {
        const usageClient =
            options.aiUsageClient ?? (process.env.VITEST ? undefined : makeDefaultAdminClient())
        if (usageClient) {
            const totalRequests = await usageClient.aiUsageEvent.count({})
            const requestsInWindow = await usageClient.aiUsageEvent.count({
                where: { createdAt: { gte: windowSince, lte: now } },
            })
            const statusRows = await usageClient.aiUsageEvent.groupBy({
                by: ["status"],
                _count: { _all: true },
            })
            aiUsage = {
                windowHours: ADMIN_OVERVIEW_WINDOW_HOURS,
                totalRequests: safeCount(totalRequests) ?? 0,
                requestsInWindow: safeCount(requestsInWindow) ?? 0,
                byStatus: toStatusCounts(statusRows),
            }
        }
    } catch {
        aiUsage = null
    }

    // widget 5 — errors (fail-open فاز ۲) + شمارش کل (fail-open ⇒ null)
    const errorStats = await getErrorStats({ windowHours: ADMIN_OVERVIEW_WINDOW_HOURS }, { now })
    let totalErrors: number | null = null
    try {
        const errorClient =
            options.errorClient ?? (process.env.VITEST ? undefined : makeDefaultAdminClient())
        if (errorClient) totalErrors = safeCount(await errorClient.errorLog.count({}))
    } catch {
        totalErrors = null
    }
    const errors: AdminErrorStatsWidget = { ...errorStats, totalAllTime: totalErrors }

    // widget 6 — billing (فقط state ذخیره‌شده؛ بدون lazy expiration/effective-plan؛ شکست → null)
    let billing: AdminBillingWidget | null = null
    try {
        const billingClient =
            options.billingClient ?? (process.env.VITEST ? undefined : makeDefaultAdminClient())
        if (billingClient) {
            const activeSubscriptions = await billingClient.entitlement.count({
                where: { status: "ACTIVE", currentPeriodEnd: { gt: now } },
            })
            const paidInWindow = await billingClient.paymentOrder.count({
                where: {
                    status: "PAID",
                    paidAt: {
                        gte: new Date(
                            now.getTime() - ADMIN_BILLING_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
                        ),
                        lte: now,
                    },
                },
            })
            const rows = await billingClient.paymentOrder.findMany({
                orderBy: { createdAt: "desc" },
                take: ADMIN_OVERVIEW_RECENT_PAYMENTS,
                select: {
                    id: true,
                    userId: true,
                    status: true,
                    amount: true,
                    currency: true,
                    entitlementDays: true,
                    createdAt: true,
                    paidAt: true,
                },
            })
            const recentPayments: AdminDashboardPaymentView[] = []
            for (const row of rows) {
                const view = toAdminDashboardPaymentView(row)
                if (view !== null) recentPayments.push(view)
            }
            billing = {
                activeSubscriptions: safeCount(activeSubscriptions) ?? 0,
                paidInWindow: safeCount(paidInWindow) ?? 0,
                windowDays: ADMIN_BILLING_ACTIVITY_WINDOW_DAYS,
                recentPayments,
            }
        }
    } catch {
        billing = null
    }

    // widget 7 — recentErrors (projection فاز ۴ روی ErrorLog؛ bounded + fail-open ⇒ [])
    let recentErrors: AdminErrorLogView[] = []
    try {
        const recentClient =
            options.recentErrorsClient ?? (process.env.VITEST ? undefined : makeDefaultAdminClient())
        if (recentClient) {
            const listed = await getAdminErrorLogs(
                { page: 1, pageSize: ADMIN_OVERVIEW_RECENT_ERRORS },
                { prisma: recentClient, now },
            )
            recentErrors = listed.logs
        }
    } catch {
        recentErrors = []
    }

    return { users, activity, aiQuota, aiUsage, errors, billing, recentErrors }
}

// =====================================================================
// ۶) Admin users — search / detail (Step 6 — تصمیم تأییدشده: ordering «id DESC»)
// =====================================================================

export type AdminPlan = "FREE" | "PRO"
export type AdminRole = "USER" | "ADMIN"

/** email masking — فقط حروف اول local + *** + دامنه (Privacy §21). Pure/deterministic. */
export function maskEmail(email: string): string {
    const at = email.indexOf("@")
    if (at <= 0) return "***"
    const local = email.slice(0, at)
    const visible = local.slice(0, Math.min(2, local.length))
    return `${visible}***${email.slice(at)}`
}

export interface AdminUserView {
    id: number
    username: string
    emailMasked: string
    plan: AdminPlan
    role: AdminRole
    timezone: string
    lastSeenAt: string | null
}

export interface SearchUsersInput {
    /** id exact (عددی) / email exact (شامل @) / username prefix case-insensitive (§14) */
    q?: string
    plan?: AdminPlan
    role?: AdminRole
    page?: number
    limit?: number
    sort?: "id_asc" | "id_desc"
}

export interface AdminUsersOptions {
    prisma?: {
        user: {
            findMany: (args: unknown) => Promise<unknown[]>
            count: (args: unknown) => Promise<number>
        }
    }
}

function toAdminUserView(row: unknown): AdminUserView | null {
    try {
        const r = row as Record<string, unknown>
        if (typeof r.id !== "number") return null
        if (typeof r.username !== "string" || typeof r.email !== "string") return null
        if (typeof r.plan !== "string" || typeof r.role !== "string") return null
        if (typeof r.timezone !== "string") return null
        return {
            id: r.id,
            username: r.username,
            emailMasked: maskEmail(r.email),
            plan: r.plan as AdminPlan,
            role: r.role as AdminRole,
            timezone: r.timezone,
            lastSeenAt: r.lastSeenAt instanceof Date ? r.lastSeenAt.toISOString() : null,
        }
    } catch {
        return null
    }
}

function buildUserSearchWhere(input: SearchUsersInput): Record<string, unknown> {
    const where: Record<string, unknown> = {}
    const q = typeof input.q === "string" ? input.q.trim() : ""
    if (q.length > 0) {
        // §14 — جستجوی bounded: id exact / email exact / username prefix.
        // جستجوی unbounded %term% استفاده نمی‌شود.
        if (/^\d+$/.test(q)) {
            where.id = Number(q)
        } else if (q.includes("@")) {
            where.email = q
        } else {
            where.username = { startsWith: q, mode: "insensitive" }
        }
    }
    if (input.plan !== undefined) where.plan = input.plan
    if (input.role !== undefined) where.role = input.role
    return where
}

/**
 * searchUsers — فهرست/جستجوی کاربران برای Admin.
 * Ordering (تصمیم تأییدشده Step 6): «id DESC» (id unique → deterministic).
 * select محدود (§20) + DTO allowlist + email masked. phone/password select نمی‌شوند.
 * Fail-closed (§22): خطای DB propagate می‌شود → route → 500.
 */
export async function searchUsers(
    input: SearchUsersInput = {},
    options: AdminUsersOptions = {},
): Promise<{ users: AdminUserView[]; page: number; pageSize: number; total: number }> {
    const page = clampPage(input.page)
    const limit = clampInt(input.limit, 1, ADMIN_QUERY_MAX_PAGE_SIZE, ADMIN_QUERY_DEFAULT_PAGE_SIZE)
    const empty = { users: [] as AdminUserView[], page, pageSize: limit, total: 0 }

    const client = options.prisma ?? (process.env.VITEST ? undefined : makeDefaultAdminClient())
    if (!client) return empty

    const where = buildUserSearchWhere(input)
    const sortDir = input.sort === "id_asc" ? "asc" : "desc"

    const [rows, total] = await Promise.all([
        client.user.findMany({
            where,
            select: {
                id: true,
                username: true,
                email: true,
                plan: true,
                role: true,
                timezone: true,
                lastSeenAt: true,
            },
            orderBy: [{ id: sortDir }],
            skip: (page - 1) * limit,
            take: limit,
        }),
        client.user.count({ where }),
    ])

    const users: AdminUserView[] = []
    for (const row of rows) {
        const view = toAdminUserView(row)
        if (view !== null) users.push(view)
    }
    return { users, page, pageSize: limit, total }
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

export interface AdminUserDetail {
    user: AdminUserView
    activitySummary: {
        windowHours: number
        totalEvents: number
        byEventName: { eventName: string; count: number }[]
    } | null
    aiQuotaSummary: AdminAiQuotaSummary | null
    recentErrors: AdminErrorLogView[]
    /**
     * فاز ۵ — گام ۱۶ (سند فاز ۵ §۲۴): نمای read-only بیلیینگ.
     * `null` یعنی خواندن موفق نشد (fail-open مثل سایر summaryها)؛ هیچ mutation/effective-plan
     * resolve/lazy expiration در این مسیر رخ نمیدهد.
     */
    billingSummary: AdminBillingSummary | null
}

export interface AdminDetailOptions {
    prisma?: {
        user: { findUnique: (args: unknown) => Promise<unknown> }
        aiUsage: { findUnique: (args: unknown) => Promise<unknown> }
        errorLog: {
            findMany: (args: unknown) => Promise<unknown[]>
            count: (args: unknown) => Promise<number>
        }
        // فاز ۵ — گام ۱۶: فقط خواندن‌های read-only نمای بیلیینگ (§۲۴)
        entitlement: { findUnique: (args: unknown) => Promise<unknown> }
        paymentOrder: { findFirst: (args: unknown) => Promise<unknown> }
    }
    /** تزریق client productEvent برای activity summary (الگوی getEventUsageStats) */
    productEventOptions?: ProductEventQueryOptions
    now?: Date
}

/**
 * getUserDetail — safe identity + summaryها (§15).
 * خود user fetch: fail-closed (not-found → 404 USER_NOT_FOUND؛ خطای DB → 500).
 * هر summary مستقل است و شکستش فقط همان بخش را null/خالی می‌کند (§12).
 * هیچ phone/password/image	select یا serialize نمی‌شود؛ email فقط masked.
 */
export async function getUserDetail(
    userId: number,
    options: AdminDetailOptions = {},
): Promise<AdminUserDetail> {
    const client = options.prisma ?? makeDefaultAdminClient()
    const now = isValidDate(options.now) ? options.now : new Date()

    const row = (await client.user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            username: true,
            email: true,
            plan: true,
            role: true,
            timezone: true,
            lastSeenAt: true,
        },
    })) as Record<string, unknown> | null
    const user = row === null ? null : toAdminUserView(row)
    if (user === null) throw new UserNotFoundError()

    // summary 1 — activity (ProductEvent؛ fail-open primitive فاز ۳؛ شکست → null)
    let activitySummary: AdminUserDetail["activitySummary"] = null
    try {
        const stats = await getEventUsageStats(
            { userId, windowHours: 24 * 7 },
            { now, ...(options.productEventOptions ?? {}) },
        )
        activitySummary = {
            windowHours: stats.windowHours,
            totalEvents: stats.totalInWindow,
            byEventName: stats.byEventName,
        }
    } catch {
        activitySummary = null
    }

    // summary 2 — AI quota دوره‌ی جاری (read؛ شکست → null)
    let aiQuotaSummary: AdminAiQuotaSummary | null = null
    try {
        const plan = (typeof row?.plan === "string" ? row.plan : "FREE") as AdminPlan
        const policy = resolvePlanPolicy({ plan })
        // فاز ۱ — period در timezone همان کاربر (نه UTC)؛ tz از همان read ردیف کاربر
        const timezone = row && typeof row.timezone === "string" ? row.timezone : undefined
        const periodStart = getMonthlyPeriod(now, timezone).periodStart
        const quotaRow = (await client.aiUsage.findUnique({
            where: { userId_periodType_periodStart: { userId, periodType: "MONTHLY", periodStart } },
            select: { reservedUnits: true, consumedUnits: true },
        })) as Record<string, unknown> | null
        const reserved =
            quotaRow && typeof quotaRow.reservedUnits === "number" ? quotaRow.reservedUnits : 0
        const consumed =
            quotaRow && typeof quotaRow.consumedUnits === "number" ? quotaRow.consumedUnits : 0
        aiQuotaSummary = {
            plan,
            periodType: "MONTHLY",
            periodStart: periodStart.toISOString(),
            allowedUnits: policy.allowedUnits,
            reservedUnits: reserved,
            consumedUnits: consumed,
            utilization: policy.allowedUnits > 0 ? Math.min(1, consumed / policy.allowedUnits) : 0,
        }
    } catch {
        aiQuotaSummary = null
    }

    // summary 4 — billing / entitlement (فاز ۵ — گام ۱۶، سند §۲۴؛ کاملاً read-only)
    // شکست این بخش فقط خودش را null می‌کند و هیچ تأثیری روی بخش‌های دیگر ندارد (§۱۲).
    // هیچ resolveEffectivePlan/lazy expiration/نوشتنی در این مسیر نیست؛ پلن فقط آینه‌ی
    // ذخیره‌شده‌ی `User.plan` و وضعیت entitlement همان state ذخیره‌شده است.
    let billingSummary: AdminBillingSummary | null = null
    try {
        billingSummary = await getAdminBillingSummary(userId, {
            // پلن همان آینه‌ی ردیف کاربر که همین‌جا خوانده شد — بدون read دوم و بدون effective-plan resolve
            plan: typeof row?.plan === "string" ? row.plan : "FREE",
            prisma: client,
            now,
        })
    } catch {
        billingSummary = null
    }

    // summary 3 — recent errors (حداکثر ۵؛ شکست → خالی)
    let recentErrors: AdminErrorLogView[] = []
    try {
        const errs = await getAdminErrorLogs(
            { userId, page: 1, pageSize: 5 },
            {
                prisma: {
                    errorLog: {
                        findMany: client.errorLog.findMany,
                        count: client.errorLog.count,
                    },
                },
                now,
            },
        )
        recentErrors = errs.logs
    } catch {
        recentErrors = []
    }

    return { user, activitySummary, aiQuotaSummary, recentErrors, billingSummary }
}

export interface GetUserAiUsageInput {
    /** فقط MONTHLY در schema واقعی وجود دارد (AiUsagePeriodType) */
    period?: "MONTHLY"
    status?: "RESERVED" | "CONSUMED" | "RELEASED"
    page?: number
    limit?: number
}

export interface AdminAiUsageClient {
    user: { findUnique: (args: unknown) => Promise<unknown> }
    aiUsage: { findUnique: (args: unknown) => Promise<unknown> }
    aiUsageEvent: {
        findMany: (args: unknown) => Promise<unknown[]>
        count: (args: unknown) => Promise<number>
    }
}

/**
 * getUserAiUsage — نمای §16 برای یک کاربر: plan + دوره‌ی جاری + allowed/reserved/consumed
 * + utilization + recent usage events. کاملاً read-only (فقط findUnique/findMany/count —
 * هیچ reserve/complete/release). Fail-closed؛ user ناموجود → 404 USER_NOT_FOUND.
 * نبودن ردیف AiUsage برای دوره‌ی جاری حالت عادی است → صفرها (نه failure).
 */
export async function getUserAiUsage(
    userId: number,
    input: GetUserAiUsageInput = {},
    options: { prisma?: AdminAiUsageClient; now?: Date } = {},
): Promise<{
    plan: AdminPlan
    period: { periodType: string; periodStart: string }
    allowedUnits: number
    reservedUnits: number
    consumedUnits: number
    utilization: number
    events: AdminAiEventView[]
    page: number
    pageSize: number
    total: number
}> {
    const page = clampPage(input.page)
    const limit = clampInt(input.limit, 1, ADMIN_QUERY_MAX_PAGE_SIZE, ADMIN_QUERY_DEFAULT_PAGE_SIZE)
    const now = isValidDate(options.now) ? options.now : new Date()

    const client = options.prisma ?? makeDefaultAdminClient()

    const userRow = (await client.user.findUnique({
        where: { id: userId },
        select: { plan: true, timezone: true },
    })) as { plan?: unknown; timezone?: unknown } | null
    if (userRow === null || typeof userRow.plan !== "string") throw new UserNotFoundError()
    const plan = userRow.plan as AdminPlan

    const policy = resolvePlanPolicy({ plan })
    // فاز ۱ — period در timezone همان کاربر (نه UTC)
    const timezone = typeof userRow.timezone === "string" ? userRow.timezone : undefined
    const periodStart = getMonthlyPeriod(now, timezone).periodStart

    const quotaRow = (await client.aiUsage.findUnique({
        where: { userId_periodType_periodStart: { userId, periodType: "MONTHLY", periodStart } },
        select: { reservedUnits: true, consumedUnits: true },
    })) as Record<string, unknown> | null
    const reserved =
        quotaRow && typeof quotaRow.reservedUnits === "number" ? quotaRow.reservedUnits : 0
    const consumed =
        quotaRow && typeof quotaRow.consumedUnits === "number" ? quotaRow.consumedUnits : 0

    const eventWhere: Record<string, unknown> = { userId }
    if (input.status !== undefined) eventWhere.status = input.status

    const [rows, total] = await Promise.all([
        client.aiUsageEvent.findMany({
            where: eventWhere,
            select: {
                id: true,
                requestId: true,
                userId: true,
                feature: true,
                model: true,
                units: true,
                status: true,
                attempts: true,
                failureCode: true,
                durationMs: true,
                createdAt: true,
            },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: (page - 1) * limit,
            take: limit,
        }),
        client.aiUsageEvent.count({ where: eventWhere }),
    ])

    const events: AdminAiEventView[] = []
    for (const row of rows) {
        const view = toAiEventView(row)
        if (view !== null) events.push(view)
    }

    return {
        plan,
        period: { periodType: "MONTHLY", periodStart: periodStart.toISOString() },
        allowedUnits: policy.allowedUnits,
        reservedUnits: reserved,
        consumedUnits: consumed,
        utilization: policy.allowedUnits > 0 ? Math.min(1, consumed / policy.allowedUnits) : 0,
        events,
        page,
        pageSize: limit,
        total,
    }
}

// =====================================================================
// ۷) Admin ErrorLog reader — فیلترهای §10 که primitive فاز ۲ پوشش نمی‌دهد
// =====================================================================

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
    // stack عمداً حذف می‌شود — همان قرارداد ErrorLogView فاز ۲
}

export interface AdminErrorLogsInput {
    userId?: number
    errorCode?: string
    category?: string
    severity?: string
    endpoint?: string
    /** فاز ۵ — گام ۱۶: فیلتر feature (مثلاً "billing") — همان ستون موجود ErrorLog.feature. */
    feature?: string
    from?: Date
    to?: Date
    page?: number
    pageSize?: number
}

export interface AdminErrorLogsOptions {
    prisma?: {
        errorLog: {
            findMany: (args: unknown) => Promise<unknown[]>
            count: (args: unknown) => Promise<number>
        }
    }
    now?: Date
}

/**
 * toAdminErrorLogView — projection با همان فیلدهای امن ErrorLogView فاز ۲ (بدون stack).
 * داده‌ها در زمان write با redaction فاز ۲ sanitize شده‌اند؛ این projection هیچ فیلد
 * جدیدی expose نمی‌کند → redaction bypass نمی‌شود.
 */
function toAdminErrorLogView(row: unknown): AdminErrorLogView | null {
    try {
        const r = row as Record<string, unknown>
        if (typeof r.id !== "string" || typeof r.endpoint !== "string") return null
        if (
            typeof r.errorCode !== "string" ||
            typeof r.category !== "string" ||
            typeof r.severity !== "string" ||
            typeof r.message !== "string"
        )
            return null
        return {
            id: r.id,
            requestId: typeof r.requestId === "string" ? r.requestId : null,
            userId: typeof r.userId === "number" ? r.userId : null,
            endpoint: r.endpoint,
            feature: typeof r.feature === "string" ? r.feature : null,
            errorCode: r.errorCode,
            statusCode: typeof r.statusCode === "number" ? r.statusCode : 0,
            category: r.category,
            severity: r.severity,
            message: r.message,
            metadata:
                r.metadata !== null &&
                typeof r.metadata === "object" &&
                !Array.isArray(r.metadata)
                    ? (r.metadata as Record<string, unknown>)
                    : undefined,
            environment: typeof r.environment === "string" ? r.environment : null,
            createdAt:
                r.createdAt instanceof Date
                    ? r.createdAt.toISOString()
                    : new Date(0).toISOString(),
        }
    } catch {
        return null
    }
}

/**
 * getAdminErrorLogs — خواننده‌ی bounded ErrorLog با فیلترهای blueprint §10
 * (code/category/severity/endpoint/userId/from/to/page/limit).
 * چرا primitive فاز ۲ مستقیماً استفاده نشد: listErrorLogs فقط
 * severity/errorCode/feature/پنجره را پشتیبانی می‌کند؛ فیلترهای userId/category/endpoint
 * در قرارداد آن نیست (§9: بخش وابسته بر اساس قرارداد واقعی پیاده و گزارش می‌شود).
 * redaction حفظ شده (write-time) + projection بدون stack. Fail-closed (§22).
 */
export async function getAdminErrorLogs(
    input: AdminErrorLogsInput = {},
    options: AdminErrorLogsOptions = {},
): Promise<{ logs: AdminErrorLogView[]; page: number; pageSize: number; total: number }> {
    const page = clampPage(input.page)
    const pageSize = clampInt(input.pageSize, 1, ADMIN_QUERY_MAX_PAGE_SIZE, ADMIN_QUERY_DEFAULT_PAGE_SIZE)
    const now = isValidDate(options.now) ? options.now : new Date()
    const to = isValidDate(input.to) ? input.to : now
    const from = isValidDate(input.from)
        ? input.from
        : new Date(to.getTime() - ADMIN_DEFAULT_WINDOW_HOURS * 60 * 60 * 1000)

    const where: Record<string, unknown> = { createdAt: { gte: from, lte: to } }
    const userId = optionalUserId(input.userId)
    if (userId !== undefined) where.userId = userId
    for (const [key, value] of [
        ["errorCode", input.errorCode],
        ["category", input.category],
        ["severity", input.severity],
        ["endpoint", input.endpoint],
        ["feature", input.feature],
    ] as const) {
        if (typeof value === "string" && value.length > 0) where[key] = value
    }

    const client = options.prisma ?? makeDefaultAdminClient()
    const [rows, total] = await Promise.all([
        client.errorLog.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
        }),
        client.errorLog.count({ where }),
    ])

    const logs: AdminErrorLogView[] = []
    for (const row of rows) {
        const view = toAdminErrorLogView(row)
        if (view !== null) logs.push(view)
    }
    return { logs, page, pageSize, total }
}

// =====================================================================
// ۸) Admin global activity — ProductEvent برای همه‌ی کاربران
// =====================================================================

export interface AdminGlobalActivityInput {
    eventName?: string
    since?: Date
    until?: Date
    page?: number
    pageSize?: number
}

export interface AdminGlobalActivityOptions {
    prisma?: {
        productEvent: {
            findMany: (args: unknown) => Promise<unknown[]>
            count: (args: unknown) => Promise<number>
        }
    }
    now?: Date
}

/** projection امن — همان شکل ProductEventView فاز ۳ (properties همان JSON ذخیره‌شده). */
function toGlobalEventView(row: unknown): ProductEventView | null {
    try {
        const r = row as Record<string, unknown>
        if (typeof r.id !== "string" || typeof r.eventName !== "string") return null
        if (typeof r.userId !== "number") return null
        return {
            id: r.id,
            userId: r.userId,
            requestId: typeof r.requestId === "string" ? r.requestId : null,
            eventName: r.eventName,
            feature: typeof r.feature === "string" ? r.feature : null,
            properties:
                r.properties !== null &&
                typeof r.properties === "object" &&
                !Array.isArray(r.properties)
                    ? (r.properties as Record<string, unknown>)
                    : null,
            createdAt:
                r.createdAt instanceof Date
                    ? r.createdAt.toISOString()
                    : typeof r.createdAt === "string"
                      ? r.createdAt
                      : new Date(0).toISOString(),
        }
    } catch {
        return null
    }
}

/**
 * getAdminGlobalActivity — فهرست سراسری ProductEvent برای Admin.
 * چرا listProductEvents مستقیماً استفاده نشد: قرارداد قفل‌شده‌ی فاز ۳ آن per-user است
 * (userId الزامی)؛ نمای سراسری blueprint §10 نیازمند خواننده‌ی bounded بدون userId است.
 * Ordering: createdAt DESC, id DESC (هر دو ستون واقعاً موجودند — §11).
 * پنجره‌ی پیش‌فرض ۷ روز (bounded) — index [createdAt]. Fail-closed (§22).
 */
export async function getAdminGlobalActivity(
    input: AdminGlobalActivityInput = {},
    options: AdminGlobalActivityOptions = {},
): Promise<AdminActivityView> {
    const page = clampPage(input.page)
    const pageSize = clampInt(input.pageSize, 1, ADMIN_QUERY_MAX_PAGE_SIZE, ADMIN_QUERY_DEFAULT_PAGE_SIZE)
    const now = isValidDate(options.now) ? options.now : new Date()
    const until = isValidDate(input.until) ? input.until : now
    const since = isValidDate(input.since)
        ? input.since
        : new Date(until.getTime() - ADMIN_DEFAULT_WINDOW_HOURS * 60 * 60 * 1000)

    const where: Record<string, unknown> = { createdAt: { gte: since, lte: until } }
    if (typeof input.eventName === "string" && input.eventName.length > 0) {
        where.eventName = input.eventName
    }

    const client = options.prisma ?? makeDefaultAdminClient()
    const [rows, total] = await Promise.all([
        client.productEvent.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: (page - 1) * pageSize,
            take: pageSize,
        }),
        client.productEvent.count({ where }),
    ])

    const events: ProductEventView[] = []
    for (const row of rows) {
        const view = toGlobalEventView(row)
        if (view !== null) events.push(view)
    }
    return { events, page, pageSize, total }
}

// =====================================================================
// ۹) فاز ۵ — گام ۱۶: نمای read-only بیلیینگ برای admin (سند فاز ۵ §۲۴)
// =====================================================================
//
// قواعد قفل‌شده:
// - **کاملاً read-only**: فقط findUnique/findFirst/findMany — هیچ mutation، هیچ
//   resolveEffectivePlan()، هیچ lazy expiration، هیچ provider call، هیچ AdminAuditLog.
// - پلن فقط آینه‌ی سروری `User.plan` است و وضعیت entitlement همان state ذخیره‌شده (§۲۴).
// - Privacy (§۱۵/§۲۱ فاز ۴ + §۳۳ فاز ۵): هیچ Authority/reference خام، هیچ secret/merchant،
//   هیچ raw payment payload و هیچ شناسه‌ی حساسی برنمی‌گردد؛ reference provider فقط **ماسک‌شده**
//   (۴ کاراکتر آخر) و DTOها allowlist-based هستند (بدون object spread از رکورد Prisma).

/** نمای entitlement برای admin — فقط فیلدهای §۲۴ (بدون id/userId). */
export interface AdminBillingEntitlementView {
    status: string
    planCode: string
    provider: string
    currentPeriodStart: string
    currentPeriodEnd: string
}

/** نمای آخرین سفارش پرداخت (فاز ۵ §۳۰) — reference فقط ماسک‌شده. */
export interface AdminBillingPaymentView {
    status: string
    provider: string
    amount: number
    currency: string
    entitlementDays: number
    createdAt: string
    paidAt: string | null
    /** هرگز مقدار خام نیست — فقط «••••abcd». */
    providerReferenceMasked: string | null
}

/** خلاصه‌ی بیلیینگ یک کاربر (بخش مستقل getUserDetail — §۱۲). */
export interface AdminBillingSummary {
    /** آینه‌ی سروری `User.plan` (هرگز plan مشتق/محاسبه‌شده — §۲۴). */
    plan: AdminPlan
    entitlement: AdminBillingEntitlementView | null
    latestPayment: AdminBillingPaymentView | null
    /** خطاهای عملیاتی همین دامنه (feature="billing") — بدون stack، همان redaction فاز ۲. */
    errorLogs: AdminErrorLogView[]
}

/** کلاینت read-only موردنیاز نمای بیلیینگ (تزریق‌پذیر — الگوی AdminAiUsageClient). */
export interface AdminBillingClient {
    user: { findUnique: (args: unknown) => Promise<unknown> }
    entitlement: { findUnique: (args: unknown) => Promise<unknown> }
    paymentOrder: { findFirst: (args: unknown) => Promise<unknown> }
    errorLog: {
        findMany: (args: unknown) => Promise<unknown[]>
        count: (args: unknown) => Promise<number>
    }
}

export interface AdminBillingOptions {
    /**
     * آینه‌ی `User.plan` که caller از قبل خوانده است (مثل getUserDetail) — تا read تکراری نباشد.
     * اگر تعریف نشده باشد، همین تابع خودش ردیف کاربر را می‌خواند (و user ناموجود → USER_NOT_FOUND).
     */
    plan?: string | null
    prisma?: AdminBillingClient
    now?: Date
}

/** حداکثر خطای بیلیینگ نمایش‌دادهشده در summary — bounded (الگوی recentErrors). */
export const ADMIN_BILLING_ERROR_LIMIT = 5

/** مقدار ماسک‌شده — هرگز مقدار خام authority/reference. */
const MASKED_PREFIX = "••••"

/**
 * maskProviderReference — ماسک کردن شناسه‌ی عملیاتی provider (§۲۴: «masked provider reference»).
 *
 * - فقط **۴ کاراکتر آخر** حفظ می‌شود (`••••1234`) و بقیه حذف می‌شود.
 * - مقدار کوتاه/خالی (≤ ۴ کاراکتر) **کامل** پوشانده می‌شود؛ چون نمایش آخرین ۴ کاراکتر
 *   در آن حالت معادل افشای کل مقدار است.
 * - مقادیر غیررشته/null → null (بدون ساخت مقدار جعلی).
 * Pure/deterministic — بدون I/O.
 */
export function maskProviderReference(reference: string | null | undefined): string | null {
    if (typeof reference !== "string") return null
    const value = reference.trim()
    if (value.length === 0) return null
    if (value.length <= 4) return MASKED_PREFIX
    return `${MASKED_PREFIX}${value.slice(-4)}`
}

/** projection مستقل entitlement — ردیف نامعتبر/ناقص → null (بدون افشای محتوا). */
function toAdminBillingEntitlementView(row: unknown): AdminBillingEntitlementView | null {
    try {
        const r = row as Record<string, unknown> | null
        if (r === null || typeof r !== "object") return null
        if (typeof r.status !== "string" || typeof r.provider !== "string") return null
        if (typeof r.planCode !== "string") return null
        if (!(r.currentPeriodStart instanceof Date) || !(r.currentPeriodEnd instanceof Date)) return null
        return {
            status: r.status,
            planCode: r.planCode,
            provider: r.provider,
            currentPeriodStart: r.currentPeriodStart.toISOString(),
            currentPeriodEnd: r.currentPeriodEnd.toISOString(),
        }
    } catch {
        return null
    }
}

/** projection مستقل آخرین سفارش — هیچ فیلد حساسی وارد DTO نمی‌شود (allowlist صریح). */
function toAdminBillingPaymentView(row: unknown): AdminBillingPaymentView | null {
    try {
        const r = row as Record<string, unknown> | null
        if (r === null || typeof r !== "object") return null
        if (typeof r.status !== "string" || typeof r.provider !== "string") return null
        if (typeof r.amount !== "number" || typeof r.currency !== "string") return null
        if (typeof r.entitlementDays !== "number") return null
        if (!(r.createdAt instanceof Date)) return null
        return {
            status: r.status,
            provider: r.provider,
            amount: r.amount,
            currency: r.currency,
            entitlementDays: r.entitlementDays,
            createdAt: r.createdAt.toISOString(),
            paidAt: r.paidAt instanceof Date ? r.paidAt.toISOString() : null,
            providerReferenceMasked: maskProviderReference(
                typeof r.providerReference === "string" ? r.providerReference : null,
            ),
        }
    } catch {
        return null
    }
}

/**
 * getAdminBillingSummary — نمای read-only بیلیینگ یک کاربر (فاز ۵ §۲۴).
 *
 * - user ناموجود → 404 USER_NOT_FOUND (fail-closed؛ همان قرارداد getUserDetail).
 * - سه بخش مستقل‌اند و شکست هر بخش فقط همان بخش را null/خالی می‌کند (§۱۲):
 *   entitlement · latestPayment · errorLogs (feature="billing").
 * - فقط read؛ هیچ mutation روی entitlement/plan/سفارش و هیچ effective-plan resolve.
 */
export async function getAdminBillingSummary(
    userId: number,
    options: AdminBillingOptions = {},
): Promise<AdminBillingSummary> {
    const client = options.prisma ?? makeDefaultAdminClient()
    const now = isValidDate(options.now) ? options.now : new Date()

    // آینه‌ی سروری plan — مقدار نامعتبر/غایب → FREE (هم‌قرارداد getUserDetail).
    // مسیر getUserDetail پلن را از ردیف اصلی پاس می‌دهد تا این بخش هیچ read اضافه و هیچ
    // نقطه‌ی شکست مضاعفی نداشته باشد؛ فراخوان مستقل، خودش ردیف را می‌خواند.
    let plan: AdminPlan
    if (options.plan === undefined) {
        const userRow = (await client.user.findUnique({
            where: { id: userId },
            select: { plan: true },
        })) as Record<string, unknown> | null
        if (userRow === null) throw new UserNotFoundError()
        plan = (typeof userRow.plan === "string" ? userRow.plan : "FREE") as AdminPlan
    } else {
        plan = (typeof options.plan === "string" ? options.plan : "FREE") as AdminPlan
    }

    let entitlement: AdminBillingEntitlementView | null = null
    try {
        entitlement = toAdminBillingEntitlementView(
            await client.entitlement.findUnique({
                where: { userId },
                select: {
                    status: true,
                    planCode: true,
                    provider: true,
                    currentPeriodStart: true,
                    currentPeriodEnd: true,
                },
            }),
        )
    } catch {
        entitlement = null
    }

    let latestPayment: AdminBillingPaymentView | null = null
    try {
        latestPayment = toAdminBillingPaymentView(
            await client.paymentOrder.findFirst({
                where: { userId },
                orderBy: { createdAt: "desc" },
                select: {
                    status: true,
                    provider: true,
                    amount: true,
                    currency: true,
                    entitlementDays: true,
                    createdAt: true,
                    paidAt: true,
                    providerReference: true,
                },
            }),
        )
    } catch {
        latestPayment = null
    }

    // ErrorLog بیلیینگ — از reader موجود فاز ۴ استفاده می‌شود (redaction/stack-free فاز ۲ حفظ می‌شود)
    let errorLogs: AdminErrorLogView[] = []
    try {
        const billingErrors = await getAdminErrorLogs(
            { userId, feature: "billing", page: 1, pageSize: ADMIN_BILLING_ERROR_LIMIT },
            {
                prisma: {
                    errorLog: {
                        findMany: client.errorLog.findMany,
                        count: client.errorLog.count,
                    },
                },
                now,
            },
        )
        errorLogs = billingErrors.logs
    } catch {
        errorLogs = []
    }

    return { plan, entitlement, latestPayment, errorLogs }
}

// =====================================================================
// ۱۰) Default admin client — یک factory مشترک برای خواننده‌های Step 6
// =====================================================================

function makeDefaultAdminClient() {
    const real = getPrismaLate()
    return {
        user: {
            findUnique: (args: unknown) => real.user.findUnique(args as never),
            findMany: (args: unknown) => real.user.findMany(args as never),
            count: (args: unknown) => real.user.count(args as never),
        },
        // فاز ۵ — گام ۱۶: فقط خواندن برای نمای بیلیینگ (read-only)
        entitlement: {
            findUnique: (args: unknown) => real.entitlement.findUnique(args as never),
            // KPI داشبورد: شمارش اشتراک‌های فعال (فقط count؛ هیچ ردیفی بارگذاری نمی‌شود)
            count: (args: unknown) => real.entitlement.count(args as never) as Promise<number>,
        },
        paymentOrder: {
            findFirst: (args: unknown) => real.paymentOrder.findFirst(args as never),
            // KPI داشبورد: فعالیت پرداخت اخیر + حداکثر ۵ سفارش آخر (take در caller)
            count: (args: unknown) => real.paymentOrder.count(args as never) as Promise<number>,
            findMany: (args: unknown) =>
                real.paymentOrder.findMany(args as never) as Promise<unknown[]>,
        },
        aiUsage: {
            findUnique: (args: unknown) => real.aiUsage.findUnique(args as never),
            aggregate: (args: unknown) => real.aiUsage.aggregate(args as never),
        },
        aiUsageEvent: {
            findMany: (args: unknown) => real.aiUsageEvent.findMany(args as never),
            count: (args: unknown) => real.aiUsageEvent.count(args as never) as Promise<number>,
            // KPI داشبورد: توزیع وضعیت رزرو (فقط groupBy؛ هیچ ردیف جزئیاتی خوانده نمی‌شود)
            groupBy: (args: unknown) => real.aiUsageEvent.groupBy(args as never) as Promise<unknown[]>,
        },
        errorLog: {
            findMany: (args: unknown) => real.errorLog.findMany(args as never),
            count: (args: unknown) => real.errorLog.count(args as never),
        },
        productEvent: {
            findMany: (args: unknown) => real.productEvent.findMany(args as never),
            count: (args: unknown) => real.productEvent.count(args as never),
        },
    }
}
