import type { Prisma } from "@prisma/client"
import { getPrisma } from "@/app/lib/getPrisma"
import { getPushConfig } from "@/app/lib/push/config"
import { buildTaskReminderPayload } from "@/app/lib/push/payload"
import { sendPushNotification } from "@/app/lib/push/sender"
import { createObservabilityContext } from "@/src/lib/observability/context"
import { recordError } from "@/src/lib/observability/recordError"
import {
    claimReminderDelivery,
    markDeliveryFailed,
    markDeliveryGone,
    markDeliverySent,
} from "./reminderDelivery.service"

// ADR-07 فاز ۳-B — Reminder Scheduler (سرور، دسته‌ای و idempotent).
//
// زنجیره: Scheduler → Reminder query/service → Push sender → Web Push.
// این ماژول مستقیماً از `web-push` استفاده نمی‌کند؛ فقط `sendPushNotification` (فاز ۳-A).
//
// سیاست stale reminder (مستند): یادآوری‌هایی که بیش از STALE_REMINDER_WINDOW_MS از زمانشان
// گذشته باشد ارسال نمی‌شوند (بک‌لاگ کهنه به دستگاه‌ها هجوم نمی‌آورد). چون claim یکتاست، حتی
// بدون این پنجره هم هر یادآوری حداکثر یک‌بار ارسال می‌شود؛ این پنجره یک تصمیم محصولی است.
//
// سیاست تحویل: at-most-once برای هر (task, subscription, reminderAt). شکست موقت ثبت می‌شود ولی
// retry خودکار ندارد (حذف ریسک ارسال تکراری).

export const SCHEDULER_BATCH_SIZE = 50
export const STALE_REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000 // ۲۴ ساعت

/**
 * شرط due بودن یادآوری — pure و قابل‌تست بدون DB (مرزها این‌جا قابل اثبات‌اند).
 * - future (`reminderAt > now`) → خارج (`lte: now`)
 * - داخل پنجه (`reminderAt >= now - window`) → شامل (مرز دقیقاً ۲۴h شامل است)
 * - خارج پنجه (`reminderAt < now - window`) → خارج (`gte`)
 * - Task بسته (DONE) و بدون reminderAt → خارج
 * فقط instant/UTC — هیچ Jalali/timezone این‌جا نیست.
 */
export function buildDueReminderWhere(
    now: Date,
    staleWindowMs: number = STALE_REMINDER_WINDOW_MS,
): Prisma.TaskWhereInput {
    return {
        status: { not: "DONE" },
        reminderAt: { not: null, lte: now, gte: new Date(now.getTime() - staleWindowMs) },
    }
}

export type SchedulerRunSummary = {
    ran: boolean
    reason?: "not_configured"
    dueTasks: number
    sent: number
    failed: number
    gone: number
    skipped: number
}

type DueTask = { id: number; userId: number; title: string; reminderAt: Date | null }
type Sub = { id: string; userId: number; endpoint: string; p256dh: string; auth: string }

/**
 * یک اجرای کامل scheduler: پیدا کردن یادآوری‌های due و ارسال Push برای subscriptionهای کاربر.
 * `now` تزریق‌پذیر است تا تست deterministic باشد. هیچ Jalali/timezone محاسبه‌ای این‌جا نیست —
 * فقط مقایسه‌ی instant استاندارد: reminderAt <= now (و >= now - پنجره‌ی stale).
 */
export async function runReminderScheduler(
    now: Date = new Date(),
    options?: { batchSize?: number },
): Promise<SchedulerRunSummary> {
    const summary: SchedulerRunSummary = { ran: true, dueTasks: 0, sent: 0, failed: 0, gone: 0, skipped: 0 }

    // بدون VAPID configure شده، هیچ ارسالی ممکن نیست؛ به‌جای crash، اجرای no-op.
    const config = getPushConfig()
    if (!config.ok) return { ...summary, ran: false, reason: "not_configured" }

    const prisma = getPrisma()
    const batchSize = options?.batchSize ?? SCHEDULER_BATCH_SIZE

    const tasks = (await prisma.task.findMany({
        where: buildDueReminderWhere(now, STALE_REMINDER_WINDOW_MS),
        orderBy: { reminderAt: "asc" },
        take: batchSize,
        select: { id: true, userId: true, title: true, reminderAt: true },
    })) as DueTask[]

    summary.dueTasks = tasks.length
    if (tasks.length === 0) return summary

    // prefetch اشتراک‌های همه‌ی کاربران دسته (بدون N+1)
    const userIds = Array.from(new Set(tasks.map((t) => t.userId)))
    const subscriptions = (await prisma.pushSubscription.findMany({
        where: { userId: { in: userIds } },
        select: { id: true, userId: true, endpoint: true, p256dh: true, auth: true },
    })) as Sub[]

    const subsByUser = new Map<number, Sub[]>()
    for (const sub of subscriptions) {
        const list = subsByUser.get(sub.userId) ?? []
        list.push(sub)
        subsByUser.set(sub.userId, list)
    }

    const context = createObservabilityContext("reminder-scheduler")

    for (const task of tasks) {
        if (!task.reminderAt) continue
        const reminderAt = task.reminderAt
        const subs = subsByUser.get(task.userId) ?? []
        if (subs.length === 0) continue

        const payload = buildTaskReminderPayload({
            taskId: task.id,
            title: `⏰ یادآوری: ${task.title}`.slice(0, 200),
            body: "زمان انجام این کار فرا رسیده است.",
            url: `/dashboard?taskId=${task.id}`,
        })

        // هر subscription مستقل پردازش می‌شود؛ شکست یکی، بقیه/batch را متوقف نمی‌کند.
        for (const sub of subs) {
            try {
                const claim = await claimReminderDelivery({
                    taskId: task.id,
                    subscriptionId: sub.id,
                    reminderAt,
                })
                if (!claim) {
                    // قبلاً claim شده → بدون ارسال دوباره (idempotency)
                    summary.skipped += 1
                    continue
                }

                const result = await sendPushNotification(
                    { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
                    payload,
                    { envSource: process.env },
                )

                if (result.ok) {
                    await markDeliverySent(claim.id, now)
                    summary.sent += 1
                    continue
                }

                if (result.reason === "gone") {
                    await markDeliveryGone(claim.id, `HTTP_${result.statusCode ?? "GONE"}`)
                    // subscription منقضی → حذف تا هرگز در ارسال‌های بعدی استفاده نشود
                    await prisma.pushSubscription.deleteMany({ where: { id: sub.id } })
                    summary.gone += 1
                    continue
                }

                // invalid_payload / not_configured / failed → ثبت شکست، ادامه‌ی batch
                const failureCode =
                    result.reason === "failed" ? `HTTP_${result.statusCode ?? "ERR"}` : result.reason.toUpperCase()
                await markDeliveryFailed(claim.id, failureCode)
                summary.failed += 1
                await recordError(new Error(`reminder push delivery failed: ${failureCode}`), context, {
                    category: "EXTERNAL_SERVICE",
                    severity: "WARNING",
                })
            } catch (error) {
                // خطای غیرمنتظره‌ی یک delivery نباید batch را بشکند
                summary.failed += 1
                await recordError(error, context, { category: "INTERNAL", severity: "WARNING" })
            }
        }
    }

    return summary
}
