import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* ADR-07 فاز ۳-B — reminderScheduler.service tests.                    */
/* Prisma / push config / push sender / observability are mocked:      */
/* no DB, no real Web Push, deterministic `now`.                       */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getPrisma: vi.fn(),
    getPushConfig: vi.fn(),
    sendPushNotification: vi.fn(),
    recordError: vi.fn(),
}))

vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: mocks.getPrisma }))
vi.mock("@/app/lib/push/config", () => ({ getPushConfig: mocks.getPushConfig }))
vi.mock("@/app/lib/push/sender", () => ({ sendPushNotification: mocks.sendPushNotification }))
vi.mock("@/src/lib/observability/recordError", () => ({ recordError: mocks.recordError }))

import {
    buildDueReminderWhere,
    runReminderScheduler,
    SCHEDULER_BATCH_SIZE,
    STALE_REMINDER_WINDOW_MS,
} from "./reminderScheduler.service"

const NOW = new Date("2026-09-22T10:00:00.000Z")
const REMINDER_AT = new Date("2026-09-22T09:59:30.000Z") // ۳۰ ثانیه دیرتر → همچنان due

const OK_CONFIG = {
    ok: true,
    config: { publicKey: "pub", privateKey: "priv", subject: "mailto:ops@example.com" },
}

type Sub = { id: string; userId: number; endpoint: string; p256dh: string; auth: string }

function makePrisma(options: {
    tasks?: unknown[]
    subscriptions?: Sub[]
    claimFailKeys?: string[]
}) {
    const prisma = {
        task: { findMany: vi.fn().mockResolvedValue(options.tasks ?? []) },
        pushSubscription: {
            findMany: vi.fn().mockResolvedValue(options.subscriptions ?? []),
            deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        taskReminderDelivery: {
            create: vi.fn(async (args: { data: { taskId: number; subscriptionId: string } }) => {
                const key = `${args.data.taskId}:${args.data.subscriptionId}`
                if ((options.claimFailKeys ?? []).includes(key)) {
                    throw Object.assign(new Error("unique"), { code: "P2002" })
                }
                return { id: `delivery-${key}` }
            }),
            update: vi.fn().mockResolvedValue({}),
        },
    }
    mocks.getPrisma.mockReturnValue(prisma)
    return prisma
}

const sub = (id: string, userId: number): Sub => ({
    id,
    userId,
    endpoint: `https://push.example.com/${id}`,
    p256dh: `p-${id}`,
    auth: `a-${id}`,
})

describe("runReminderScheduler", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getPushConfig.mockReturnValue(OK_CONFIG)
        mocks.sendPushNotification.mockResolvedValue({ ok: true, statusCode: 201 })
        mocks.recordError.mockResolvedValue(undefined)
    })

    it("does nothing (no error) when VAPID is not configured", async () => {
        mocks.getPushConfig.mockReturnValue({ ok: false, missing: ["VAPID_PRIVATE_KEY"] })

        const summary = await runReminderScheduler(NOW)

        expect(summary).toMatchObject({ ran: false, reason: "not_configured", sent: 0 })
        expect(mocks.getPrisma).not.toHaveBeenCalled()
        expect(mocks.sendPushNotification).not.toHaveBeenCalled()
    })

    it("queries only open tasks with reminderAt <= now and within the stale window, batched", async () => {
        const prisma = makePrisma({ tasks: [] })

        await runReminderScheduler(NOW)

        const args = prisma.task.findMany.mock.calls[0][0]
        expect(args.where).toEqual({
            status: { not: "DONE" },
            reminderAt: { not: null, lte: NOW, gte: new Date(NOW.getTime() - STALE_REMINDER_WINDOW_MS) },
        })
        expect(args.take).toBe(SCHEDULER_BATCH_SIZE)
        expect(args.orderBy).toEqual({ reminderAt: "asc" })
    })

    it("sends a Persian task-reminder payload for a due reminder", async () => {
        makePrisma({
            tasks: [{ id: 42, userId: 1, title: "تماس با مشتری", reminderAt: REMINDER_AT }],
            subscriptions: [sub("s1", 1)],
        })

        const summary = await runReminderScheduler(NOW)

        expect(summary).toMatchObject({ dueTasks: 1, sent: 1, failed: 0, gone: 0, skipped: 0 })
        expect(mocks.sendPushNotification).toHaveBeenCalledTimes(1)
        const [target, payload] = mocks.sendPushNotification.mock.calls[0]
        expect(target).toMatchObject({ endpoint: "https://push.example.com/s1", p256dh: "p-s1", auth: "a-s1" })
        expect(payload).toMatchObject({
            type: "task-reminder",
            taskId: 42,
            url: "/dashboard?taskId=42",
        })
        expect(payload.title).toContain("یادآوری")
        expect(payload.title).toContain("تماس با مشتری")
        expect(payload.body).toMatch(/[\u0600-\u06FF]/) // متن فارسی
    })

    it("delivers to every subscription, but at most once per (task, subscription, reminderAt)", async () => {
        const prisma = makePrisma({
            tasks: [{ id: 1, userId: 1, title: "کار", reminderAt: REMINDER_AT }],
            subscriptions: [sub("phone", 1), sub("tablet", 1), sub("desktop", 1)],
        })

        const summary = await runReminderScheduler(NOW)

        expect(summary.sent).toBe(3)
        expect(mocks.sendPushNotification).toHaveBeenCalledTimes(3)
        expect(prisma.taskReminderDelivery.create).toHaveBeenCalledTimes(3)
    })

    it("skips a delivery already claimed (unique violation) without re-sending", async () => {
        makePrisma({
            tasks: [{ id: 1, userId: 1, title: "کار", reminderAt: REMINDER_AT }],
            subscriptions: [sub("phone", 1), sub("desktop", 1)],
            claimFailKeys: ["1:phone"],
        })

        const summary = await runReminderScheduler(NOW)

        expect(summary.skipped).toBe(1)
        expect(summary.sent).toBe(1)
        expect(mocks.sendPushNotification).toHaveBeenCalledTimes(1)
        expect(mocks.sendPushNotification.mock.calls[0][0]).toMatchObject({ endpoint: "https://push.example.com/desktop" })
    })

    it("removes an invalid subscription on 410 (gone) and continues", async () => {
        const prisma = makePrisma({
            tasks: [{ id: 1, userId: 1, title: "کار", reminderAt: REMINDER_AT }],
            subscriptions: [sub("bad", 1), sub("good", 1)],
        })
        mocks.sendPushNotification
            .mockResolvedValueOnce({ ok: false, reason: "gone", statusCode: 410 })
            .mockResolvedValueOnce({ ok: true, statusCode: 201 })

        const summary = await runReminderScheduler(NOW)

        expect(summary).toMatchObject({ gone: 1, sent: 1, failed: 0 })
        expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({ where: { id: "bad" } })
        expect(prisma.taskReminderDelivery.update).toHaveBeenCalledWith({
            where: { id: "delivery-1:bad" },
            data: { status: "GONE", failureCode: "HTTP_410" },
        })
    })

    it("removes the subscription on 404 too", async () => {
        const prisma = makePrisma({
            tasks: [{ id: 1, userId: 1, title: "کار", reminderAt: REMINDER_AT }],
            subscriptions: [sub("bad", 1)],
        })
        mocks.sendPushNotification.mockResolvedValue({ ok: false, reason: "gone", statusCode: 404 })

        const summary = await runReminderScheduler(NOW)

        expect(summary.gone).toBe(1)
        expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({ where: { id: "bad" } })
    })

    it("records a transient failure, keeps the batch going, and does not delete the subscription", async () => {
        const prisma = makePrisma({
            tasks: [{ id: 1, userId: 1, title: "کار", reminderAt: REMINDER_AT }],
            subscriptions: [sub("s1", 1)],
        })
        mocks.sendPushNotification.mockResolvedValue({ ok: false, reason: "failed", statusCode: 500 })

        const summary = await runReminderScheduler(NOW)

        expect(summary).toMatchObject({ failed: 1, sent: 0, gone: 0 })
        expect(prisma.pushSubscription.deleteMany).not.toHaveBeenCalled()
        expect(prisma.taskReminderDelivery.update).toHaveBeenCalledWith({
            where: { id: "delivery-1:s1" },
            data: { status: "FAILED", failureCode: "HTTP_500" },
        })
        expect(mocks.recordError).toHaveBeenCalledTimes(1)
    })

    it("processes multiple tasks independently — a failure does not stop the others", async () => {
        const prisma = makePrisma({
            tasks: [
                { id: 1, userId: 1, title: "A", reminderAt: REMINDER_AT },
                { id: 2, userId: 1, title: "B", reminderAt: REMINDER_AT },
                { id: 3, userId: 1, title: "C", reminderAt: REMINDER_AT },
            ],
            subscriptions: [sub("s1", 1)],
        })
        mocks.sendPushNotification
            .mockResolvedValueOnce({ ok: true, statusCode: 201 })
            .mockResolvedValueOnce({ ok: false, reason: "failed", statusCode: 503 })
            .mockResolvedValueOnce({ ok: true, statusCode: 201 })

        const summary = await runReminderScheduler(NOW)

        expect(summary).toMatchObject({ dueTasks: 3, sent: 2, failed: 1 })
        expect(prisma.taskReminderDelivery.create).toHaveBeenCalledTimes(3)
    })

    it("does nothing for a due task whose user has no subscription", async () => {
        makePrisma({
            tasks: [{ id: 1, userId: 1, title: "کار", reminderAt: REMINDER_AT }],
            subscriptions: [],
        })

        const summary = await runReminderScheduler(NOW)

        expect(summary).toMatchObject({ dueTasks: 1, sent: 0 })
        expect(mocks.sendPushNotification).not.toHaveBeenCalled()
    })

    it("marks a successful delivery as SENT with sentAt", async () => {
        const prisma = makePrisma({
            tasks: [{ id: 1, userId: 1, title: "کار", reminderAt: REMINDER_AT }],
            subscriptions: [sub("s1", 1)],
        })

        await runReminderScheduler(NOW)

        expect(prisma.taskReminderDelivery.update).toHaveBeenCalledWith({
            where: { id: "delivery-1:s1" },
            data: { status: "SENT", sentAt: NOW },
        })
    })

    it("sends at most once when two scheduler runs overlap on the same claim", async () => {
        // داور یکتایی، شبیه‌سازی DB است: create دوم روی همان کلید P2002 می‌دهد.
        const claimed = new Set<string>()
        const prisma = {
            task: {
                findMany: vi.fn().mockResolvedValue([
                    { id: 1, userId: 1, title: "کار", reminderAt: REMINDER_AT },
                ]),
            },
            pushSubscription: {
                findMany: vi.fn().mockResolvedValue([sub("s1", 1)]),
                deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
            },
            taskReminderDelivery: {
                create: vi.fn(
                    async (args: {
                        data: { taskId: number; subscriptionId: string; reminderAt: Date }
                    }) => {
                        const key = `${args.data.taskId}:${args.data.subscriptionId}:${args.data.reminderAt.toISOString()}`
                        if (claimed.has(key)) throw Object.assign(new Error("unique"), { code: "P2002" })
                        claimed.add(key)
                        return { id: `delivery-${key}` }
                    },
                ),
                update: vi.fn().mockResolvedValue({}),
            },
        }
        mocks.getPrisma.mockReturnValue(prisma)

        const [first, second] = await Promise.all([runReminderScheduler(NOW), runReminderScheduler(NOW)])

        expect(mocks.sendPushNotification).toHaveBeenCalledTimes(1)
        expect(first.sent + second.sent).toBe(1)
        expect(first.skipped + second.skipped).toBe(1)
    })

    it("sends a reminder that is exactly at the 24h stale boundary when the DB returns it", async () => {
        const boundaryTask = {
            id: 9,
            userId: 1,
            title: "مرزی",
            reminderAt: new Date(NOW.getTime() - STALE_REMINDER_WINDOW_MS),
        }
        makePrisma({ tasks: [boundaryTask], subscriptions: [sub("s1", 1)] })

        const summary = await runReminderScheduler(NOW)

        expect(summary.sent).toBe(1)
    })
})

describe("buildDueReminderWhere (stale window boundaries, instant-only)", () => {
    const now = new Date("2026-09-22T10:00:00.000Z")

    it("uses lte=now so future reminders are excluded", () => {
        const where = buildDueReminderWhere(now)
        const reminder = where.reminderAt as { lte: Date; gte: Date; not: null }

        expect(reminder.lte.getTime()).toBe(now.getTime())
    })

    it("uses gte=now-24h so the exact boundary is inclusive and older reminders are excluded", () => {
        const where = buildDueReminderWhere(now)
        const reminder = where.reminderAt as { gte: Date }

        expect(reminder.gte.getTime()).toBe(now.getTime() - STALE_REMINDER_WINDOW_MS)
        expect(reminder.gte.getTime()).toBe(Date.parse("2026-09-21T10:00:00.000Z"))
    })

    it("excludes closed tasks and tasks without a reminder", () => {
        const where = buildDueReminderWhere(now)

        expect(where.status).toEqual({ not: "DONE" })
        expect((where.reminderAt as { not: null }).not).toBeNull()
    })
})
