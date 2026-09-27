/*
 * یادآورها — سرویس تریگر زمان‌بندی‌شده (cron)
 * ---------------------------------------------------------------
 * این سرویس «حلقه‌ی گمشده» را پر می‌کند: هر کس دیگری فقط زیرساخت ارسال را
 * داشت، ولی هیچ‌چیز یادآور را روی زمان کاربر صدا نمی‌زد.
 *
 * جریان:
 *  ۱. کلیدهای VAPID ست نشده‌اند → هیچ کاری انجام نمی‌شود (خروجی configured=false).
 *  ۲. کاربران نامزد: `reminderEnabled = true` **و** حداقل یک اشتراک Push فعال.
 *     (کاربران بدون دستگاه از همان کوئری DB حذف می‌شوند — نه در حافظه.)
 *  ۳. برای هر نامزد: پنجره‌ی سررسید بر اساس timezone خودش + ضد-تکرار روزانه.
 *  ۴. ارسال با `sendPushToUser` (وت‌شده) و ثبت `reminderSentOn` فقط در صورت
 *     **ارسال موفق** — اگر ارسال شکست بخورد، اجرای بعدی cron دوباره تلاش می‌کند.
 *
 * fail-open: خطای یک کاربر هرگز حلقه را متوقف نمی‌کند؛ فقط `failed` بالا می‌رود.
 * هیچ محتوای تسک/ایمیل/شناسه‌ای در payload نمی‌رود.
 */

import { getPrisma } from "@/app/lib/getPrisma"
import { isPushConfigured, type EnvLike } from "@/app/lib/push/config"
import { REMINDER_TARGET_URL } from "@/app/lib/reminder"
import { isReminderDue, localDayKey } from "@/app/lib/reminderSchedule"
import {
    sendPushToUser,
    type PushSendSummary,
} from "@/app/lib/services/push.service"
import type { PushPayload } from "@/app/lib/push/adapter"

/** سقف پردازش هر اجرا — کران‌دار کردن زمان اجرای تریگر. */
export const MAX_USERS_PER_RUN = 500

export type ReminderCronCandidate = {
    id: number
    timezone: string
    reminderTime: string
    reminderSentOn: string | null
}

export type ReminderCronPrismaLike = {
    user: {
        findMany: (args: unknown) => Promise<ReminderCronCandidate[]>
        update: (args: unknown) => Promise<unknown>
    }
}

export type ReminderCronSummary = {
    /** آیا کلیدهای VAPID روی سرور تنظیم شده‌اند؟ */
    configured: boolean
    /** چند کاربر نامزد (یادآور فعال + حداقل یک دستگاه) بررسی شد */
    scanned: number
    /** چند کاربر داخل پنجره‌ی سررسید بودند */
    due: number
    /** یادآورهای موفق (مجموع دستگاه‌ها) و ناموفق (مجموع دستگاه‌ها) */
    sent: number
    failed: number
    /** اشتراک‌های مرده‌ای که در همین اجرا پاک شدند */
    removed: number
    /** کاربرانی که ارسال برایشان خطا داد (fail-open) */
    errored: number
    /** آیا سقف پردازش بریده شد؟ (اجرای بعدی بقیه را می‌گیرد) */
    truncated: boolean
}

export function buildReminderPayload(args: {
    timezone: string
    reminderTime: string
    now: Date
}): PushPayload {
    return {
        title: "یادآور روزساز",
        body: "وقت برنامه‌ریزی روزت رسیده است ✨",
        url: REMINDER_TARGET_URL,
        tag: `dp-reminder-${localDayKey(args.now, args.timezone)}|${args.reminderTime}`,
    }
}

export async function runReminderCron(
    now: Date = new Date(),
    options: {
        prisma?: ReminderCronPrismaLike
        env?: EnvLike
        limit?: number
        /** قابل تزریق برای تست — پیش‌فرض همان سرویس واقعی Push است */
        send?: (userId: number, payload: PushPayload) => Promise<PushSendSummary>
    } = {},
): Promise<ReminderCronSummary> {
    const limit = options.limit ?? MAX_USERS_PER_RUN
    const summary: ReminderCronSummary = {
        configured: isPushConfigured(options.env),
        scanned: 0,
        due: 0,
        sent: 0,
        failed: 0,
        removed: 0,
        errored: 0,
        truncated: false,
    }

    if (!summary.configured) return summary

    const prisma = (options.prisma ??
        (getPrisma() as unknown as ReminderCronPrismaLike)) as ReminderCronPrismaLike
    const send = options.send ?? ((userId, payload) => sendPushToUser(userId, payload, { env: options.env }))

    const candidates = await prisma.user.findMany({
        where: {
            reminderEnabled: true,
            // فقط کاربرانی که واقعاً دستگاهی برای اعلان دارند (کار در DB، نه در حافظه)
            pushSubscriptions: { some: {} },
        },
        take: limit,
        select: { id: true, timezone: true, reminderTime: true, reminderSentOn: true },
    })

    summary.scanned = candidates.length
    summary.truncated = candidates.length === limit

    for (const candidate of candidates) {
        if (
            !isReminderDue({
                now,
                timezone: candidate.timezone,
                reminderTime: candidate.reminderTime,
                reminderSentOn: candidate.reminderSentOn,
            })
        ) {
            continue
        }

        summary.due += 1

        try {
            const result = await send(candidate.id, buildReminderPayload({
                timezone: candidate.timezone,
                reminderTime: candidate.reminderTime,
                now,
            }))

            summary.sent += result.sent
            summary.failed += result.failed
            summary.removed += result.removed

            // فقط ارسال موفق «امروز انجام شد» را ثبت می‌کند
            if (result.sent > 0) {
                await prisma.user.update({
                    where: { id: candidate.id },
                    data: { reminderSentOn: localDayKey(now, candidate.timezone) },
                })
            }
        } catch {
            // fail-open — یادآور یک کاربر نباید بقیه‌ی اجرا را متوقف کند
            summary.errored += 1
        }
    }

    return summary
}
