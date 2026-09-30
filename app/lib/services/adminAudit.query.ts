// Admin V2 — خواننده‌ی read-only جدول `AdminAuditLog` (نمایش در /admin/audit)
//
// تصمیم‌های عمدی:
// - **فقط خواندن.** هیچ create/update/delete؛ نویسنده همچنان `adminAudit.service.ts`
//   (تنها منبع حقیقت) است و این ماژول هیچ قاعده‌ی جدیدی نمی‌سازد.
// - **بدون migration.** جدول و ایندکس‌های لازم (`createdAt`, `action,createdAt`,
//   `actorUserId,createdAt`) از قبل در schema موجودند.
// - **projection allowlist.** `before`/`after` (نوع `Json`) هرگز خام render نمی‌شوند؛
//   فقط مقادیر اسکالر و آرایه‌ی اسکالرها عبور می‌کنند و هر شیء تودرتو حذف می‌شود.
//   این همان چیزی است که تضمین می‌کند «raw rejected promo code» یا هر ساختار
//   غافلگیرکننده‌ای به UI نرسد.
// - **bounded actor lookup.** برای هر صفحه فقط `actorUserId`های متمایز خوانده
//   می‌شوند و فقط `id + username` (نه email).

import { getPrisma } from "@/app/lib/getPrisma"
import type { PrismaClientLike } from "./aiUsage.service"

export const ADMIN_AUDIT_MAX_PAGE_SIZE = 100
export const ADMIN_AUDIT_DEFAULT_PAGE_SIZE = 20
/** پنجره‌ی پیش‌فرض فقط وقتی هیچ فیلتر هدفمندی وجود ندارد. */
const ADMIN_AUDIT_DEFAULT_WINDOW_DAYS = 7
/** سقف طول رشته در snapshot — از سرریز UI و payloadهای غیرمنتظره جلوگیری می‌کند. */
const SNAPSHOT_STRING_MAX = 200

export interface AdminAuditLogView {
    id: string
    actorUserId: number
    /** نام کاربری actor — اگر کاربر حذف شده باشد `null`. */
    actorUsername: string | null
    action: string
    targetType: string
    targetId: string
    before: Record<string, unknown> | null
    after: Record<string, unknown> | null
    requestId: string | null
    createdAt: string
}

export interface AdminAuditLogsInput {
    action?: string
    targetType?: string
    targetId?: string
    actorUserId?: number
    from?: Date
    to?: Date
    page?: number
    pageSize?: number
}

export interface AdminAuditLogsResult {
    items: AdminAuditLogView[]
    page: number
    pageSize: number
    total: number
}

function getPrismaLate(): PrismaClientLike {
    return getPrisma()
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, Math.floor(value)))
}

function isValidDate(value: Date | undefined): value is Date {
    return value instanceof Date && !Number.isNaN(value.getTime())
}

/**
 * sanitizeSnapshot — projection سختگیرانه روی مقدار Json.
 * فقط `string | number | boolean | null` و آرایه‌ی صرفاً از همین‌ها عبور می‌کند.
 * هر مقدار تودرتو/ناشناخته باعث حذف همان کلید می‌شود (نه render خام).
 */
export function sanitizeSnapshot(value: unknown): Record<string, unknown> | null {
    if (value === null || value === undefined) return null
    if (typeof value !== "object" || Array.isArray(value)) return null
    const out: Record<string, unknown> = {}
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        const safe = sanitizeValue(raw)
        if (safe !== undefined) out[key] = safe
    }
    return Object.keys(out).length > 0 ? out : null
}

function sanitizeValue(
    value: unknown,
): string | number | boolean | null | (string | number | boolean | null)[] | undefined {
    if (value === null) return null
    if (typeof value === "string") return value.slice(0, SNAPSHOT_STRING_MAX)
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined
    if (typeof value === "boolean") return value
    if (Array.isArray(value)) {
        const arr: (string | number | boolean | null)[] = []
        for (const item of value) {
            if (item === null) {
                arr.push(null)
            } else if (typeof item === "string") {
                arr.push(item.slice(0, SNAPSHOT_STRING_MAX))
            } else if (typeof item === "number") {
                if (!Number.isFinite(item)) return undefined
                arr.push(item)
            } else if (typeof item === "boolean") {
                arr.push(item)
            } else {
                // شیء تودرتو → کل کلید حذف می‌شود
                return undefined
            }
        }
        return arr
    }
    return undefined
}

/** projection یک ردیف خام (Prisma) → DTO امن. ردیف ناقص → null. */
export function toAdminAuditLogView(row: unknown): AdminAuditLogView | null {
    if (row === null || typeof row !== "object") return null
    const r = row as Record<string, unknown>
    if (typeof r.id !== "string" || typeof r.action !== "string") return null
    if (typeof r.targetType !== "string" || typeof r.targetId !== "string") return null
    if (typeof r.actorUserId !== "number" || !Number.isInteger(r.actorUserId)) return null

    const createdAt =
        r.createdAt instanceof Date
            ? r.createdAt.toISOString()
            : typeof r.createdAt === "string"
              ? r.createdAt
              : null
    if (createdAt === null) return null

    return {
        id: r.id,
        actorUserId: r.actorUserId,
        actorUsername: typeof r.actorUsername === "string" ? r.actorUsername : null,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        before: sanitizeSnapshot(r.before),
        after: sanitizeSnapshot(r.after),
        requestId: typeof r.requestId === "string" ? r.requestId : null,
        createdAt,
    }
}

/**
 * listAdminAuditLogs — فهرست صفحه‌بندی‌شده + فیلترها.
 *
 * بازه‌ی زمانی: اگر `from` داده شود همان است؛ اگر `targetId` داده شود بازه‌ی
 * پایین باز می‌شود (لینک «تاریخچه‌ی یک کد» نباید با پنجره‌ی ۷ روزه پنهان شود)؛
 * در غیر این صورت پنجره‌ی پیش‌فرض ۷ روزه مثل بقیه‌ی خواننده‌های ادمین.
 */
export async function listAdminAuditLogs(
    prisma: PrismaClientLike | undefined,
    input: AdminAuditLogsInput = {},
): Promise<AdminAuditLogsResult> {
    const client = prisma ?? getPrismaLate()
    const page = clampInt(input.page, 1, Number.MAX_SAFE_INTEGER, 1)
    const pageSize = clampInt(
        input.pageSize,
        1,
        ADMIN_AUDIT_MAX_PAGE_SIZE,
        ADMIN_AUDIT_DEFAULT_PAGE_SIZE,
    )
    const now = new Date()
    const to = isValidDate(input.to) ? input.to : now
    const from = isValidDate(input.from)
        ? input.from
        : input.targetId
          ? undefined
          : new Date(to.getTime() - ADMIN_AUDIT_DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000)

    const where: Record<string, unknown> = {
        createdAt: from ? { gte: from, lte: to } : { lte: to },
    }
    if (input.action) where.action = input.action
    if (input.targetType) where.targetType = input.targetType
    if (input.targetId) where.targetId = input.targetId
    if (
        typeof input.actorUserId === "number" &&
        Number.isInteger(input.actorUserId) &&
        input.actorUserId > 0
    ) {
        where.actorUserId = input.actorUserId
    }

    const rows = (await client.adminAuditLog.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
            id: true,
            actorUserId: true,
            action: true,
            targetType: true,
            targetId: true,
            before: true,
            after: true,
            requestId: true,
            createdAt: true,
        },
    })) as Record<string, unknown>[]

    const total = (await client.adminAuditLog.count({ where })) as number

    // نام actor — فقط برای idهای همین صفحه و فقط id+username.
    const actorIds = [
        ...new Set(
            rows
                .map((r) => r.actorUserId)
                .filter((id): id is number => typeof id === "number" && Number.isInteger(id)),
        ),
    ]
    const nameById = new Map<number, string>()
    if (actorIds.length > 0) {
        try {
            const users = (await client.user.findMany({
                where: { id: { in: actorIds } },
                select: { id: true, username: true },
            })) as { id?: unknown; username?: unknown }[]
            for (const u of users) {
                if (typeof u.id === "number" && typeof u.username === "string") {
                    nameById.set(u.id, u.username)
                }
            }
        } catch {
            // نام actor optional است؛ شکست آن فهرست را نمی‌شکند.
        }
    }

    const items: AdminAuditLogView[] = []
    for (const row of rows) {
        const actorUserId = row.actorUserId as number
        const view = toAdminAuditLogView({
            ...row,
            actorUsername: nameById.get(actorUserId) ?? null,
        })
        if (view !== null) items.push(view)
    }

    return { items, page, pageSize, total }
}
