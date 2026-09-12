import { PrismaClient } from "@prisma/client"

/**
 * H1 (audit) — تک‌نمونه‌ی PrismaClient در تمام محیط‌ها.
 *
 * قبلاً کش فقط وقتی `NODE_ENV !== "production"` بود، یعنی در production هر فراخوانی
 * یک کلاینت تازه (با استخر اتصال مخصوص خودش) می‌ساخت و هیچ‌وقت disconnect نمی‌شد →
 * اشباع اتصال‌های Neon زیر بار واقعی. حالا کش بدون قید محیط انجام می‌شود تا:
 * - در production: یک کلاینت به ازای هر پروسه (بدون انفجار استخر اتصال)
 * - در development: زنده ماندن نمونه روی globalThis در HMR (بدون کلاینت‌های یتیم)
 */
const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined }

export const getPrisma = (): PrismaClient => {
    const prisma = globalForPrisma.prisma ?? new PrismaClient()
    globalForPrisma.prisma = prisma
    return prisma
}
