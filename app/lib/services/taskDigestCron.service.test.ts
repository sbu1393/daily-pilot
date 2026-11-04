import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* اعلان‌های زمان‌بندی‌شده‌ی تسک‌ها — تست سرویس cron                    */
/*                                                                     */
/* Prisma mock تزریق می‌شود و ارسال با `send` تزریقی انجام می‌شود       */
/* (هیچ DB/provider واقعی). تمرکز: شمارش درست، عدم ارسال برای صفر تسک،  */
/* فیلتر معوقه، و fail-open بودن حلقه.                                 */
/* ------------------------------------------------------------------ */

import { PUSH_ENV } from "@/app/lib/push/config"
import type { PushPayload } from "@/app/lib/push/adapter"
import type { PushSendSummary } from "./push.service"
import {
    MAX_USERS_PER_RUN,
    buildTaskDigestFilter,
    buildTaskDigestPayload,
    runTaskDigestCron,
} from "./taskDigestCron.service"

const TEST_ENV = {
    [PUSH_ENV.publicKey]: "public-key-for-tests",
    [PUSH_ENV.privateKey]: "private-key-for-tests",
    [PUSH_ENV.subject]: "mailto:admin@example.com",
}

// ۲۰۲۶-۰۹-۲۲ ۰۵:۳۰ UTC = ۰۹:۰۰ تهران
const NOW = new Date("2026-09-22T05:30:00.000Z")
const TODAY = "2026-09-22"

const candidate = (overrides: Record<string, unknown> = {}) => ({
    id: 7,
    timezone: "Asia/Tehran",
    ...overrides,
})

function prismaMock(
    rows: ReturnType<typeof candidate>[],
    counts: number[] = [],
    options: { duplicateUserIds?: number[] } = {},
) {
    let index = 0
    const duplicates = new Set(options.duplicateUserIds ?? [])

    return {
        user: {
            findMany: vi.fn(async () => rows),
        },
        task: {
            count: vi.fn(async () => counts[index++] ?? 0),
        },
        sentNotification: {
            create: vi.fn(async (args: unknown) => {
                const { data } = args as {
                    data: { userId: number; type: string; dayKey: string }
                }
                if (duplicates.has(data.userId)) {
                    throw Object.assign(new Error("unique"), { code: "P2002" })
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

describe("buildTaskDigestPayload", () => {
    it("پیام صبح با تعداد تسک و بدون نام کاربر", () => {
        const payload = buildTaskDigestPayload("morning", 3, TODAY)

        expect(payload).toEqual({
            title: "روزساز — برنامه امروز",
            body: "☀️ صبح بخیر! امروز ۳ تسک در انتظار توست. بزن بریم!",
            url: "/dashboard",
            tag: "dp-morning-2026-09-22",
        })
    })

    it("پیام شب دقیقاً مطابق قالب است", () => {
        expect(buildTaskDigestPayload("night", 5, TODAY).body).toBe(
            "🌙 خسته نباشی! نگاهی به تسک‌های امروز بنداز و برای استراحت آماده شو.",
        )
    })

    it("پیام معوقه دقیقاً مطابق قالب است", () => {
        expect(buildTaskDigestPayload("overdue", 2, TODAY).body).toBe(
            "⚡️ چند تسک معوقه داری. با یک همت کوچیک می‌تونی پرونده‌شون رو ببندی!",
        )
    })
})

describe("buildTaskDigestFilter", () => {
    it("صبح/شب فقط تسک‌های ناتمام همان روز محلی را می‌شمارد", () => {
        expect(buildTaskDigestFilter("morning", 7, TODAY)).toEqual({
            userId: 7,
            status: { not: "DONE" },
            dayKey: TODAY,
        })
    })

    it("معوقه تسک‌های ناتمام با dayKey قبل از امروز را می‌شمارد", () => {
        expect(buildTaskDigestFilter("overdue", 7, TODAY)).toEqual({
            userId: 7,
            status: { not: "DONE" },
            dayKey: { lt: TODAY },
        })
    })
})

describe("runTaskDigestCron", () => {
    it("بدون پیکربندی VAPID → هیچ کوئری و ارسالی انجام نمی‌شود", async () => {
        const prisma = prismaMock([candidate()], [3])
        const send = vi.fn(async () => sent())

        const summary = await runTaskDigestCron("morning", NOW, { prisma, env: {}, send })

        expect(summary).toMatchObject({ configured: false, kind: "morning", scanned: 0, sent: 0 })
        expect(prisma.user.findMany).not.toHaveBeenCalled()
        expect(prisma.task.count).not.toHaveBeenCalled()
        expect(send).not.toHaveBeenCalled()
    })

    it("فقط کاربران دارای اشتراک Push را واکشی می‌کند", async () => {
        const prisma = prismaMock([])

        await runTaskDigestCron("morning", NOW, {
            prisma,
            env: TEST_ENV,
            send: vi.fn(async () => sent()),
        })

        expect(prisma.user.findMany).toHaveBeenCalledWith({
            where: { pushSubscriptions: { some: {} } },
            take: MAX_USERS_PER_RUN,
            select: { id: true, timezone: true },
        })
    })

    it("کاربر با تسک → ارسال پیام صبح با تعداد همان روز محلی", async () => {
        const prisma = prismaMock([candidate()], [4])
        const send = vi.fn(async () => sent())

        const summary = await runTaskDigestCron("morning", NOW, {
            prisma,
            env: TEST_ENV,
            send,
        })

        expect(summary).toMatchObject({
            configured: true,
            kind: "morning",
            scanned: 1,
            matched: 1,
            skipped: 0,
            tasks: 4,
            sent: 1,
            failed: 0,
            removed: 0,
            errored: 0,
            truncated: false,
        })

        expect(prisma.task.count).toHaveBeenCalledWith({
            where: { userId: 7, status: { not: "DONE" }, dayKey: TODAY },
        })
        expect(prisma.sentNotification.create).toHaveBeenCalledWith({
            data: { userId: 7, type: "morning", dayKey: TODAY },
            select: { id: true },
        })

        const [userId, payload] = send.mock.calls[0] as unknown as [number, PushPayload]
        expect(userId).toBe(7)
        expect(payload.body).toBe("☀️ صبح بخیر! امروز ۴ تسک در انتظار توست. بزن بریم!")
    })

    it("کاربر بدون تسک → هیچ اعلانی ارسال نمی‌شود (پیام خالی ممنوع)", async () => {
        const prisma = prismaMock([candidate()], [0])
        const send = vi.fn(async () => sent())

        const summary = await runTaskDigestCron("night", NOW, { prisma, env: TEST_ENV, send })

        expect(summary).toMatchObject({ matched: 0, skipped: 0, tasks: 0, sent: 0 })
        expect(prisma.sentNotification.create).not.toHaveBeenCalled()
        expect(send).not.toHaveBeenCalled()
    })

    it("اگر امروز برای همین کاربر/نوع ارسال شده باشد → دوباره ارسال نمی‌شود (idempotency)", async () => {
        const prisma = prismaMock([candidate()], [3], { duplicateUserIds: [7] })
        const send = vi.fn(async () => sent())

        const summary = await runTaskDigestCron("morning", NOW, { prisma, env: TEST_ENV, send })

        expect(summary).toMatchObject({
            scanned: 1,
            matched: 0,
            skipped: 1,
            tasks: 0,
            sent: 0,
            errored: 0,
        })
        expect(prisma.sentNotification.create).toHaveBeenCalledWith({
            data: { userId: 7, type: "morning", dayKey: TODAY },
            select: { id: true },
        })
        expect(send).not.toHaveBeenCalled()
    })

    it("خطای یک کاربر حلقه را متوقف نمی‌کند (fail-open) و claim را آزاد می‌کند", async () => {
        const prisma = prismaMock([candidate({ id: 1 }), candidate({ id: 2 })], [2, 3])
        const send = vi
            .fn<(userId: number, payload: PushPayload) => Promise<PushSendSummary>>()
            .mockRejectedValueOnce(new Error("provider down"))
            .mockResolvedValueOnce(sent({ sent: 2 }))

        const summary = await runTaskDigestCron("overdue", NOW, { prisma, env: TEST_ENV, send })

        expect(summary).toMatchObject({
            scanned: 2,
            matched: 2,
            skipped: 0,
            tasks: 5,
            sent: 2,
            errored: 1,
        })
        expect(send).toHaveBeenCalledTimes(2)
        expect(prisma.sentNotification.deleteMany).toHaveBeenCalledWith({
            where: { userId: 1, type: "overdue", dayKey: TODAY },
        })
    })
})
