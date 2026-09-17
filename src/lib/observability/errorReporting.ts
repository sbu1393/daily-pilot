// فاز ۲ — گام ۵: Monitoring & Reporting (سند فاز ۲)
//
// سرویس‌های خواندنی ErrorLog برای پایش سلامت پروژه — Backend-only، بدون هیچ UI.
//
// قرارداد سند فاز ۲:
// - Fail-Open خواندن: هر شکست DB/کوئری → نتیجه‌ی تهی (empty list/stats)، هرگز crash/throw.
// - امنیت: خروجی فقط از طریق whitelist projection ساخته می‌شود؛ این سرویس فقط رکوردهایی
//   را می‌خواند که از لایه‌های normalize→redact→persist عبور کرده‌اند (گام‌های ۲–۴)،
//   و در خروجی دوباره redactError را اعمال می‌کند تا هیچ داده‌ی حساسی نمایش داده نشود.
// - بدون retry، بدون transaction؛ کوئری‌های فقط‌خواندنی با timeout محدود.
// - مرزهای معماری: فقط import از getPrisma و ماژول‌های همین لایه؛ بدون HTTP/Request/NextResponse.

import type { Prisma } from "@prisma/client"

import { getPrisma } from "@/app/lib/getPrisma"

import { redactError } from "./redactError"
import { PERSIST_TIMEOUT_MS } from "./persistError"
import type { ObservabilityContext } from "./types"

// ---------- Public shapes ----------

/** یک لاگ خطا در خروجی — فقط فیلدهای مجاز (whitelist) + redact مجدد. */
export interface ErrorLogView {
    id: string
    requestId: string
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
    /** stack در خروجی گزارش عمومی حذف می‌شود (حاوی جزئیات داخلی است). */
}

export interface ListErrorLogsInput {
    /** شماره صفحه — از ۱ (پیش‌فرض ۱) */
    page?: number
    /** اندازه صفحه — ۱..۱۰۰ (پیش‌فرض ۲۰) */
    pageSize?: number
    severity?: string
    feature?: string
    errorCode?: string
    /** پنجره زمانی — پیش‌فرض ۷ روز اخیر */
    since?: Date
    until?: Date
}

export interface ListErrorLogsResult {
    logs: ErrorLogView[]
    page: number
    pageSize: number
    total: number
}

export interface GetErrorStatsResult {
    /** تعداد کل خطاهای ثبت‌شده در بازه (پیش‌فرض ۲۴ ساعت) */
    totalInWindow: number
    /** توزیع بر اساس severity */
    bySeverity: { severity: string; count: number }[]
    /** ۵ خطای پرتکرار اخیر بر اساس errorCode */
    topErrors: { errorCode: string; count: number }[]
    windowHours: number
}

// ---------- Guards / helpers (pure) ----------

/** سقف پنجره‌ی زمانی — جلوگیری از کوئری‌های تمام‌جدول در fail-open خواندن. */
const MAX_WINDOW_HOURS = 24 * 30 // ۳۰ روز

const MAX_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 20

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback
    const floored = Math.floor(value)
    return Math.min(max, Math.max(min, floored))
}

/** پنجره زمانی معتبر با سقف ۳۰ روز؛ ورودی نامعتبر → پیش‌فرض. */
function resolveWindow(since: Date | undefined, until: Date | undefined): { since: Date; until: Date } {
    const now = new Date()
    const safeUntil = until instanceof Date && !Number.isNaN(until.getTime()) ? until : now
    const defaultSince = new Date(safeUntil.getTime() - 7 * 24 * 60 * 60 * 1000)
    const safeSince =
        since instanceof Date && !Number.isNaN(since.getTime()) ? since : defaultSince

    // سقف پنجره: اگر بازه درخواستی بزرگ‌تر از MAX_WINDOW_HOURS بود، بریده می‌شود
    const maxSpanMs = MAX_WINDOW_HOURS * 60 * 60 * 1000
    const boundedSince =
        safeSince.getTime() < safeUntil.getTime() - maxSpanMs
            ? new Date(safeUntil.getTime() - maxSpanMs)
            : safeSince

    return { since: boundedSince, until: safeUntil }
}

/** برش زمانی تست‌پذیر — clock را از منطق جدا می‌کند (تزریق now در options). */
export interface ReportingOptions {
    /** تزریق Prisma-like client برای تست — پیش‌فرض getPrisma */
    prisma?: {
        errorLog: {
            findMany: (args: unknown) => Promise<unknown[]>
            count: (args: unknown) => Promise<number>
            groupBy: (args: unknown) => Promise<unknown[]>
        }
    }
    /** تزریق زمان حال برای window (تست) */
    now?: Date
    /** غیرفعال‌سازی timeout guard — فقط تست */
    skipTimeoutGuard?: boolean
    timeoutMs?: number
}

function makeDefaultClient(): ReportingOptions["prisma"] {
    const real = getPrisma().errorLog
    return {
        errorLog: {
            findMany: (args) =>
                real.findMany(
                    args as Parameters<typeof real.findMany>[0],
                ) as Promise<unknown[]>,
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

/**
 * whitelist projection — رکورد DB را به ErrorLogView امن تبدیل می‌کند.
 * - فقط فیلدهای مجاز در خروجی می‌روند (stack حذف).
 * - message/metadata یک بار دیگر از redactError عبور می‌کنند (دفاع در عمق).
 * - هر شکست → null (رکورد از خروجی حذف می‌شود؛ fail-open).
 */
function toView(row: unknown): ErrorLogView | null {
    try {
        const r = row as {
            id?: unknown
            requestId?: unknown
            userId?: unknown
            endpoint?: unknown
            feature?: unknown
            errorCode?: unknown
            statusCode?: unknown
            category?: unknown
            severity?: unknown
            message?: unknown
            metadata?: unknown
            environment?: unknown
            createdAt?: unknown
        }
        if (typeof r.id !== "string" || typeof r.errorCode !== "string") return null

        // redact مجدد message/metadata — تضمین امنیت خروجی مستقل از نویسنده‌ی رکورد
        const redacted = redactError({
            errorCode: r.errorCode,
            statusCode: typeof r.statusCode === "number" ? r.statusCode : 500,
            category: typeof r.category === "string" ? r.category : "UNKNOWN",
            severity: typeof r.severity === "string" ? r.severity : "ERROR",
            safeMessage: typeof r.message === "string" ? r.message : "",
            metadata:
                r.metadata !== null && typeof r.metadata === "object"
                    ? (r.metadata as Record<string, unknown>)
                    : undefined,
        })

        return {
            id: r.id,
            requestId: typeof r.requestId === "string" ? r.requestId : "unknown",
            userId: typeof r.userId === "number" ? r.userId : null,
            endpoint: typeof r.endpoint === "string" ? r.endpoint : "unknown",
            feature: typeof r.feature === "string" ? r.feature : null,
            errorCode: r.errorCode,
            statusCode: typeof r.statusCode === "number" ? r.statusCode : 500,
            category: typeof r.category === "string" ? r.category : "UNKNOWN",
            severity: typeof r.severity === "string" ? r.severity : "ERROR",
            message: redacted.safeMessage,
            metadata: redacted.metadata,
            environment: typeof r.environment === "string" ? r.environment : null,
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

/** ساخت where مشترک کوئری‌ها — فیلترهای severity/feature/errorCode + پنجره زمانی. */
function buildWhere(
    input: ListErrorLogsInput,
    window: { since: Date; until: Date },
): Record<string, unknown> {
    const where: Record<string, unknown> = {
        createdAt: { gte: window.since, lte: window.until },
    }
    if (typeof input.severity === "string" && input.severity.length > 0) {
        where.severity = input.severity
    }
    if (typeof input.feature === "string" && input.feature.length > 0) {
        where.feature = input.feature
    }
    if (typeof input.errorCode === "string" && input.errorCode.length > 0) {
        where.errorCode = input.errorCode
    }
    return where
}

// ---------- Public API ----------

/**
 * listErrorLogs — صفحه‌بندی + فیلتر severity/feature/errorCode + پنجره زمانی.
 * Fail-Open: شکست DB → { logs: [], total: 0 } با همان صفحه/اندازه درخواستی.
 */
export async function listErrorLogs(
    input: ListErrorLogsInput = {},
    options: ReportingOptions = {},
): Promise<ListErrorLogsResult> {
    const page = clampInt(input.page, 1, Number.MAX_SAFE_INTEGER, 1)
    const pageSize = clampInt(input.pageSize, 1, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE)
    const timeoutMs = options.timeoutMs ?? PERSIST_TIMEOUT_MS
    // options.now به‌عنوان مرجع پنجره (fallback تا) عبور داده می‌شود — clock تزریق‌پذیر می‌ماند
    const window = resolveWindow(input.since, input.until ?? options.now)
    const where = buildWhere(input, window)

    // گارد محیط تست: بدون prisma تزریق‌شده، هیچ I/O واقعی اجرا نمی‌شود
    const client = options.prisma ?? (process.env.VITEST ? undefined : makeDefaultClient())
    const empty: ListErrorLogsResult = { logs: [], page, pageSize, total: 0 }
    if (!client) return empty

    const rows = await withTimeout(
        client.errorLog.findMany({
            where,
            orderBy: { createdAt: "desc" },
            skip: (page - 1) * pageSize,
            take: pageSize,
        }),
        timeoutMs,
    )
    if (rows === null) return empty

    const total = await withTimeout(client.errorLog.count({ where }), timeoutMs)
    if (total === null) return empty

    const logs: ErrorLogView[] = []
    for (const row of rows) {
        const view = toView(row)
        if (view !== null) logs.push(view)
    }

    return { logs, page, pageSize, total }
}

/**
 * getErrorStats — گزارش سریع: تعداد کل در بازه (پیش‌فرض ۲۴ ساعت)،
 * توزیع severity و ۵ خطای پرتکرار اخیر.
 * Fail-Open: شکست DB → صفرها/آرایه‌های تهی (هرگز throw).
 */
export async function getErrorStats(
    input: { windowHours?: number } = {},
    options: ReportingOptions = {},
): Promise<GetErrorStatsResult> {
    const now = options.now ?? new Date()
    const windowHours = clampInt(input.windowHours, 1, MAX_WINDOW_HOURS, 24)
    const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000)
    const timeoutMs = options.timeoutMs ?? PERSIST_TIMEOUT_MS

    const client = options.prisma ?? (process.env.VITEST ? undefined : makeDefaultClient())
    const empty: GetErrorStatsResult = {
        totalInWindow: 0,
        bySeverity: [],
        topErrors: [],
        windowHours,
    }
    if (!client) return empty

    const where = { createdAt: { gte: since, lte: now } }

    const total = await withTimeout(client.errorLog.count({ where }), timeoutMs)
    if (total === null) return empty

    const severityRows = await withTimeout(
        client.errorLog.groupBy({
            by: ["severity"],
            where,
            _count: { _all: true },
        }),
        timeoutMs,
    )
    if (severityRows === null) return empty

    const codeRows = await withTimeout(
        client.errorLog.groupBy({
            by: ["errorCode"],
            where,
            _count: { _all: true },
            orderBy: { _count: { errorCode: "desc" } },
            take: 5,
        }),
        timeoutMs,
    )
    if (codeRows === null) return empty

    const bySeverity = severityRows
        .filter((row): row is Record<string, unknown> => row !== null && typeof row === "object")
        .map((row) => {
            const r = row as { severity?: unknown; _count?: { _all?: unknown } }
            return {
                severity: typeof r.severity === "string" ? r.severity : "UNKNOWN",
                count: typeof r._count?._all === "number" ? r._count._all : 0,
            }
        })
        .sort((a, b) => b.count - a.count)

    const topErrors = codeRows
        .filter((row): row is Record<string, unknown> => row !== null && typeof row === "object")
        .map((row) => {
            const r = row as { errorCode?: unknown; _count?: { _all?: unknown } }
            return {
                errorCode: typeof r.errorCode === "string" ? r.errorCode : "UNKNOWN",
                count: typeof r._count?._all === "number" ? r._count._all : 0,
            }
        })
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)

    return { totalInWindow: total, bySeverity, topErrors, windowHours }
}
