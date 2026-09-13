import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* H1 (audit) — getPrisma() باید در همه‌ی محیط‌ها تک‌نمونه بماند.        */
/* قبلاً کش فقط وقتی NODE_ENV !== "production" بود و در production هر   */
/* فراخوانی یک PrismaClient تازه می‌ساخت (استخر اتصال جدید بدون بستن).  */
/* اینجا PrismaClient mock است تا بدون DB زنده، خودِ قرارداد کش تست شود. */
/* ------------------------------------------------------------------ */

const { PrismaClientMock } = vi.hoisted(() => ({ PrismaClientMock: vi.fn() }))

vi.mock("@prisma/client", () => ({ PrismaClient: PrismaClientMock }))

import { getPrisma } from "./getPrisma"

const globalWithPrisma = globalThis as unknown as { prisma?: unknown }

describe("getPrisma (H1 — singleton)", () => {
    beforeEach(() => {
        PrismaClientMock.mockReset()
        // سازنده‌ی واقعی با new صدا زده می‌شود → تابع معمولی (نه arrow) تا constructible بماند
        PrismaClientMock.mockImplementation(function () {
            return { connected: true }
        })
        delete globalWithPrisma.prisma
    })

    it("returns the same instance and constructs PrismaClient exactly once", () => {
        const first = getPrisma()
        const second = getPrisma()

        expect(first).toBe(second)
        expect(PrismaClientMock).toHaveBeenCalledTimes(1)
    })

    it("caches the client on globalThis in every environment (the production connection-leak fix)", () => {
        const client = getPrisma()

        // کلید رفع H1: کش بدون قید NODE_ENV انجام می‌شود
        expect(globalWithPrisma.prisma).toBe(client)

        getPrisma()
        getPrisma()
        expect(PrismaClientMock).toHaveBeenCalledTimes(1)
    })

    it("reuses an already cached global client instead of building a new one", () => {
        const existing = { connected: "cached" }
        globalWithPrisma.prisma = existing

        expect(getPrisma()).toBe(existing)
        expect(PrismaClientMock).not.toHaveBeenCalled()
    })
})
