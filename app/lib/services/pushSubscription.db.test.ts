// ADR-07 — تست‌های PushSubscription با PostgreSQL واقعی (الگوی .db.test.ts موجود repo).
//
// دامنه (فقط تست — هیچ production code/schema/migration تغییر نمی‌کند):
//   1. ساخت PushSubscription
//   2. یکتایی endpoint
//   3. یک User با چند subscription (User 1—N)
//   4. حذف User → cascade حذف subscriptionها
//
// قاعده‌ی اجرا: اگر PostgreSQL در دسترس نباشد تست fail مصنوعی نمی‌شود و سبز جعلی هم
// نمی‌سازد؛ با skip استاندارد vitest گزارش می‌شود (همان واژگان REAL_POSTGRESQL_UNAVAILABLE).
//
// اجرای صریح: `npx vitest run app/lib/services/pushSubscription.db.test.ts`

import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const REAL_POSTGRESQL_UNAVAILABLE =
    "REAL_POSTGRESQL_UNAVAILABLE: تست PushSubscription به PostgreSQL واقعی نیاز دارد؛ skip استاندارد (بدون سبز جعلی و بدون fail مصنوعی)."

const MARKER = "adr07-push-subscription"

let prisma: PrismaClient
let dbAvailable = false
let userSeq = 0
let cleanupFailed = false

const createdUserIds: number[] = []

beforeAll(async () => {
    try {
        prisma = new PrismaClient()
        // gate سخت: اتصال واقعی + دسترس‌بودن جدول (migration اعمال‌شده باشد).
        // اگر جدول هنوز ساخته نشده، این تست skip می‌شود — migration در این فاز اجرا نمی‌شود.
        await prisma.$queryRaw`SELECT 1`
        await prisma.pushSubscription.count()
        dbAvailable = true
    } catch {
        dbAvailable = false
    }
})

afterAll(async () => {
    if (!prisma) return

    try {
        if (dbAvailable && createdUserIds.length > 0) {
            // cascade: PushSubscriptionها همراه User حذف می‌شوند
            await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
        }
    } catch (error) {
        cleanupFailed = true
        console.error("ADR07_CLEANUP_FAILED", {
            userIds: createdUserIds,
            error: error instanceof Error ? error.message : error,
        })
    } finally {
        await prisma.$disconnect().catch(() => {})
    }

    if (cleanupFailed) {
        throw new Error("ADR07_CLEANUP_FAILED: حذف کاربران اختصاصی این تست ناموفق بود.")
    }
})

async function createDedicatedUser(label: string): Promise<number> {
    userSeq += 1
    const suffix = `${label}-${userSeq}-${Date.now()}`
    const user = await prisma.user.create({
        data: {
            email: `${MARKER}-${suffix}@push.internal`,
            username: `${MARKER}-${suffix}`,
            password: "not-a-real-login",
            plan: "FREE",
        },
        select: { id: true },
    })

    createdUserIds.push(user.id)
    return user.id
}

const endpointFor = (suffix: string) => `https://push.internal/${MARKER}/${suffix}`

describe("PushSubscription (ADR-07)", () => {
    it("creates a subscription and persists endpoint/keys scoped to the user", async (ctx) => {
        if (!dbAvailable) ctx.skip(REAL_POSTGRESQL_UNAVAILABLE)
        const userId = await createDedicatedUser("create")
        const endpoint = endpointFor("create")

        const row = await prisma.pushSubscription.create({
            data: { userId, endpoint, p256dh: "p-key", auth: "a-key" },
        })

        expect(row.id).toEqual(expect.any(String))
        expect(row.userId).toBe(userId)
        expect(row.endpoint).toBe(endpoint)
        expect(row.p256dh).toBe("p-key")
        expect(row.auth).toBe("a-key")
        expect(row.lastSeenAt).toBeInstanceOf(Date)
    })

    it("enforces endpoint uniqueness", async (ctx) => {
        if (!dbAvailable) ctx.skip(REAL_POSTGRESQL_UNAVAILABLE)
        const userA = await createDedicatedUser("unique-a")
        const userB = await createDedicatedUser("unique-b")
        const endpoint = endpointFor("unique")

        await prisma.pushSubscription.create({ data: { userId: userA, endpoint, p256dh: "p", auth: "a" } })

        await expect(
            prisma.pushSubscription.create({ data: { userId: userB, endpoint, p256dh: "p2", auth: "a2" } }),
        ).rejects.toThrow()

        const count = await prisma.pushSubscription.count({ where: { endpoint } })
        expect(count).toBe(1)
    })

    it("supports multiple subscriptions per user (mobile/tablet/desktop)", async (ctx) => {
        if (!dbAvailable) ctx.skip(REAL_POSTGRESQL_UNAVAILABLE)
        const userId = await createDedicatedUser("multi")

        await prisma.pushSubscription.createMany({
            data: [
                { userId, endpoint: endpointFor("multi-1"), p256dh: "p1", auth: "a1" },
                { userId, endpoint: endpointFor("multi-2"), p256dh: "p2", auth: "a2" },
                { userId, endpoint: endpointFor("multi-3"), p256dh: "p3", auth: "a3" },
            ],
        })

        const rows = await prisma.pushSubscription.findMany({ where: { userId } })
        expect(rows).toHaveLength(3)
        expect(rows.every((r) => r.userId === userId)).toBe(true)
    })

    it("cascade-deletes subscriptions when the user is deleted", async (ctx) => {
        if (!dbAvailable) ctx.skip(REAL_POSTGRESQL_UNAVAILABLE)
        const userId = await createDedicatedUser("cascade")
        const endpoint = endpointFor("cascade")

        await prisma.pushSubscription.create({ data: { userId, endpoint, p256dh: "p", auth: "a" } })

        await prisma.user.delete({ where: { id: userId } })
        createdUserIds.splice(createdUserIds.indexOf(userId), 1)

        const remaining = await prisma.pushSubscription.count({ where: { endpoint } })
        expect(remaining).toBe(0)
    })
})
