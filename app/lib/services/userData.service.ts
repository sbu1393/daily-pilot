import bcrypt from "bcryptjs"

import { getPrisma } from "@/app/lib/getPrisma"
import { UserNotFoundError, WrongPasswordError } from "./errors"

/**
 * داده‌های قابل‌خروجی کاربر — فقط چیزهایی که واقعاً به او تعلق دارند.
 *
 * مرزهای امنیتی:
 * - `password` (هش) هرگز در `select` نیست؛ نه در خروجی و نه در حافظهٔ این تابع.
 * - `mustChangePassword`، `quotaAnchorAt` و `reminderSentOn` وضعیت داخلی/عملیاتی‌اند
 *   و به کاربر ارائه نمی‌شوند.
 * - اشتراک‌های Push (`endpoint`/`p256dh`/`auth`) و توکن‌های نشست/بازیابی خروجی
 *   نمی‌گیرند؛ این‌ها «اعتبارنامه» هستند نه «داده».
 */
export async function buildUserDataExport(userId: number) {
    const user = await getPrisma().user.findUnique({
        where: { id: userId },
        select: {
            id: true,
            username: true,
            email: true,
            firstName: true,
            lastName: true,
            birthDate: true,
            phone: true,
            image: true,
            timezone: true,
            locale: true,
            calendar: true,
            plan: true,
            role: true,
            reminderEnabled: true,
            reminderTime: true,
            tasks: {
                orderBy: { createdAt: "asc" },
                select: {
                    id: true,
                    title: true,
                    category: true,
                    categoryIcon: true,
                    priority: true,
                    score: true,
                    reason: true,
                    estimatedTime: true,
                    allocatedMinutes: true,
                    spentMinutes: true,
                    scheduledDate: true,
                    dayKey: true,
                    previousScheduledDate: true,
                    status: true,
                    completedAt: true,
                    completedOn: true,
                    createdAt: true,
                    updatedAt: true,
                    events: {
                        orderBy: { createdAt: "asc" },
                        select: { id: true, type: true, payload: true, createdAt: true },
                    },
                },
            },
            dailyPlans: {
                orderBy: { dayKey: "asc" },
                select: {
                    id: true,
                    dayKey: true,
                    availableMinutes: true,
                    planVersion: true,
                    rebalancedVersion: true,
                    createdAt: true,
                },
            },
            entitlement: {
                select: {
                    provider: true,
                    status: true,
                    planCode: true,
                    currentPeriodStart: true,
                    currentPeriodEnd: true,
                },
            },
        },
    })

    if (!user) throw new UserNotFoundError()

    const { tasks, dailyPlans, entitlement, reminderEnabled, reminderTime, ...profile } = user

    return {
        meta: {
            app: "روزساز",
            formatVersion: 1,
            exportedAt: new Date().toISOString(),
            note: "این فایل شامل داده‌های ذخیره‌شده روی سرور است؛ تنظیمات ظاهری ذخیره‌شده در دستگاه (تم/صدا) در آن نیست.",
        },
        profile,
        settings: { reminderEnabled, reminderTime },
        tasks,
        dailyPlans,
        entitlement,
    }
}

/**
 * حذف کامل حساب پس از تأیید رمز عبور.
 *
 * بیشتر داده‌ها با `onDelete: Cascade` در Prisma پاک می‌شوند (تسک‌ها، برنامه‌ها،
 * تیکت‌ها، پرداخت‌ها، اشتراک‌های Push، سهمیه‌ها و…). دو جدول عمداً FK به User
 * ندارند و باید صریح پاک شوند:
 *   • `ErrorLog.userId` — لاگ عملیاتی (بدون relation)
 *   • `OtpCode.email` — کدهای تأیید ایمیل (کلید ایمیل، نه userId)
 *
 * تراکنش تضمین می‌کند اگر حذف کاربر شکست بخورد، پاک‌سازی‌های قبلی rollback شوند.
 * `AdminAuditLog` دست‌نخورده می‌ماند: رد audit عملیات ادمین است و با حذف حساب
 * یک کاربر عادی نباید از بین برود.
 */
export async function deleteUserAccount(userId: number, password: string): Promise<void> {
    const prisma = getPrisma()

    const record = await prisma.user.findUnique({
        where: { id: userId },
        select: { password: true, email: true },
    })
    if (!record) throw new UserNotFoundError()

    const passwordMatches = await bcrypt.compare(password, record.password)
    if (!passwordMatches) throw new WrongPasswordError()

    await prisma.$transaction(async (tx) => {
        await tx.errorLog.deleteMany({ where: { userId } })
        await tx.otpCode.deleteMany({ where: { email: record.email } })
        await tx.user.delete({ where: { id: userId } })
    })
}
