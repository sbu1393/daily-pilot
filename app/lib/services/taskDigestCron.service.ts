/*
 * اعلان‌های زمان‌بندی‌شده‌ی تسک‌ها — سرویس تریگر (cron)
 * ---------------------------------------------------------------
 * سه نوع اعلان روزانه:
 *   • morning  → تعداد تسک‌های ناتمامِ «امروز» (به وقت محلی هر کاربر)
 *   • night    → یادآوری مرور تسک‌های ناتمامِ «امروز»
 *   • overdue  → تسک‌های ناتمامِ روزهای قبل (dayKey < امروز)
 *
 * قواعد:
 * - اگر برای کاربر هیچ تسک مرتبطی نباشد، هیچ Push‌ای ارسال نمی‌شود.
 * - کاربران بدون اشتراک Push از همان کوئری DB حذف می‌شوند.
 * - روز هر کاربر با timezone خودش محاسبه می‌شود (همان قرارداد canonical dayKey).
 * - متن پیام‌ها ثابت است و هیچ نام/ایمیل/شناسه‌ی کاربری داخل payload نمی‌رود.
 * - idempotency: پیش از ارسال، ردیف {userId, type, dayKey} به‌صورت اتمیک در
 *   `SentNotification` claim می‌شود؛ اجرای دوباره در همان روز ارسال نمی‌کند.
 * - fail-open: خطای یک کاربر بقیه‌ی حلقه را متوقف نمی‌کند.
 */

import { getPrisma } from "@/app/lib/getPrisma"
import { localDayKey } from "@/app/lib/reminderSchedule"
import { isPushConfigured, type EnvLike } from "@/app/lib/push/config"
import type { PushPayload } from "@/app/lib/push/adapter"
import {
    sendPushToUser,
    type PushSendSummary,
} from "@/app/lib/services/push.service"
import { faDigits } from "@/app/lib/time"

export const TASK_DIGEST_URL = "/dashboard"

/** سقف پردازش هر اجرا — کران‌دار کردن زمان اجرای تریگر. */
export const MAX_USERS_PER_RUN = 500

export type TaskDigestKind = "morning" | "night" | "overdue"

export const TASK_DIGEST_KINDS: readonly TaskDigestKind[] = ["morning", "night", "overdue"]

export function isTaskDigestKind(value: string | null | undefined): value is TaskDigestKind {
    return value === "morning" || value === "night" || value === "overdue"
}

export type TaskDigestCandidate = {
    id: number
    timezone: string
}

export type TaskDigestPrismaLike = {
    user: {
        findMany: (args: unknown) => Promise<TaskDigestCandidate[]>
    }
    task: {
        count: (args: unknown) => Promise<number>
    }
    sentNotification: {
        create: (args: unknown) => Promise<{ id: string }>
        deleteMany: (args: unknown) => Promise<{ count: number }>
    }
}

export type TaskDigestSummary = {
    /** آیا کلیدهای VAPID روی سرور تنظیم شده‌اند؟ */
    configured: boolean
    kind: TaskDigestKind
    /** چند کاربر دارای اشتراک Push بررسی شد */
    scanned: number
    /** چند کاربر تسک مرتبط داشتند و ارسال برایشان claim شد */
    matched: number
    /** چند کاربر به‌خاطر ارسال قبلی در همان روز نادیده گرفته شدند */
    skipped: number
    /** مجموع تسک‌های گزارش‌شده در همه‌ی کاربران */
    tasks: number
    /** مجموع دستگاه‌های موفق/ناموفق و اشتراک‌های مرده */
    sent: number
    failed: number
    removed: number
    /** کاربرانی که ارسال برایشان خطا داد (fail-open) */
    errored: number
    /** آیا سقف پردازش بریده شد؟ */
    truncated: boolean
}

/**
 * فیلتر Prisma برای شمارش تسک‌های مرتبط با هر نوع اعلان.
 * «معوقه» = تسک ناتمام با dayKey قبل از امروز (مدل Task فیلد deadline جدا ندارد؛
 * dayKey همان روز سررسید canonical است — هم‌راستا با getOverdueTasks).
 */
export function buildTaskDigestFilter(
    kind: TaskDigestKind,
    userId: number,
    todayKey: string,
): {
    userId: number
    status: { not: "DONE" }
    dayKey: string | { lt: string }
} {
    if (kind === "overdue") {
        return { userId, status: { not: "DONE" }, dayKey: { lt: todayKey } }
    }

    return { userId, status: { not: "DONE" }, dayKey: todayKey }
}

export function buildTaskDigestPayload(
    kind: TaskDigestKind,
    count: number,
    dayKey: string,
): PushPayload {
    if (kind === "morning") {
        return {
            title: "روزساز — برنامه امروز",
            body: `☀️ صبح بخیر! امروز ${faDigits(count)} تسک در انتظار توست. بزن بریم!`,
            url: TASK_DIGEST_URL,
            tag: `dp-morning-${dayKey}`,
        }
    }

    if (kind === "night") {
        return {
            title: "روزساز — مرور شبانه",
            body: "🌙 خسته نباشی! نگاهی به تسک‌های امروز بنداز و برای استراحت آماده شو.",
            url: TASK_DIGEST_URL,
            tag: `dp-night-${dayKey}`,
        }
    }

    return {
        title: "روزساز — تسک‌های معوقه",
        body: "⚡️ چند تسک معوقه داری. با یک همت کوچیک می‌تونی پرونده‌شون رو ببندی!",
        url: TASK_DIGEST_URL,
        tag: `dp-overdue-${dayKey}`,
    }
}

export function isUniqueViolation(error: unknown): boolean {
    return (error as { code?: unknown } | null)?.code === "P2002"
}

/**
 * claim اتمیک یک اعلان برای {کاربر، نوع، روز}.
 * `create` + unique constraint هم «بررسی وجود» و هم «رزرو» را در یک عملیات
 * انجام می‌دهد، پس دو اجرای هم‌زمان cron نمی‌توانند هر دو ارسال کنند.
 */
async function claimSentNotification(
    prisma: TaskDigestPrismaLike,
    userId: number,
    kind: TaskDigestKind,
    dayKey: string,
): Promise<boolean> {
    try {
        await prisma.sentNotification.create({
            data: { userId, type: kind, dayKey },
            select: { id: true },
        })
        return true
    } catch (error) {
        if (isUniqueViolation(error)) return false
        throw error
    }
}

export async function runTaskDigestCron(
    kind: TaskDigestKind,
    now: Date = new Date(),
    options: {
        prisma?: TaskDigestPrismaLike
        env?: EnvLike
        limit?: number
        /** قابل تزریق برای تست — پیش‌فرض همان سرویس واقعی Push است */
        send?: (userId: number, payload: PushPayload) => Promise<PushSendSummary>
    } = {},
): Promise<TaskDigestSummary> {
    const limit = options.limit ?? MAX_USERS_PER_RUN
    const summary: TaskDigestSummary = {
        configured: isPushConfigured(options.env),
        kind,
        scanned: 0,
        matched: 0,
        skipped: 0,
        tasks: 0,
        sent: 0,
        failed: 0,
        removed: 0,
        errored: 0,
        truncated: false,
    }

    if (!summary.configured) return summary

    const prisma = (options.prisma ??
        (getPrisma() as unknown as TaskDigestPrismaLike)) as TaskDigestPrismaLike
    const send =
        options.send ??
        ((userId, payload) => sendPushToUser(userId, payload, { env: options.env }))

    // عمداً هیچ فیلتر platform/native اینجا نیست: هر کاربری که حداقل یک ردیف
    // اشتراک Web Push دارد کاندید است — Desktop، Mobile Web یا Capacitor WebView.
    const candidates = await prisma.user.findMany({
        where: { pushSubscriptions: { some: {} } },
        take: limit,
        select: { id: true, timezone: true },
    })

    summary.scanned = candidates.length
    summary.truncated = candidates.length === limit

    for (const candidate of candidates) {
        const todayKey = localDayKey(now, candidate.timezone)
        const count = await prisma.task.count({
            where: buildTaskDigestFilter(kind, candidate.id, todayKey),
        })

        // هیچ تسکی برای گزارش نیست → هیچ اعلانی ارسال نمی‌شود
        if (count <= 0) continue

        // اگر همین امروز برای همین کاربر/نوع ارسال شده → دوباره نفرست
        const claimed = await claimSentNotification(prisma, candidate.id, kind, todayKey)
        if (!claimed) {
            summary.skipped += 1
            continue
        }

        summary.matched += 1
        summary.tasks += count

        try {
            const result = await send(
                candidate.id,
                buildTaskDigestPayload(kind, count, todayKey),
            )

            summary.sent += result.sent
            summary.failed += result.failed
            summary.removed += result.removed
        } catch {
            // fail-open — خطای یک کاربر نباید بقیه‌ی اجرا را متوقف کند.
            // claim آزاد می‌شود تا اجرای بعدی همان روز بتواند دوباره تلاش کند.
            summary.errored += 1
            try {
                await prisma.sentNotification.deleteMany({
                    where: { userId: candidate.id, type: kind, dayKey: todayKey },
                })
            } catch {
                // best-effort cleanup
            }
        }
    }

    return summary
}
