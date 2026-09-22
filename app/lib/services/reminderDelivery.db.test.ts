// ADR-07 فاز ۳-B — تست‌های idempotency تحویل Reminder با PostgreSQL واقعی
// (الگوی .db.test.ts موجود repo).
//
// دامنه (فقط تست — هیچ production code/schema/migration تغییر نمی‌کند):
//   1. یکتایی (taskId, subscriptionId, reminderAt) — پایه‌ی idempotency و ایمنی race
//   2. همان subscription با reminderAt متفاوت → ردیف جدید مجاز (یادآوری جدید)
//   3. cascade با حذف Task
//   4. cascade با حذف Subscription
//   5. race واقعی: چند claim هم‌زمان برای یک کلید → فقط یک برنده (اثبات سطح DB)
//
// اگر PostgreSQL/جدول در دسترس نباشد، تست fail مصنوعی نمی‌شود و سبز جعلی هم نمی‌سازد؛
// با skip استاندارد vitest گزارش می‌شود.
//
// اجرای صریح: `npx vitest run app/lib/services/reminderDelivery.db.test.ts`

import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { claimReminderDelivery } from "./reminderDelivery.service"

const REAL_POSTGRESQL_UNAVAILABLE =
    "REAL_POSTGRESQL_UNAVAILABLE: تست TaskReminderDelivery به PostgreSQL واقعی نیاز دارد؛ skip استاندارد (بدون سبز جعلی و بدون fail مصنوعی)."

const MARKER = "adr07-reminder-delivery"

let prisma: PrismaClient
let dbAvailable = false
let userSeq = 0
let cleanupFailed = false

const createdUserIds: number[] = []

beforeAll(async () => {
    try {
        prisma = new PrismaClient()
        await prisma.$queryRaw`SELECT 1`
        // جدول باید وجود داشته باشد (migration اعمال‌شده). در غیر این صورت skip.
        await prisma.taskReminderDelivery.count()
        dbAvailable = true
    } catch {
        dbAvailable = false
    }
})

afterAll(async () => {
    if (!prisma) return

    try {
        if (dbAvailable && createdUserIds.length > 0) {
            // cascade: Task/PushSubscription/TaskReminderDelivery همراه User حذف می‌شوند
            await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
        }
    } catch (error) {
        cleanupFailed = true
        console.error("ADR07_DELIVERY_CLEANUP_FAILED", {
            userIds: createdUserIds,
            error: error instanceof Error ? error.message : error,
        })
    } finally {
        await prisma.$disconnect().catch(() => {})
    }

    if (cleanupFailed) {
        throw new Error("ADR07_DELIVERY_CLEANUP_FAILED: حذف کاربران اختصاصی این تست ناموفق بود.")
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

async function createTaskAndSubscription(userId: number, label: string) {
    const task = await prisma.task.create({
        data: {
            userId,
            title: `تسک ${label}`,
            dayKey: "2026-09-22",
            scheduledDate: new Date("2026-09-21T20:30:00.000Z"),
        },
        select: { id: true },
    })
    const subscription = await prisma.pushSubscription.create({
        data: {
            userId,
            endpoint: `https://push.internal/${MARKER}/${label}-${Date.now()}`,
            p256dh: "p",
            auth: "a",
        },
        select: { id: true },
    })
    return { taskId: task.id, subscriptionId: subscription.id }
}

describe("TaskReminderDelivery (ADR-07 3-B)", () => {
    it("enforces one delivery per (taskId, subscriptionId, reminderAt)", async (ctx) => {
        if (!dbAvailable) ctx.skip(REAL_POSTGRESQL_UNAVAILABLE)
        const userId = await createDedicatedUser("unique")
        const { taskId, subscriptionId } = await createTaskAndSubscription(userId, "unique")
        const reminderAt = new Date("2026-09-22T09:30:00.000Z")

        await prisma.taskReminderDelivery.create({ data: { taskId, subscriptionId, reminderAt } })

        await expect(
            prisma.taskReminderDelivery.create({ data: { taskId, subscriptionId, reminderAt } }),
        ).rejects.toThrow()

        const count = await prisma.taskReminderDelivery.count({ where: { taskId, subscriptionId } })
        expect(count).toBe(1)
    })

    it("allows the same subscription to deliver a different reminderAt (a new reminder)", async (ctx) => {
        if (!dbAvailable) ctx.skip(REAL_POSTGRESQL_UNAVAILABLE)
        const userId = await createDedicatedUser("newtime")
        const { taskId, subscriptionId } = await createTaskAndSubscription(userId, "newtime")

        await prisma.taskReminderDelivery.create({
            data: { taskId, subscriptionId, reminderAt: new Date("2026-09-22T09:30:00.000Z") },
        })
        await prisma.taskReminderDelivery.create({
            data: { taskId, subscriptionId, reminderAt: new Date("2026-09-23T09:30:00.000Z") },
        })

        const count = await prisma.taskReminderDelivery.count({ where: { taskId, subscriptionId } })
        expect(count).toBe(2)
    })

    it("lets exactly one concurrent scheduler win the claim (no double send on overlap)", async (ctx) => {
        if (!dbAvailable) ctx.skip(REAL_POSTGRESQL_UNAVAILABLE)
        const userId = await createDedicatedUser("race")
        const { taskId, subscriptionId } = await createTaskAndSubscription(userId, "race")
        const reminderAt = new Date("2026-09-22T09:30:00.000Z")

        // پنج scheduler «هم‌زمان» روی همان (task, subscription, reminderAt)
        const results = await Promise.all(
            Array.from({ length: 5 }, () =>
                claimReminderDelivery({ taskId, subscriptionId, reminderAt }).catch(() => null),
            ),
        )

        const winners = results.filter((result) => result !== null)
        expect(winners).toHaveLength(1)

        const count = await prisma.taskReminderDelivery.count({ where: { taskId, subscriptionId } })
        expect(count).toBe(1)
    })

    it("cascade-deletes deliveries when the task is deleted", async (ctx) => {
        if (!dbAvailable) ctx.skip(REAL_POSTGRESQL_UNAVAILABLE)
        const userId = await createDedicatedUser("cascade-task")
        const { taskId, subscriptionId } = await createTaskAndSubscription(userId, "cascade-task")

        await prisma.taskReminderDelivery.create({
            data: { taskId, subscriptionId, reminderAt: new Date("2026-09-22T09:30:00.000Z") },
        })

        await prisma.task.delete({ where: { id: taskId } })

        const count = await prisma.taskReminderDelivery.count({ where: { subscriptionId } })
        expect(count).toBe(0)
    })

    it("cascade-deletes deliveries when the subscription is deleted", async (ctx) => {
        if (!dbAvailable) ctx.skip(REAL_POSTGRESQL_UNAVAILABLE)
        const userId = await createDedicatedUser("cascade-sub")
        const { taskId, subscriptionId } = await createTaskAndSubscription(userId, "cascade-sub")

        await prisma.taskReminderDelivery.create({
            data: { taskId, subscriptionId, reminderAt: new Date("2026-09-22T09:30:00.000Z") },
        })

        await prisma.pushSubscription.delete({ where: { id: subscriptionId } })

        const count = await prisma.taskReminderDelivery.count({ where: { taskId } })
        expect(count).toBe(0)
    })
})
