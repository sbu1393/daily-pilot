import { getPrisma } from "@/app/lib/getPrisma"
import type { PushSubscribeInput } from "@/app/schema/pushSchema"

// ADR-07 — لایه‌ی سرویس اشتراک Web Push.
// - ownership همیشه از userId سرور می‌آید (هرگز از body).
// - endpoint یکتاست؛ ثبت دوباره = update (بدون رکورد تکراری) + تازه‌سازی lastSeenAt.
// - حذف فقط در محدوده‌ی userId انجام می‌شود (deleteMany با فیلتر userId) تا کاربر نتواند
//   اشتراک دیگری را حذف کند؛ نبود رکورد هم idempotent است.

export type StoredPushSubscription = {
    id: string
    userId: number
    endpoint: string
    lastSeenAt: Date
}

export async function savePushSubscription(
    userId: number,
    input: PushSubscribeInput,
): Promise<StoredPushSubscription> {
    const row = await getPrisma().pushSubscription.upsert({
        where: { endpoint: input.endpoint },
        create: {
            userId,
            endpoint: input.endpoint,
            p256dh: input.keys.p256dh,
            auth: input.keys.auth,
        },
        update: {
            // همان endpoint دوباره ثبت شده (همان دستگاه یا ورود کاربر دیگر روی همان مرورگر)
            userId,
            p256dh: input.keys.p256dh,
            auth: input.keys.auth,
            lastSeenAt: new Date(),
        },
    })

    return { id: row.id, userId: row.userId, endpoint: row.endpoint, lastSeenAt: row.lastSeenAt }
}

export async function removePushSubscription(
    userId: number,
    endpoint: string,
): Promise<{ removed: boolean }> {
    const { count } = await getPrisma().pushSubscription.deleteMany({
        where: { endpoint, userId },
    })

    return { removed: count > 0 }
}
