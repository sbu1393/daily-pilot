import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* یادآورها — تست سرویس تریگر زمان‌بندی‌شده                            */
/*                                                                     */
/* مرزهای تست: Prisma mock تزریق می‌شود و ارسال با `send` تزریقی انجام  */
/* می‌شود (هیچ DB/provider واقعی). تمرکز: انتخاب کاربران سررسید، ثبت     */
/* `reminderSentOn` فقط در ارسال موفق، و fail-open بودن حلقه.          */
/* ------------------------------------------------------------------ */

import { PUSH_ENV } from "@/app/lib/push/config"
import type { PushPayload } from "@/app/lib/push/adapter"
import type { PushSendSummary } from "./push.service"
import { MAX_USERS_PER_RUN, buildReminderPayload, runReminderCron } from "./reminderCron.service"

const TEST_ENV = {
    [PUSH_ENV.publicKey]: "public-key-for-tests",
    [PUSH_ENV.privateKey]: "private-key-for-tests",
    [PUSH_ENV.subject]: "mailto:admin@example.com",
}

// ۲۰۲۶-۰۹-۲۲ ۰۵:۳۰ UTC = ۰۹:۰۰ تهران (زمان یادآور کاربر نمونه)
const NOW = new Date("2026-09-22T05:30:00.000Z")

const candidate = (overrides: Record<string, unknown> = {}) => ({
    id: 7,
    timezone: "Asia/Tehran",
    reminderTime: "09:00",
    reminderSentOn: null,
    ...overrides,
})

function prismaMock(rows: ReturnType<typeof candidate>[]) {
    return {
        user: {
            findMany: vi.fn(async () => rows),
            update: vi.fn(async () => ({})),
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

describe("buildReminderPayload", () => {
    it("فقط فیلدهای مجاز و deep link داشبورد را می‌سازد", () => {
        const payload = buildReminderPayload({
            timezone: "Asia/Tehran",
            reminderTime: "09:00",
            now: NOW,
        })

        expect(Object.keys(payload).sort()).toEqual(["body", "tag", "title", "url"])
        expect(payload.url).toBe("/dashboard")
        expect(payload.tag).toBe("dp-reminder-2026-09-22|09:00")
    })
})

describe("runReminderCron", () => {
    it("بدون پیکربندی VAPID → هیچ کوئری و ارسالی انجام نمی‌شود", async () => {
        const prisma = prismaMock([candidate()])
        const send = vi.fn(async () => sent())

        const summary = await runReminderCron(NOW, { prisma, env: {}, send })

        expect(summary.configured).toBe(false)
        expect(summary.scanned).toBe(0)
        expect(prisma.user.findMany).not.toHaveBeenCalled()
        expect(send).not.toHaveBeenCalled()
    })

    it("فقط کاربران با یادآور فعال و حداقل یک دستگاه را واکشی می‌کند", async () => {
        const prisma = prismaMock([])

        await runReminderCron(NOW, { prisma, env: TEST_ENV, send: vi.fn(async () => sent()) })

        expect(prisma.user.findMany).toHaveBeenCalledWith({
            where: { reminderEnabled: true, pushSubscriptions: { some: {} } },
            take: MAX_USERS_PER_RUN,
            select: { id: true, timezone: true, reminderTime: true, reminderSentOn: true },
        })
    })

    it("کاربر سررسید → ارسال + ثبت reminderSentOn همان روز محلی", async () => {
        const prisma = prismaMock([candidate()])
        const send = vi.fn(async () => sent())

        const summary = await runReminderCron(NOW, { prisma, env: TEST_ENV, send })

        expect(summary).toMatchObject({
            configured: true,
            scanned: 1,
            due: 1,
            sent: 1,
            failed: 0,
            removed: 0,
            errored: 0,
            truncated: false,
        })

        expect(send).toHaveBeenCalledTimes(1)
        const [userId, payload] = send.mock.calls[0] as unknown as [number, PushPayload]
        expect(userId).toBe(7)
        expect(payload.body).toContain("برنامه‌ریزی")

        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: 7 },
            data: { reminderSentOn: "2026-09-22" },
        })
    })

    it("کاربر داخل پنجره نیست → نه ارسال، نه ثبت", async () => {
        const prisma = prismaMock([candidate({ reminderTime: "12:00" })])
        const send = vi.fn(async () => sent())

        const summary = await runReminderCron(NOW, { prisma, env: TEST_ENV, send })

        expect(summary).toMatchObject({ scanned: 1, due: 0, sent: 0 })
        expect(send).not.toHaveBeenCalled()
        expect(prisma.user.update).not.toHaveBeenCalled()
    })

    it("امروز قبلاً ارسال شده → تکرار نمی‌شود", async () => {
        const prisma = prismaMock([candidate({ reminderSentOn: "2026-09-22" })])
        const send = vi.fn(async () => sent())

        const summary = await runReminderCron(NOW, { prisma, env: TEST_ENV, send })

        expect(summary.due).toBe(0)
        expect(send).not.toHaveBeenCalled()
    })

    it("ارسال ناموفق → reminderSentOn ثبت نمی‌شود تا اجرای بعدی دوباره تلاش کند", async () => {
        const prisma = prismaMock([candidate()])
        const send = vi.fn(async () => sent({ sent: 0, failed: 2, removed: 1 }))

        const summary = await runReminderCron(NOW, { prisma, env: TEST_ENV, send })

        expect(summary).toMatchObject({ due: 1, sent: 0, failed: 2, removed: 1 })
        expect(prisma.user.update).not.toHaveBeenCalled()
    })

    it("خطای یک کاربر حلقه را متوقف نمی‌کند (fail-open)", async () => {
        const prisma = prismaMock([candidate({ id: 1 }), candidate({ id: 2 })])
        const send = vi.fn(async (userId: number) => {
            if (userId === 1) throw new Error("provider exploded")
            return sent()
        })

        const summary = await runReminderCron(NOW, { prisma, env: TEST_ENV, send })

        expect(summary).toMatchObject({ scanned: 2, due: 2, sent: 1, errored: 1 })
        expect(prisma.user.update).toHaveBeenCalledTimes(1)
        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: 2 },
            data: { reminderSentOn: "2026-09-22" },
        })
    })

    it("هر کاربر با timezone خودش سنجیده می‌شود", async () => {
        const prisma = prismaMock([
            candidate({ id: 1, timezone: "Asia/Tehran", reminderTime: "09:00" }),
            candidate({ id: 2, timezone: "UTC", reminderTime: "05:30" }),
            candidate({ id: 3, timezone: "UTC", reminderTime: "09:00" }), // برای UTC ساعت ۵:۳۰ است
        ])
        const send = vi.fn(async () => sent())

        const summary = await runReminderCron(NOW, { prisma, env: TEST_ENV, send })

        expect(summary.due).toBe(2)
        const delivered = (send.mock.calls as unknown as Array<[number, PushPayload]>).map((c) => c[0])
        expect(delivered).toEqual([1, 2])
    })

    it("سقف پردازش بریده شدن را گزارش می‌کند", async () => {
        const prisma = prismaMock([candidate({ id: 1, reminderTime: "12:00" })])
        const send = vi.fn(async () => sent())

        const summary = await runReminderCron(NOW, { prisma, env: TEST_ENV, send, limit: 1 })

        expect(summary.truncated).toBe(true)
        expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 1 }))
    })
})
