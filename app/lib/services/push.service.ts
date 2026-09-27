/*
 * یادآورها — سرویس Web Push
 * ---------------------------------------------------------------
 * مسئولیت‌ها:
 *  - ذخیره/حذف اشتراک مرورگر (subscription) برای کاربر جاری — همیشه userId-scoped.
 *  - ارسال payload یادآور به همه‌ی دستگاه‌های یک کاربر.
 *
 * تصمیم‌های طراحی:
 *  - `endpoint` کلید یکتای واقعی است: یک مرورگر/دستگاه = یک ردیف. اگر همان
 *    endpoint دوباره ثبت شود، ردیف به کاربر جاری نسبت داده و کلیدهایش
 *    به‌روزرسانی می‌شود (اگر کاربر دیگری روی همان دستگاه وارد شده باشد،
 *    اعلان‌های کاربر قبلی دیگر به آن دستگاه نمی‌رود).
 *  - سقف تعداد اشتراک per user (MAX_SUBSCRIPTIONS_PER_USER) تا یک کاربر
 *    نتواند جدول را با endpoint جعلی پر کند؛ قدیمی‌ترین‌ها prune می‌شوند.
 *  - ارسال fail-open است: خطای یک دستگاه هرگز کل حلقه/مسیر را نمی‌شکند و
 *    اشتراک مرده (404/410) حذف می‌شود.
 *  - هیچ محتوای تسک/ایمیل/شناسه‌ی کاربر در payload نمی‌رود (فقط title/body/url).
 */

import { getPrisma } from "@/app/lib/getPrisma"
import {
    deliverPush,
    type PushDelivery,
    type PushPayload,
    type PushTarget,
} from "@/app/lib/push/adapter"
import { readPushConfiguration, type EnvLike } from "@/app/lib/push/config"

export const MAX_SUBSCRIPTIONS_PER_USER = 10
export const MAX_ENDPOINT_LENGTH = 2048
export const MAX_KEY_LENGTH = 255

export type PrismaLike = {
    pushSubscription: {
        upsert: (args: unknown) => Promise<{ id: string }>
        deleteMany: (args: unknown) => Promise<{ count: number }>
        count: (args: unknown) => Promise<number>
        findMany: (args: unknown) => Promise<
            Array<{ id: string; endpoint: string; p256dh: string; auth: string }>
        >
    }
}

export type PushSubscriptionInput = {
    endpoint: string
    p256dh: string
    auth: string
}

export type SaveSubscriptionResult = {
    id: string
    pruned: number
}

export type PushSendSummary = {
    /** آیا کلیدهای VAPID روی سرور تنظیم شده‌اند؟ (نبود → هیچ ارسالی انجام نمی‌شود) */
    configured: boolean
    /** تعداد دستگاه‌هایی که اعلان برایشان ارسال شد */
    sent: number
    /** شکست موقت (provider/شبکه) — ردیف دست‌نخورده می‌ماند */
    failed: number
    /** اشتراک‌های مرده (404/410) که پاک شدند */
    removed: number
}

function asPrisma(prisma?: PrismaLike): PrismaLike {
    return (prisma ?? (getPrisma() as unknown as PrismaLike)) as PrismaLike
}

/**
 * ذخیره‌ی اشتراک + اعمال سقف per user.
 * همیشه با `userId` احرازهویت‌شده صدا زده می‌شود — هیچ‌جای این ماژول userId از
 * ورودی client نمی‌گیرد.
 */
export async function savePushSubscription(
    userId: number,
    input: PushSubscriptionInput,
    prisma?: PrismaLike,
): Promise<SaveSubscriptionResult> {
    const db = asPrisma(prisma)

    const saved = await db.pushSubscription.upsert({
        where: { endpoint: input.endpoint },
        create: {
            userId,
            endpoint: input.endpoint,
            p256dh: input.p256dh,
            auth: input.auth,
        },
        update: {
            userId,
            p256dh: input.p256dh,
            auth: input.auth,
        },
        select: { id: true },
    })

    const total = await db.pushSubscription.count({ where: { userId } })
    let pruned = 0

    if (total > MAX_SUBSCRIPTIONS_PER_USER) {
        // قدیمی‌ترین‌ها (کم‌کاربردترین) حذف می‌شوند — جدیدترین‌ها می‌مانند
        const keep = await db.pushSubscription.findMany({
            where: { userId },
            orderBy: { updatedAt: "desc" },
            take: MAX_SUBSCRIPTIONS_PER_USER,
            select: { id: true },
        })

        const keepIds = keep.map((row) => row.id)
        const result = await db.pushSubscription.deleteMany({
            where: { userId, id: { notIn: keepIds } },
        })
        pruned = result.count
    }

    return { id: saved.id, pruned }
}

/** حذف اشتراک — فقط اگر متعلق به همین کاربر باشد (بدون IDOR). */
export async function removePushSubscription(
    userId: number,
    endpoint: string,
    prisma?: PrismaLike,
): Promise<{ removed: number }> {
    const db = asPrisma(prisma)
    const result = await db.pushSubscription.deleteMany({ where: { endpoint, userId } })
    return { removed: result.count }
}

export async function countPushSubscriptions(userId: number, prisma?: PrismaLike): Promise<number> {
    const db = asPrisma(prisma)
    return db.pushSubscription.count({ where: { userId } })
}

/**
 * ارسال یک payload به همه‌ی دستگاه‌های کاربر.
 * هرگز برای خطای provider throw نمی‌کند؛ فقط خطای DB بالا می‌رود (مسیر 500).
 */
export async function sendPushToUser(
    userId: number,
    payload: PushPayload,
    options: {
        prisma?: PrismaLike
        env?: EnvLike
        deliver?: (target: PushTarget, payload: PushPayload) => Promise<PushDelivery>
    } = {},
): Promise<PushSendSummary> {
    const summary: PushSendSummary = { configured: false, sent: 0, failed: 0, removed: 0 }

    const configuration = readPushConfiguration(options.env)
    if (!configuration.configured) return summary

    summary.configured = true
    const db = asPrisma(options.prisma)

    const rows = await db.pushSubscription.findMany({
        where: { userId },
        orderBy: { updatedAt: "desc" },
        take: MAX_SUBSCRIPTIONS_PER_USER,
        select: { id: true, endpoint: true, p256dh: true, auth: true },
    })

    const deliver =
        options.deliver ??
        ((target: PushTarget, body: PushPayload) =>
            deliverPush(target, body, configuration.config))

    for (const row of rows) {
        const result = await deliver(
            { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth },
            payload,
        )

        if (result.ok) {
            summary.sent += 1
            continue
        }

        if (result.gone) {
            // اشتراک مرده (uninstalled/expired) → ردیف پاک می‌شود تا دفعه‌ی بعد تلاش نشود
            await db.pushSubscription.deleteMany({ where: { id: row.id, userId } })
            summary.removed += 1
            continue
        }

        summary.failed += 1
    }

    return summary
}
