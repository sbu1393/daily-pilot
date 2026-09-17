// فاز ۳ — گام ۵: Query/History Service برای ProductEvent (سند فاز ۳ §16)
//
// سرویس فقط‌خواندنی analytics — Backend-only، بدون route/UI.
//
// قرارداد سند فاز ۳:
// - §16 Activity History: events برای یک کاربر، بر اساس eventName، در بازه‌ی زمانی،
//   و usage counts — روی ایندکس‌های قفل‌شده‌ی [userId, createdAt] / [eventName, createdAt] / [createdAt].
// - §17 Failure Matrix: analytics DB unavailable → fail-open (نتیجه‌ی تهی، هرگز throw/crash).
// - §15 تفکیک: این سرویس منبع DAU/WAU/MAU نیست — آن metricها از User.lastSeenAt هستند
//   (گام ۶). اینجا فقط ProductEvent history/counts؛ هیچ ترکیبی با TaskEvent/AiUsageEvent/ErrorLog.
// - خواندن bounded: بدون retry، بدون transaction، کوئری‌های فقط‌خواندنی با timeout محدود.
// - UTC: پنجره‌ی زمانی روی createdAt (Prisma DateTime در PostgreSQL UTC است)؛
//   هیچ canonicalDay/Jalali در این queryها استفاده نمی‌شود.
// - properties همان JSON ذخیره‌شده عبور داده می‌شوند — لایه‌ی query هیچ
//   allowlist/validation جدید و متناقضی ایجاد نمی‌کند (اعتبارسنجی در لحظه‌ی write انجام شده).
// - فقط read: هیچ mutation؛ هیچ نوشتن ErrorLog/ProductEvent (بدون recursion).

import { getPrisma } from "@/app/lib/getPrisma"

// ---------- Public shapes ----------

/** یک رویداد در خروجی history — همان JSON ذخیره‌شده، بدون تغییر شکل. */
export interface ProductEventView {
    id: string
    userId: number
    /** فقط correlation — همان مقدار ذخیره‌شده (ممکن است null باشد). */
    requestId: string | null
    eventName: string
    feature: string | null
    properties: Record<string, unknown> | null
    /** UTC ISO string */
    createdAt: string
}

export interface ListProductEventsInput {
    /** الزامی — history برای یک کاربر مشخص (server-side identity) */
    userId: number
    /** فیلتر اختیاری نام رویداد (§16: events by eventName) */
    eventName?: string
    /** فیلتر اختیاری فیچر */
    feature?: string
    /** پنجره‌ی زمانی UTC — پیش‌فرض ۷ روز اخیر تا now */
    since?: Date
    until?: Date
    /** صفحه — از ۱ (پیش‌فرض ۱) */
    page?: number
    /** اندازه صفحه — ۱..۱۰۰ (پیش‌فرض ۲۰) */
    pageSize?: number
}

export interface ListProductEventsResult {
    events: ProductEventView[]
    page: number
    pageSize: number
    total: number
}

export interface GetEventUsageStatsInput {
    /** بازه‌ی آمار به ساعت — ۱..۷۲۰ (پیش‌فرض ۲۴) */
    windowHours?: number
    /** اختیاری — اگر داده شود آمار به همان کاربر محدود می‌شود؛ در غیر این صورت global */
    userId?: number
}

export interface GetEventUsageStatsResult {
    totalInWindow: number
    /** usage count بر اساس eventName (§16: event usage over time — ایندکس [eventName, createdAt]) */
    byEventName: { eventName: string; count: number }[]
    /** usage count بر اساس feature (§16: feature usage counts) */
    byFeature: { feature: string | null; count: number }[]
    windowHours: number
}

// ---------- Guards / helpers (pure) ----------

/** سقف پنجره‌ی زمانی — جلوگیری از اسکن تمام‌جدول در fail-open خواندن. */
const MAX_WINDOW_HOURS = 24 * 30 // ۳۰ روز
const DEFAULT_WINDOW_HOURS = 24
/** پیش‌فرض پنجره‌ی history — مطابق الگوی listErrorLogs فاز ۲ (۷ روز اخیر). */
const DEFAULT_HISTORY_WINDOW_HOURS = 24 * 7
const MAX_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 20

/** سقف زمان انتظار کوئری خواندن — الگوی timeout guard فاز ۲/۳. */
export const PRODUCT_EVENT_QUERY_TIMEOUT_MS = 2000

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback
    const floored = Math.floor(value)
    return Math.min(max, Math.max(min, floored))
}

function isValidDate(value: Date | undefined): value is Date {
    return value instanceof Date && !Number.isNaN(value.getTime())
}

/**
 * پنجره‌ی زمانی معتبر UTC با سقف ۳۰ روز؛ ورودی نامعتبر → پیش‌فرض.
 * `now` تزریق‌پذیر است (options.now) تا clock از منطق جدا بماند.
 */
function resolveWindow(
    since: Date | undefined,
    until: Date | undefined,
    now: Date,
): { since: Date; until: Date } {
    const safeUntil = isValidDate(until) ? until : now
    const defaultSince = new Date(
        safeUntil.getTime() - DEFAULT_HISTORY_WINDOW_HOURS * 60 * 60 * 1000,
    )
    const safeSince = isValidDate(since) ? since : defaultSince

    // سقف پنجره: بازه‌ی بزرگ‌تر از ۳۰ روز بریده می‌شود
    const maxSpanMs = MAX_WINDOW_HOURS * 60 * 60 * 1000
    const boundedSince =
        safeSince.getTime() < safeUntil.getTime() - maxSpanMs
            ? new Date(safeUntil.getTime() - maxSpanMs)
            : safeSince

    return { since: boundedSince, until: safeUntil }
}

/** ساخت where مشترک — userId + پنجره + فیلترهای اختیاری؛ بدون dynamic SQL. */
function buildWhere(
    userId: number | undefined,
    eventName: string | undefined,
    feature: string | undefined,
    window: { since: Date; until: Date },
): Record<string, unknown> {
    const where: Record<string, unknown> = {
        createdAt: { gte: window.since, lte: window.until },
    }
    if (typeof userId === "number" && Number.isInteger(userId) && userId > 0) {
        where.userId = userId
    }
    if (typeof eventName === "string" && eventName.length > 0) {
        where.eventName = eventName
    }
    if (typeof feature === "string" && feature.length > 0) {
        where.feature = feature
    }
    return where
}

// ---------- Client injection (الگوی errorReporting فاز ۲ گام ۵) ----------

export interface ProductEventQueryOptions {
    /** تزریق Prisma-like client برای تست — پیش‌فرض getPrisma */
    prisma?: {
        productEvent: {
            findMany: (args: unknown) => Promise<unknown[]>
            count: (args: unknown) => Promise<number>
            groupBy: (args: unknown) => Promise<unknown[]>
        }
    }
    /** تزریق زمان حال برای window (تست) */
    now?: Date
    timeoutMs?: number
}

function makeDefaultClient(): NonNullable<ProductEventQueryOptions["prisma"]> {
    const real = getPrisma().productEvent
    return {
        productEvent: {
            findMany: (args) =>
                real.findMany(args as Parameters<typeof real.findMany>[0]) as Promise<unknown[]>,
            count: (args) =>
                real.count(args as Parameters<typeof real.count>[0]) as Promise<number>,
            groupBy: (args) =>
                real.groupBy(args as any) as Promise<unknown[]>,
        },
    }
}

/** اجرای یک کار خواندنی با timeout محدود؛ خروجی null در شکست (fail-open). */
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

/** whitelist projection سطر DB → ProductEventView؛ هر شکست → null (حذف از خروجی). */
function toEventView(row: unknown): ProductEventView | null {
    try {
        const r = row as {
            id?: unknown
            userId?: unknown
            requestId?: unknown
            eventName?: unknown
            feature?: unknown
            properties?: unknown
            createdAt?: unknown
        }
        if (typeof r.id !== "string" || typeof r.eventName !== "string") return null
        if (typeof r.userId !== "number") return null

        return {
            id: r.id,
            userId: r.userId,
            requestId: typeof r.requestId === "string" ? r.requestId : null,
            eventName: r.eventName,
            feature: typeof r.feature === "string" ? r.feature : null,
            // properties همان JSON ذخیره‌شده — بدون validation/allowlist جدید
            properties:
                r.properties !== null &&
                typeof r.properties === "object" &&
                !Array.isArray(r.properties)
                    ? (r.properties as Record<string, unknown>)
                    : null,
            createdAt:
                r.createdAt instanceof Date
                    ? r.createdAt.toISOString() // UTC
                    : typeof r.createdAt === "string"
                      ? r.createdAt
                      : new Date(0).toISOString(),
        }
    } catch {
        return null
    }
}

/** safe map ردیف‌های groupBy — ردیف ناقص → count 0 با کلید UNKNOWN (بدون crash). */
function safeCountMap(
    rows: unknown[],
    keyField: string,
): { key: string | null; count: number }[] {
    const out: { key: string | null; count: number }[] = []
    for (const row of rows) {
        if (row === null || typeof row !== "object") continue
        const r = row as Record<string, unknown>
        const key = typeof r[keyField] === "string" ? (r[keyField] as string) : null
        const count =
            typeof r._count === "object" &&
            r._count !== null &&
            typeof (r._count as Record<string, unknown>)._all === "number"
                ? (r._count as Record<string, number>)._all
                : 0
        out.push({ key, count })
    }
    return out
}

// ---------- Public API ----------

/**
 * listProductEvents — history رویدادهای یک کاربر (§16).
 * Fail-Open: ورودی نامعتبر، شکست DB، یا timeout → نتیجه‌ی تهی با همان page/pageSize.
 * مرتب‌سازی: createdAt desc. فقط read — هیچ mutation.
 */
export async function listProductEvents(
    input: ListProductEventsInput,
    options: ProductEventQueryOptions = {},
): Promise<ListProductEventsResult> {
    const page = clampInt(input.page, 1, Number.MAX_SAFE_INTEGER, 1)
    const pageSize = clampInt(input.pageSize, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE)
    const empty: ListProductEventsResult = { events: [], page, pageSize, total: 0 }

    // userId الزامی و باید server-side integer مثبت باشد
    if (typeof input.userId !== "number" || !Number.isInteger(input.userId) || input.userId <= 0) {
        return empty
    }

    const now = isValidDate(options.now) ? options.now : new Date()
    const window = resolveWindow(input.since, input.until, now)
    const where = buildWhere(
        input.userId,
        input.eventName,
        input.feature,
        window,
    )
    const timeoutMs = options.timeoutMs ?? PRODUCT_EVENT_QUERY_TIMEOUT_MS

    // گارد محیط تست: بدون prisma تزریق‌شده، هیچ I/O واقعی اجرا نمی‌شود
    const client = options.prisma ?? (process.env.VITEST ? undefined : makeDefaultClient())
    if (!client) return empty

    const rows = await withTimeout(
        client.productEvent.findMany({
            where,
            orderBy: { createdAt: "desc" },
            skip: (page - 1) * pageSize,
            take: pageSize,
        }),
        timeoutMs,
    )
    if (rows === null) return empty

    const total = await withTimeout(client.productEvent.count({ where }), timeoutMs)
    if (total === null) return empty

    const events: ProductEventView[] = []
    for (const row of rows) {
        const view = toEventView(row)
        if (view !== null) events.push(view)
    }

    return { events, page, pageSize, total }
}

/**
 * getEventUsageStats — feature/event usage counts در یک بازه (§16).
 * Fail-Open: شکست DB / timeout → صفرها و آرایه‌های تهی (هرگز throw).
 * توجه: این آمار usage رویداد است — منبع DAU/WAU/MAU نیست (§15؛ گام ۶ با lastSeenAt).
 */
export async function getEventUsageStats(
    input: GetEventUsageStatsInput = {},
    options: ProductEventQueryOptions = {},
): Promise<GetEventUsageStatsResult> {
    const windowHours = clampInt(input.windowHours, 1, MAX_WINDOW_HOURS, DEFAULT_WINDOW_HOURS)
    const empty: GetEventUsageStatsResult = {
        totalInWindow: 0,
        byEventName: [],
        byFeature: [],
        windowHours,
    }

    const now = isValidDate(options.now) ? options.now : new Date()
    const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000)
    const where = buildWhere(
        typeof input.userId === "number" && Number.isInteger(input.userId) && input.userId > 0
            ? input.userId
            : undefined,
        undefined,
        undefined,
        { since, until: now },
    )
    const timeoutMs = options.timeoutMs ?? PRODUCT_EVENT_QUERY_TIMEOUT_MS

    const client = options.prisma ?? (process.env.VITEST ? undefined : makeDefaultClient())
    if (!client) return empty

    const total = await withTimeout(client.productEvent.count({ where }), timeoutMs)
    if (total === null) return empty

    const nameRows = await withTimeout(
        client.productEvent.groupBy({
            by: ["eventName"],
            where,
            _count: { _all: true },
            orderBy: { _count: { eventName: "desc" } },
        }),
        timeoutMs,
    )
    if (nameRows === null) return empty

    const featureRows = await withTimeout(
        client.productEvent.groupBy({
            by: ["feature"],
            where,
            _count: { _all: true },
        }),
        timeoutMs,
    )
    if (featureRows === null) return empty

    const byEventName = safeCountMap(nameRows, "eventName")
        .map((r) => ({ eventName: r.key ?? "UNKNOWN", count: r.count }))
        .sort((a, b) => b.count - a.count)

    const byFeature = safeCountMap(featureRows, "feature")
        .map((r) => ({ feature: r.key, count: r.count }))
        .sort((a, b) => b.count - a.count)

    return { totalInWindow: total, byEventName, byFeature, windowHours }
}
