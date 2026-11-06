/*
 * یادآور بازگشت کاربران غیرفعال (Inactivity / Re-engagement)
 * ---------------------------------------------------------------
 * هدف: کاربری که ۳ روز هیچ فعالیتی نداشته، یک پیام کوتاه و صمیمی بگیرد.
 *
 * «فعالیت» از دو منبع قابل‌اثبات خوانده می‌شود:
 *   • User.lastSeenAt — با throttle ۳۰ دقیقه‌ای در مسیرهای احرازهویت‌شده
 *     (ورود، باز کردن داشبورد، لیست/ایجاد/ویرایش/تکمیل تسک و planner) به‌روز می‌شود.
 *   • Task.updatedAt — برای وقتی که ثبت/ویرایش تسک انجام شده ولی آخرین فعالیت
 *     به هر دلیلی ثبت نشده است (telemetry fail-safe).
 *
 * قواعد ضداسپم:
 *   • آستانه: ۳ روز بی‌فعالیتی (rolling، نه روز تقویمی).
 *   • Cool-down: حداکثر یک پیام بازگشت در هر ۷ روز، با ردیف
 *     SentNotification(type="inactivity", createdAt).
 *   • حساب تازه (کوچک‌تر از آستانه) هرگز پیام نمی‌گیرد.
 *   • کاربری که تسکی با updatedAt اخیر دارد، غیرفعال حساب نمی‌شود.
 *   • claim اتمیک با unique(userId, type, dayKey): اجرای هم‌زمان/تکراری همان روز
 *     دوباره ارسال نمی‌کند. خطای P2002 یعنی «قبلاً claim شده» → skip.
 *   • هماهنگی با overdue: سرویس digest برای کاربران خواب‌آلود `overdue` نمی‌فرستد
 *     (تا پیام روزانهٔ معوقه، cool-down بازگشت را بی‌اثر نکند). در روز مرز هم اگر
 *     در ۲۴ ساعت گذشته overdue رفته باشد، بازگشت یک روز صبر می‌کند.
 *   • fail-open: خطای claim/ارسال یک کاربر بقیهٔ حلقه را متوقف نمی‌کند.
 *
 * هیچ نام/ایمیل/شناسه‌ای در payload نمی‌رود؛ فقط title/body/url/tag.
 */

import { getPrisma } from "@/app/lib/getPrisma"
import { localDayKey } from "@/app/lib/reminderSchedule"
import { isPushConfigured, type EnvLike } from "@/app/lib/push/config"
import type { PushPayload } from "@/app/lib/push/adapter"
import {
    sendPushToUser,
    type PushSendSummary,
} from "@/app/lib/services/push.service"
import {
    INACTIVITY_NOTIFICATION_TYPE,
    OVERDUE_NOTIFICATION_TYPE,
    REENGAGEMENT_URL,
    inactivityCutoff,
    overdueQuietCutoff,
    reengagementCooldownCutoff,
} from "./inactivityPolicy"

export {
    INACTIVITY_DAYS,
    INACTIVITY_NOTIFICATION_TYPE,
    REENGAGEMENT_URL,
} from "./inactivityPolicy"
/** نام قدیمیِ ثابت cool-down برای سازگاری مصرف‌کننده‌های موجود. */
export { REENGAGEMENT_COOLDOWN_DAYS as COOLDOWN_DAYS } from "./inactivityPolicy"

/** سقف پردازش هر اجرا — کران‌دار کردن زمان اجرای تریگر. */
export const MAX_USERS_PER_RUN = 500

export type InactivityCandidate = {
    id: number
    timezone: string
    lastSeenAt: Date | null
    createdAt: Date
}

export type InactivityPrismaLike = {
    user: {
        findMany: (args: unknown) => Promise<InactivityCandidate[]>
    }
    sentNotification: {
        create: (args: unknown) => Promise<{ id: string }>
        deleteMany: (args: unknown) => Promise<{ count: number }>
    }
}

export type InactivitySummary = {
    /** آیا کلیدهای VAPID روی سرور تنظیم شده‌اند؟ */
    configured: boolean
    kind: typeof INACTIVITY_NOTIFICATION_TYPE
    /** چند کاربر غیرفعالِ واجد شرایط بررسی شد */
    scanned: number
    /** چند کاربر claim شدند و ارسال برایشان انجام شد */
    matched: number
    /** چند کاربر به‌خاطر claim قبلی (همان روز) نادیده گرفته شدند */
    skipped: number
    /** مجموع دستگاه‌های موفق/ناموفق و اشتراک‌های مرده */
    sent: number
    failed: number
    removed: number
    /** کاربرانی که claim/ارسال برایشان خطا داد (fail-open) */
    errored: number
    /** آیا سقف پردازش بریده شد؟ */
    truncated: boolean
}

export function buildInactivityPayload(dayKey: string): PushPayload {
    return {
        title: "روزساز — دلمان برایت تنگ شده",
        body: "🌱 جای خالیت در روزساز حس می‌شه! بیا با یک قدم کوچیک، برنامه امروزت رو بچینیم.",
        url: REENGAGEMENT_URL,
        tag: `dp-reengagement-${dayKey}`,
    }
}

function isUniqueViolation(error: unknown): boolean {
    return (error as { code?: unknown } | null)?.code === "P2002"
}

/**
 * claim اتمیک پیام بازگشت برای {کاربر، روز محلی}.
 * unique(userId, type, dayKey) هم بررسی وجود و هم رزرو را یک‌جا انجام می‌دهد.
 */
async function claimInactivityNotification(
    prisma: InactivityPrismaLike,
    userId: number,
    dayKey: string,
): Promise<boolean> {
    try {
        await prisma.sentNotification.create({
            data: { userId, type: INACTIVITY_NOTIFICATION_TYPE, dayKey },
            select: { id: true },
        })
        return true
    } catch (error) {
        if (isUniqueViolation(error)) return false
        throw error
    }
}

export async function runInactivityReminderCron(
    now: Date = new Date(),
    options: {
        prisma?: InactivityPrismaLike
        env?: EnvLike
        limit?: number
        /** قابل تزریق برای تست — پیش‌فرض همان سرویس واقعی Push است */
        send?: (userId: number, payload: PushPayload) => Promise<PushSendSummary>
    } = {},
): Promise<InactivitySummary> {
    const limit = options.limit ?? MAX_USERS_PER_RUN
    const summary: InactivitySummary = {
        configured: isPushConfigured(options.env),
        kind: INACTIVITY_NOTIFICATION_TYPE,
        scanned: 0,
        matched: 0,
        skipped: 0,
        sent: 0,
        failed: 0,
        removed: 0,
        errored: 0,
        truncated: false,
    }

    if (!summary.configured) return summary

    const prisma = (options.prisma ??
        (getPrisma() as unknown as InactivityPrismaLike)) as InactivityPrismaLike
    const send =
        options.send ??
        ((userId, payload) => sendPushToUser(userId, payload, { env: options.env }))

    const inactiveCutoff = inactivityCutoff(now)
    const cooldownCutoff = reengagementCooldownCutoff(now)
    const overdueQuiet = overdueQuietCutoff(now)

    // همهٔ شرط‌ها در DB اعمال می‌شوند (نه در حافظه) تا حلقه فقط واجدین شرایط را ببیند.
    const candidates = await prisma.user.findMany({
        where: {
            // فقط کاربرانی که واقعاً دستگاهی برای اعلان دارند.
            pushSubscriptions: { some: {} },
            // حساب تازه را قبل از گذشت آستانه نزن.
            createdAt: { lte: inactiveCutoff },
            OR: [
                { lastSeenAt: null },
                { lastSeenAt: { lte: inactiveCutoff } },
            ],
            // هیچ تسک جدید/ویرایش‌شده‌ای در بازهٔ اخیر نباشد.
            tasks: {
                none: { updatedAt: { gte: inactiveCutoff } },
            },
            // Cool-down هفت‌روزه — پیام بازگشت اخیر یعنی هنوز نه.
            // سکوت ۲۴ساعته پس از overdue — در روز مرز، دو پیام در یک روز نرود.
            sentNotifications: {
                none: {
                    OR: [
                        {
                            type: INACTIVITY_NOTIFICATION_TYPE,
                            createdAt: { gte: cooldownCutoff },
                        },
                        {
                            type: OVERDUE_NOTIFICATION_TYPE,
                            createdAt: { gte: overdueQuiet },
                        },
                    ],
                },
            },
        },
        orderBy: { lastSeenAt: "asc" },
        take: limit,
        select: { id: true, timezone: true, lastSeenAt: true, createdAt: true },
    })

    summary.scanned = candidates.length
    summary.truncated = candidates.length === limit

    for (const candidate of candidates) {
        const dayKey = localDayKey(now, candidate.timezone)

        // خطای claim یک کاربر نباید بقیه را متوقف کند (fail-open).
        let claimed: boolean
        try {
            claimed = await claimInactivityNotification(prisma, candidate.id, dayKey)
        } catch {
            summary.errored += 1
            continue
        }

        if (!claimed) {
            summary.skipped += 1
            continue
        }

        summary.matched += 1

        try {
            const result = await send(
                candidate.id,
                buildInactivityPayload(dayKey),
            )

            summary.sent += result.sent
            summary.failed += result.failed
            summary.removed += result.removed
        } catch {
            // claim آزاد می‌شود تا اجرای بعدی بتواند دوباره تلاش کند.
            summary.errored += 1
            try {
                await prisma.sentNotification.deleteMany({
                    where: {
                        userId: candidate.id,
                        type: INACTIVITY_NOTIFICATION_TYPE,
                        dayKey,
                    },
                })
            } catch {
                // best-effort cleanup
            }
        }
    }

    return summary
}
