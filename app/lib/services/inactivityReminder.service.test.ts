import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* یادآور بازگشت کاربران غیرفعال — تست سرویس cron                     */
/*                                                                     */
/* Prisma و ارسال به‌صورت تزریقی mock می‌شوند (هیچ DB/provider واقعی).  */
/* تمرکز: آستانهٔ ۳ روز، cool-down هفت‌روزه، حذف حساب تازه/تسک اخیر،    */
/* claim اتمیک + P2002، و fail-open بودن حلقه.                         */
/* ------------------------------------------------------------------ */

import { PUSH_ENV } from "@/app/lib/push/config"
import type { PushPayload } from "@/app/lib/push/adapter"
import type { PushSendSummary } from "./push.service"
import {
    OVERDUE_NOTIFICATION_TYPE,
    overdueQuietCutoff,
} from "./inactivityPolicy"
import {
    COOLDOWN_DAYS,
    INACTIVITY_DAYS,
    INACTIVITY_NOTIFICATION_TYPE,
    MAX_USERS_PER_RUN,
    REENGAGEMENT_URL,
    buildInactivityPayload,
    runInactivityReminderCron,
} from "./inactivityReminder.service"

const TEST_ENV = {
    [PUSH_ENV.publicKey]: "public-key-for-tests",
    [PUSH_ENV.privateKey]: "private-key-for-tests",
    [PUSH_ENV.subject]: "mailto:admin@example.com",
}

// ۲۰۲۶-۱۱-۰۶ ۰۶:۳۰ UTC = ۱۰:۰۰ تهران
const NOW = new Date("2026-11-06T06:30:00.000Z")
const INACTIVE_CUTOFF = "2026-11-03T06:30:00.000Z"
const COOLDOWN_CUTOFF = "2026-10-30T06:30:00.000Z"

const candidate = (overrides: Record<string, unknown> = {}) => ({
    id: 7,
    timezone: "Asia/Tehran",
    lastSeenAt: new Date("2026-10-30T00:00:00.000Z"),
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
})

function prismaMock(
    rows: ReturnType<typeof candidate>[],
    options: {
        duplicateUserIds?: number[]
        claimErrorUserIds?: number[]
    } = {},
) {
    const duplicates = new Set(options.duplicateUserIds ?? [])
    const claimErrors = new Set(options.claimErrorUserIds ?? [])

    return {
        user: {
            findMany: vi.fn(async () => rows),
        },
        sentNotification: {
            create: vi.fn(async (args: unknown) => {
                const { data } = args as {
                    data: { userId: number; type: string; dayKey: string }
                }
                if (duplicates.has(data.userId)) {
                    throw Object.assign(new Error("unique"), { code: "P2002" })
                }
                if (claimErrors.has(data.userId)) {
                    throw new Error("db down")
                }
                return { id: `sent-${data.userId}` }
            }),
            deleteMany: vi.fn(async () => ({ count: 1 })),
        },
    }
}

const sent = (overrides: Partial<PushSendSummary> = {}): PushSendSummary => ({
    configured: true,
    sent: 1,
    failed: 0,
    removed: 0,
    ...overrides,
})

beforeEach(() => {
    vi.clearAllMocks()
})

describe("buildInactivityPayload", () => {
    it("متن دقیق، لینک داشبورد و تگ روز را برمی‌گرداند", () => {
        expect(buildInactivityPayload("2026-11-06")).toEqual({
            title: "روزساز — دلمان برایت تنگ شده",
            body: "🌱 جای خالیت در روزساز حس می‌شه! بیا با یک قدم کوچیک، برنامه امروزت رو بچینیم.",
            url: REENGAGEMENT_URL,
            tag: "dp-reengagement-2026-11-06",
        })
    })
})

describe("runInactivityReminderCron", () => {
    it("بدون پیکربندی VAPID → هیچ کوئری و ارسالی انجام نمی‌شود", async () => {
        const prisma = prismaMock([candidate()])
        const send = vi.fn(async () => sent())

        const summary = await runInactivityReminderCron(NOW, { prisma, env: {}, send })

        expect(summary).toMatchObject({
            configured: false,
            kind: INACTIVITY_NOTIFICATION_TYPE,
            scanned: 0,
            matched: 0,
            sent: 0,
        })
        expect(prisma.user.findMany).not.toHaveBeenCalled()
        expect(send).not.toHaveBeenCalled()
    })

    it("کوئری را با آستانهٔ ۳ روز و cool-down هفت‌روزه می‌سازد", async () => {
        const prisma = prismaMock([])

        await runInactivityReminderCron(NOW, {
            prisma,
            env: TEST_ENV,
            send: vi.fn(async () => sent()),
        })

        expect(prisma.user.findMany).toHaveBeenCalledWith({
            where: {
                pushSubscriptions: { some: {} },
                createdAt: { lte: new Date(INACTIVE_CUTOFF) },
                OR: [
                    { lastSeenAt: null },
                    { lastSeenAt: { lte: new Date(INACTIVE_CUTOFF) } },
                ],
                tasks: {
                    none: { updatedAt: { gte: new Date(INACTIVE_CUTOFF) } },
                },
                sentNotifications: {
                    none: {
                        OR: [
                            {
                                type: INACTIVITY_NOTIFICATION_TYPE,
                                createdAt: { gte: new Date(COOLDOWN_CUTOFF) },
                            },
                            {
                                type: OVERDUE_NOTIFICATION_TYPE,
                                createdAt: { gte: overdueQuietCutoff(NOW) },
                            },
                        ],
                    },
                },
            },
            orderBy: { lastSeenAt: "asc" },
            take: MAX_USERS_PER_RUN,
            select: { id: true, timezone: true, lastSeenAt: true, createdAt: true },
        })

        // ثابت‌های ضداسپم دقیقاً همان مقادیر قرارداد هستند.
        expect(INACTIVITY_DAYS).toBe(3)
        expect(COOLDOWN_DAYS).toBe(7)
    })

    it("بدون کاربر واجد شرایط → همهٔ شمارنده‌ها صفر می‌مانند", async () => {
        const prisma = prismaMock([])

        const summary = await runInactivityReminderCron(NOW, {
            prisma,
            env: TEST_ENV,
            send: vi.fn(async () => sent()),
        })

        expect(summary).toMatchObject({
            configured: true,
            kind: INACTIVITY_NOTIFICATION_TYPE,
            scanned: 0,
            matched: 0,
            skipped: 0,
            sent: 0,
            failed: 0,
            removed: 0,
            errored: 0,
            truncated: false,
        })
    })

    it("کاربر غیرفعال → claim امروز + پیام بازگشت با تگ روز محلی", async () => {
        const prisma = prismaMock([candidate()])
        const send = vi.fn(async () => sent())

        const summary = await runInactivityReminderCron(NOW, {
            prisma,
            env: TEST_ENV,
            send,
        })

        expect(prisma.sentNotification.create).toHaveBeenCalledWith({
            data: {
                userId: 7,
                type: INACTIVITY_NOTIFICATION_TYPE,
                dayKey: "2026-11-06",
            },
            select: { id: true },
        })
        expect(send).toHaveBeenCalledWith(7, buildInactivityPayload("2026-11-06"))
        expect(summary).toMatchObject({
            configured: true,
            scanned: 1,
            matched: 1,
            skipped: 0,
            sent: 1,
            errored: 0,
        })
    })

    it("dayKey با timezone خود کاربر محاسبه می‌شود (نه UTC)", async () => {
        const prisma = prismaMock([candidate({ timezone: "America/Los_Angeles" })])
        const send = vi.fn(async () => sent())

        await runInactivityReminderCron(NOW, { prisma, env: TEST_ENV, send })

        // 2026-11-06 06:30 UTC = 2026-11-05 22:30 در لس‌آنجلس
        expect(prisma.sentNotification.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ dayKey: "2026-11-05" }),
            }),
        )
        expect(send).toHaveBeenCalledWith(
            7,
            expect.objectContaining({ tag: "dp-reengagement-2026-11-05" }),
        )
    })

    it("claim تکراری (P2002) → skip و بدون ارسال", async () => {
        const prisma = prismaMock([candidate()], { duplicateUserIds: [7] })
        const send = vi.fn(async () => sent())

        const summary = await runInactivityReminderCron(NOW, {
            prisma,
            env: TEST_ENV,
            send,
        })

        expect(send).not.toHaveBeenCalled()
        expect(summary).toMatchObject({ scanned: 1, matched: 0, skipped: 1, sent: 0 })
    })

    it("خطای ارسال → errored و آزادسازی claim برای تلاش بعدی", async () => {
        const prisma = prismaMock([candidate()])
        const send = vi.fn(async () => {
            throw new Error("push provider down")
        })

        const summary = await runInactivityReminderCron(NOW, {
            prisma,
            env: TEST_ENV,
            send,
        })

        expect(summary).toMatchObject({ matched: 1, sent: 0, errored: 1 })
        expect(prisma.sentNotification.deleteMany).toHaveBeenCalledWith({
            where: {
                userId: 7,
                type: INACTIVITY_NOTIFICATION_TYPE,
                dayKey: "2026-11-06",
            },
        })
    })

    it("خطای claim یک کاربر حلقه را متوقف نمی‌کند (fail-open)", async () => {
        const prisma = prismaMock(
            [candidate({ id: 7 }), candidate({ id: 8 })],
            { claimErrorUserIds: [7] },
        )
        const send = vi.fn(async () => sent())

        const summary = await runInactivityReminderCron(NOW, {
            prisma,
            env: TEST_ENV,
            send,
        })

        expect(summary).toMatchObject({ scanned: 2, matched: 1, errored: 1, sent: 1 })
        expect(send).toHaveBeenCalledTimes(1)
        expect(send).toHaveBeenCalledWith(8, expect.any(Object))
        expect(prisma.sentNotification.deleteMany).not.toHaveBeenCalled()
    })

    it("خطای ارسال یک کاربر بقیهٔ حلقه را متوقف نمی‌کند", async () => {
        const prisma = prismaMock([
            candidate({ id: 7 }),
            candidate({ id: 8 }),
        ])
        let attempt = 0
        const send = vi.fn(
            async (_userId: number, _payload: PushPayload): Promise<PushSendSummary> => {
                attempt += 1
                if (attempt === 1) throw new Error("boom")
                return sent({ sent: 2 })
            },
        )

        const summary = await runInactivityReminderCron(NOW, {
            prisma,
            env: TEST_ENV,
            send,
        })

        expect(summary).toMatchObject({ scanned: 2, matched: 2, errored: 1, sent: 2 })
        expect(prisma.sentNotification.deleteMany).toHaveBeenCalledTimes(1)
    })

    it("وقتی تعداد نتایج به سقف برسد، truncated=true می‌شود", async () => {
        const prisma = prismaMock([
            candidate({ id: 7 }),
            candidate({ id: 8 }),
        ])

        const summary = await runInactivityReminderCron(NOW, {
            prisma,
            env: TEST_ENV,
            limit: 2,
            send: vi.fn(async () => sent()),
        })

        expect(summary.scanned).toBe(2)
        expect(summary.truncated).toBe(true)
    })
})
