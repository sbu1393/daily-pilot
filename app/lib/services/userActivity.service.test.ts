// فاز ۱ — تست‌های userActivity.service
// پوشش: first activity (null) → update، کمتر از ۳۰ دقیقه → no-op، بعد از ۳۰ دقیقه → update.

import { describe, expect, it, vi } from "vitest"

import {
    getActiveUserStats,
    touchAuthenticatedActivity,
} from "./userActivity.service"

function makePrisma(updateMany: ReturnType<typeof vi.fn>) {
    return { user: { updateMany } }
}

const NOW = new Date("2026-09-16T12:00:00.000Z")

describe("touchAuthenticatedActivity", () => {
    it("updates when lastSeenAt is null (first activity)", async () => {
        const updateMany = vi.fn().mockResolvedValue({ count: 1 })
        const prisma = makePrisma(updateMany)

        const result = await touchAuthenticatedActivity(7, NOW, prisma)

        expect(result.touched).toBe(true)
        expect(updateMany).toHaveBeenCalledTimes(1)
        const args = updateMany.mock.calls[0][0]
        expect(args.where.id).toBe(7)
        // شرط null بودن اولین OR است
        expect(args.where.OR[0]).toEqual({ lastSeenAt: null })
    })

    it("no-op when lastSeenAt is less than 30 minutes ago", async () => {
        const updateMany = vi.fn().mockResolvedValue({ count: 0 })
        const prisma = makePrisma(updateMany)
        const recent = new Date(NOW.getTime() - 29 * 60 * 1000) // 29 دقیقه قبل
        expect(recent.getTime()).toBeGreaterThan(NOW.getTime() - 30 * 60 * 1000) // سانتی

        const result = await touchAuthenticatedActivity(7, NOW, prisma)

        expect(result.touched).toBe(false)
        expect(updateMany).toHaveBeenCalledTimes(1)
        const args = updateMany.mock.calls[0][0]
        // آستانه‌ی شرطی = now - 30min → یک لحظه‌ی ۲۹ دقیقه‌ای جدیدتر از آن است → count 0
        expect(args.where.OR[1].lastSeenAt.lte.toISOString()).toBe(
            new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(),
        )
        // data باید lastSeenAt=now باشد
        expect(args.data.lastSeenAt).toBe(NOW)
    })

    it("updates when lastSeenAt is exactly 30 minutes ago (>= threshold)", async () => {
        const updateMany = vi.fn().mockResolvedValue({ count: 1 })
        const prisma = makePrisma(updateMany)
        const exactly = new Date(NOW.getTime() - 30 * 60 * 1000)

        const result = await touchAuthenticatedActivity(7, NOW, prisma)

        expect(result.touched).toBe(true)
        // مرز >= : یک لحظه دقیقاً ۳۰ دقیقه قبل از شرط lte رد می‌شود → count=1
        expect(updateMany.mock.calls[0][0].where.OR[1].lastSeenAt.lte.toISOString()).toBe(
            exactly.toISOString(),
        )
    })

    it("passes lastSeenAt=now as the update payload", async () => {
        const updateMany = vi.fn().mockResolvedValue({ count: 1 })
        const prisma = makePrisma(updateMany)

        await touchAuthenticatedActivity(42, NOW, prisma)

        const args = updateMany.mock.calls[0][0]
        expect(args.data.lastSeenAt).toBe(NOW)
        expect(args.where.id).toBe(42)
    })

    it("is fail-safe: DB error never rejects and reports touched=false", async () => {
        const updateMany = vi.fn().mockRejectedValue(new Error("db down"))
        const prisma = makePrisma(updateMany)

        await expect(touchAuthenticatedActivity(7, NOW, prisma)).resolves.toEqual({
            touched: false,
        })
    })

    it("reports touched=false when no row matched (count 0)", async () => {
        const updateMany = vi.fn().mockResolvedValue({ count: 0 })
        const prisma = makePrisma(updateMany)

        const result = await touchAuthenticatedActivity(7, NOW, prisma)
        expect(result.touched).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// فاز ۳ — گام ۶: getActiveUserStats (DAU/WAU/MAU — سند §15)
// ---------------------------------------------------------------------------

function makeCountClient(countImpl: (since: Date) => Promise<number>) {
    return {
        user: {
            count: vi.fn().mockImplementation((args: { where: { lastSeenAt: { gte: Date } } }) =>
                countImpl(args.where.lastSeenAt.gte),
            ),
        },
    }
}

const STATS_NOW = new Date("2026-09-16T12:00:00.000Z")
const H = 60 * 60 * 1000

describe("getActiveUserStats (Phase 3 — Step 6)", () => {
    it("counts users with lastSeenAt inside the rolling 24h window (DAU)", async () => {
        const client = makeCountClient(async (since) =>
            since.getTime() === STATS_NOW.getTime() - 24 * H ? 3 : 0,
        )
        const result = await getActiveUserStats(STATS_NOW, client as never)
        expect(result.dau).toBe(3)
    })

    it("counts users with lastSeenAt inside the rolling 168h window (WAU)", async () => {
        const client = makeCountClient(async (since) =>
            since.getTime() === STATS_NOW.getTime() - 168 * H ? 9 : 0,
        )
        const result = await getActiveUserStats(STATS_NOW, client as never)
        expect(result.wau).toBe(9)
    })

    it("counts users with lastSeenAt inside the rolling 720h window (MAU)", async () => {
        const client = makeCountClient(async (since) =>
            since.getTime() === STATS_NOW.getTime() - 720 * H ? 21 : 0,
        )
        const result = await getActiveUserStats(STATS_NOW, client as never)
        expect(result.mau).toBe(21)
    })

    it("applies exact UTC boundaries: inside, exactly-on, and outside the window", async () => {
        // شبیه‌سازی count واقعی: کاربر فعال در لحظه‌ی دقیق boundary شمرده می‌شود (>=)
        const lastSeen = new Date(STATS_NOW.getTime() - 24 * H) // دقیقاً روی boundary DAU
        const client = makeCountClient(async (since) => (lastSeen >= since ? 1 : 0))
        const result = await getActiveUserStats(STATS_NOW, client as never)
        // gte: دقیقاً روی boundary داخل window است
        expect(result.dau).toBe(1)
        // همان لحظه در WAU/MAU قطعاً داخل است
        expect(result.wau).toBe(1)
        expect(result.mau).toBe(1)
    })

    it("excludes users older than the window (outside boundary)", async () => {
        const lastSeen = new Date(STATS_NOW.getTime() - 24 * H - 1) // یک ms قبل از boundary
        const client = makeCountClient(async (since) => (lastSeen >= since ? 1 : 0))
        const result = await getActiveUserStats(STATS_NOW, client as never)
        expect(result.dau).toBe(0)
        expect(result.wau).toBe(1)
        expect(result.mau).toBe(1)
    })

    it("uses gte so null lastSeenAt is never counted (IS NOT NULL implicit)", async () => {
        const client = makeCountClient(async () => 5)
        await getActiveUserStats(STATS_NOW, client as never)
        // سه کوئری، همه روی lastSeenAt با gte — ستون nullable با gte خودکار null را حذف می‌کند
        for (const call of client.user.count.mock.calls) {
            expect(call[0].where.lastSeenAt).toHaveProperty("gte")
            expect(Object.keys(call[0].where)).toEqual(["lastSeenAt"])
        }
    })

    it("issues exactly 3 bounded read queries (dau/wau/mau) — one per window", async () => {
        const client = makeCountClient(async () => 1)
        await getActiveUserStats(STATS_NOW, client as never)
        expect(client.user.count).toHaveBeenCalledTimes(3)
        const [dauCall, wauCall, mauCall] = client.user.count.mock.calls
        expect(dauCall[0].where.lastSeenAt.gte).toEqual(new Date(STATS_NOW.getTime() - 24 * H))
        expect(wauCall[0].where.lastSeenAt.gte).toEqual(new Date(STATS_NOW.getTime() - 168 * H))
        expect(mauCall[0].where.lastSeenAt.gte).toEqual(new Date(STATS_NOW.getTime() - 720 * H))
    })

    it("is deterministic with injected now (UTC instants, no calendar math)", async () => {
        const client = makeCountClient(async () => 2)
        // دو فراخوانی با همان now → همان since ها (rolling UTC، بدون Jalali/canonicalDay)
        await getActiveUserStats(STATS_NOW, client as never)
        await getActiveUserStats(new Date(STATS_NOW.getTime() + 5 * 60 * 1000), client as never)
        const first = client.user.count.mock.calls[0][0].where.lastSeenAt.gte
        const fourth = client.user.count.mock.calls[3][0].where.lastSeenAt.gte
        expect(fourth.getTime() - first.getTime()).toBe(5 * 60 * 1000) // جابجایی دقیق با now
    })

    it("never queries ProductEvent (source is User.lastSeenAt only)", async () => {
        const client = {
            user: { count: vi.fn().mockResolvedValue(1) },
            productEvent: { count: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
        }
        await getActiveUserStats(STATS_NOW, client as never)
        expect(client.user.count).toHaveBeenCalledTimes(3)
        expect(client.productEvent.count).not.toHaveBeenCalled()
        expect(client.productEvent.findMany).not.toHaveBeenCalled()
        expect(client.productEvent.groupBy).not.toHaveBeenCalled()
    })

    it("fails open: DB error returns zeros and never throws", async () => {
        const client = { user: { count: vi.fn().mockRejectedValue(new Error("DB down")) } }
        await expect(getActiveUserStats(STATS_NOW, client as never)).resolves.toEqual({
            dau: 0,
            wau: 0,
            mau: 0,
        })
    })

    it("single-query failure leads to the safe empty result for the whole call", async () => {
        // یکی از سه کوئری reject شود → کل نتیجه امن صفر (Promise.all + fail-open بیرونی)
        const client = {
            user: {
                count: vi
                    .fn()
                    .mockResolvedValueOnce(4)
                    .mockRejectedValueOnce(new Error("DB down"))
                    .mockResolvedValueOnce(8),
            },
        }
        await expect(getActiveUserStats(STATS_NOW, client as never)).resolves.toEqual({
            dau: 0,
            wau: 0,
            mau: 0,
        })
    })

    it("performs no mutation — only user.count is called", async () => {
        const client = { user: { count: vi.fn().mockResolvedValue(0) } }
        await getActiveUserStats(STATS_NOW, client as never)
        expect(client.user.count).toHaveBeenCalledTimes(3)
        // هیچ کلید دیگری جز count در کلاینت استفاده نشد — کلاینت فقط user.count دارد
    })

    it("guards against invalid now / missing client (safe zeros)", async () => {
        const client = makeCountClient(async () => 1)
        await expect(getActiveUserStats(new Date("invalid"), client as never)).resolves.toEqual({
            dau: 0,
            wau: 0,
            mau: 0,
        })
        await expect(getActiveUserStats(STATS_NOW, undefined as never)).resolves.toEqual({
            dau: 0,
            wau: 0,
            mau: 0,
        })
        expect(client.user.count).not.toHaveBeenCalled()
    })
})
