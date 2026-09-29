// AI Quota v2 — نوشتن audit اقدامات ادمین (Phase 2)
//
// AdminAuditLog **append-only** است: هیچ update/delete روی آن وجود ندارد و در
// schema هم FK به User ندارد، چون حذف یک ادمین نباید رد audit را از بین ببرد.
//
// این ماژول فقط «نوشتن» را می‌دهد — خواندن/نمایش آن در فاز بعدی (Admin UI) است.

import type { PrismaClientLike } from "./aiUsage.service"

/** metadیتای مجاز برای snapshot قبل/بعد — فقط شکل‌های ساده و غیرحساس. */
export type AuditSnapshotValue =
    | string
    | number
    | boolean
    | null
    | (string | number | boolean | null)[]

export interface AdminAuditInput {
    /** actor از session (requireAdmin) — هرگز از بدنه‌ی درخواست. */
    actorUserId: number
    /** مثل "quota_policy.updated" | "promo.created" | "promo.updated" */
    action: string
    targetType: string
    targetId: string
    before?: Record<string, AuditSnapshotValue> | null
    after?: Record<string, AuditSnapshotValue> | null
    requestId?: string | null
}

/**
 * best-effort: هیچ‌وقت throw نمی‌کند و هرگز جریان عملیات را fail نمی‌کند.
 *
 * تصمیم عمدی: شکست audit نباید یک ادمین را از تغییر یک سقف یا ساخت یک کد هدیه
 * بازدارد (که خودش یک عملیات کم‌خطر است). در عوض شکست با recordError در لایه‌ی
 * route گزارش می‌شود؛ این تابع فقط best-effort است و `false` برمی‌گرداند.
 */
export async function writeAdminAuditLog(
    prisma: PrismaClientLike,
    input: AdminAuditInput,
): Promise<boolean> {
    try {
        await prisma.adminAuditLog.create({
            data: {
                actorUserId: input.actorUserId,
                action: input.action,
                targetType: input.targetType,
                targetId: input.targetId,
                before: input.before ?? undefined,
                after: input.after ?? undefined,
                requestId: input.requestId ?? undefined,
            },
        })
        return true
    } catch {
        return false
    }
}
