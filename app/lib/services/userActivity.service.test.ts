// فاز ۱ — تست‌های userActivity.service
// پوشش: first activity (null) → update، کمتر از ۳۰ دقیقه → no-op، بعد از ۳۰ دقیقه → update.

import { describe, expect, it, vi } from "vitest"

import { touchAuthenticatedActivity } from "./userActivity.service"

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
