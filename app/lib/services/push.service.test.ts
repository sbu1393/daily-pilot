import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* یادآورها — تست سرویس Web Push                                       */
/*                                                                     */
/* مرزهای تست:                                                          */
/* - Prisma فقط به‌صورت شیء mock تزریق می‌شود (هیچ DB واقعی).            */
/* - ارسال با `options.deliver` تزریق می‌شود؛ هیچ درخواست شبکه‌ای نیست.  */
/* - config از env تستی صریح می‌آید (هیچ secret واقعی خوانده نمی‌شود).    */
/* ------------------------------------------------------------------ */

import { PUSH_ENV } from "@/app/lib/push/config"
import type { PushDelivery, PushPayload } from "@/app/lib/push/adapter"
import {
    MAX_SUBSCRIPTIONS_PER_USER,
    countPushSubscriptions,
    removePushSubscription,
    savePushSubscription,
    sendPushToUser,
} from "./push.service"

const TEST_ENV = {
    [PUSH_ENV.publicKey]: "public-key-for-tests",
    [PUSH_ENV.privateKey]: "private-key-for-tests",
    [PUSH_ENV.subject]: "mailto:admin@example.com",
}

const USER = 7

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    endpoint: `https://push.example.com/${id}`,
    p256dh: `p256dh-${id}`,
    auth: `auth-${id}`,
    ...overrides,
})

function prismaMock(overrides: Record<string, unknown> = {}) {
    return {
        pushSubscription: {
            upsert: vi.fn(async () => ({ id: "sub_1" })),
            deleteMany: vi.fn(async () => ({ count: 1 })),
            count: vi.fn(async () => 1),
            findMany: vi.fn(async () => [] as ReturnType<typeof row>[]),
            ...overrides,
        },
    }
}

const PAYLOAD: PushPayload = {
    title: "یادآور روزساز",
    body: "وقت برنامه‌ریزی روزت رسیده است ✨",
    url: "/dashboard",
    tag: "dp-reminder-2026-09-22|09:00",
}

const okDelivery = async (): Promise<PushDelivery> => ({ ok: true, statusCode: 201 })

describe("savePushSubscription", () => {
    it("با userId نشست upsert می‌کند و در سقف، prune نمی‌کند", async () => {
        const prisma = prismaMock()

        const result = await savePushSubscription(
            USER,
            { endpoint: "https://push.example.com/a", p256dh: "p", auth: "a" },
            prisma,
        )

        expect(result).toEqual({ id: "sub_1", pruned: 0 })
        expect(prisma.pushSubscription.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { endpoint: "https://push.example.com/a" },
                create: {
                    userId: USER,
                    endpoint: "https://push.example.com/a",
                    p256dh: "p",
                    auth: "a",
                },
                // ثبت دوباره‌ی همان endpoint → به کاربر جاری نسبت داده می‌شود
                update: { userId: USER, p256dh: "p", auth: "a" },
            }),
        )
        expect(prisma.pushSubscription.deleteMany).not.toHaveBeenCalled()
    })

    it("در عبور از سقف، قدیمی‌ترین‌ها را حذف می‌کند", async () => {
        const keep = Array.from({ length: MAX_SUBSCRIPTIONS_PER_USER }, (_, i) => ({
            id: `keep_${i}`,
        }))
        const prisma = prismaMock({
            count: vi.fn(async () => MAX_SUBSCRIPTIONS_PER_USER + 3),
            findMany: vi.fn(async () => keep),
            deleteMany: vi.fn(async () => ({ count: 3 })),
        })

        const result = await savePushSubscription(
            USER,
            { endpoint: "https://push.example.com/new", p256dh: "p", auth: "a" },
            prisma,
        )

        expect(result.pruned).toBe(3)
        expect(prisma.pushSubscription.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { userId: USER },
                orderBy: { updatedAt: "desc" },
                take: MAX_SUBSCRIPTIONS_PER_USER,
            }),
        )
        expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
            where: { userId: USER, id: { notIn: keep.map((row) => row.id) } },
        })
    })
})

describe("removePushSubscription", () => {
    it("حذف همیشه با شرط userId انجام می‌شود (بدون IDOR)", async () => {
        const prisma = prismaMock({ deleteMany: vi.fn(async () => ({ count: 1 })) })

        const result = await removePushSubscription(USER, "https://push.example.com/a", prisma)

        expect(result).toEqual({ removed: 1 })
        expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
            where: { endpoint: "https://push.example.com/a", userId: USER },
        })
    })

    it("endpoint ناشناس → removed=0 (بدون خطا، idempotent)", async () => {
        const prisma = prismaMock({ deleteMany: vi.fn(async () => ({ count: 0 })) })

        expect(await removePushSubscription(USER, "https://push.example.com/unknown", prisma)).toEqual({
            removed: 0,
        })
    })
})

describe("countPushSubscriptions", () => {
    it("فقط اشتراک‌های همان کاربر را می‌شمارد", async () => {
        const prisma = prismaMock({ count: vi.fn(async () => 4) })

        expect(await countPushSubscriptions(USER, prisma)).toBe(4)
        expect(prisma.pushSubscription.count).toHaveBeenCalledWith({ where: { userId: USER } })
    })
})

describe("sendPushToUser", () => {
    it("بدون پیکربندی VAPID → هیچ ارسالی انجام نمی‌شود", async () => {
        const prisma = prismaMock()
        const deliver = vi.fn(okDelivery)

        const summary = await sendPushToUser(USER, PAYLOAD, { prisma, env: {}, deliver })

        expect(summary).toEqual({ configured: false, sent: 0, failed: 0, removed: 0 })
        expect(prisma.pushSubscription.findMany).not.toHaveBeenCalled()
        expect(deliver).not.toHaveBeenCalled()
    })

    it("payload خام (بدون هیچ فیلد اضافه) برای هر دستگاه ارسال می‌شود", async () => {
        const rows = [row("a"), row("b")]
        const prisma = prismaMock({ findMany: vi.fn(async () => rows) })
        const deliver = vi.fn(okDelivery)

        const summary = await sendPushToUser(USER, PAYLOAD, { prisma, env: TEST_ENV, deliver })

        expect(summary).toEqual({ configured: true, sent: 2, failed: 0, removed: 0 })
        expect(deliver).toHaveBeenCalledTimes(2)
        expect(deliver).toHaveBeenNthCalledWith(
            1,
            { endpoint: rows[0].endpoint, p256dh: rows[0].p256dh, auth: rows[0].auth },
            PAYLOAD,
        )
        expect(prisma.pushSubscription.findMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: USER }, take: MAX_SUBSCRIPTIONS_PER_USER }),
        )
    })

    it("اشتراک مرده (410) حذف می‌شود و بقیه دست‌نخورده می‌مانند", async () => {
        const rows = [row("dead"), row("alive")]
        const prisma = prismaMock({
            findMany: vi.fn(async () => rows),
            deleteMany: vi.fn(async () => ({ count: 1 })),
        })
        const deliver = vi.fn(async (target: { endpoint: string }): Promise<PushDelivery> =>
            target.endpoint.includes("dead")
                ? { ok: false, gone: true, statusCode: 410 }
                : { ok: true, statusCode: 201 },
        )

        const summary = await sendPushToUser(USER, PAYLOAD, { prisma, env: TEST_ENV, deliver })

        expect(summary).toEqual({ configured: true, sent: 1, failed: 0, removed: 1 })
        expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledTimes(1)
        expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
            where: { id: "dead", userId: USER },
        })
    })

    it("شکست موقت → failed (ردیف حذف نمی‌شود) و حلقه ادامه می‌یابد", async () => {
        const rows = [row("flaky"), row("fine")]
        const prisma = prismaMock({ findMany: vi.fn(async () => rows) })
        const deliver = vi.fn(async (target: { endpoint: string }): Promise<PushDelivery> =>
            target.endpoint.includes("flaky")
                ? { ok: false, gone: false, statusCode: 500 }
                : { ok: true, statusCode: 201 },
        )

        const summary = await sendPushToUser(USER, PAYLOAD, { prisma, env: TEST_ENV, deliver })

        expect(summary).toEqual({ configured: true, sent: 1, failed: 1, removed: 0 })
        expect(prisma.pushSubscription.deleteMany).not.toHaveBeenCalled()
    })

    it("کاربر بدون دستگاه → همه‌ی شمارنده‌ها صفر", async () => {
        const prisma = prismaMock({ findMany: vi.fn(async () => []) })

        const summary = await sendPushToUser(USER, PAYLOAD, {
            prisma,
            env: TEST_ENV,
            deliver: vi.fn(okDelivery),
        })

        expect(summary).toEqual({ configured: true, sent: 0, failed: 0, removed: 0 })
    })
})
