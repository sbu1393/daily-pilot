import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* ADR-07 — push.service smoke tests (Prisma mocked, no DB).           */
/* ------------------------------------------------------------------ */

const { prismaMock, getPrismaMock } = vi.hoisted(() => {
    const prismaMock = {
        pushSubscription: {
            upsert: vi.fn(),
            deleteMany: vi.fn(),
        },
    }
    return { prismaMock, getPrismaMock: vi.fn(() => prismaMock) }
})

vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: getPrismaMock }))

import { removePushSubscription, savePushSubscription } from "./push.service"

const ENDPOINT = "https://push.example.com/abc"
const input = { endpoint: ENDPOINT, keys: { p256dh: "p256dh-key", auth: "auth-key" } }

describe("savePushSubscription", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it("upserts by endpoint, scoped to the server-provided userId, without duplicates", async () => {
        const row = { id: "sub_1", userId: 7, endpoint: ENDPOINT, lastSeenAt: new Date() }
        prismaMock.pushSubscription.upsert.mockResolvedValue(row)

        const result = await savePushSubscription(7, input)

        const args = prismaMock.pushSubscription.upsert.mock.calls[0][0]
        expect(args.where).toEqual({ endpoint: ENDPOINT })
        expect(args.create).toMatchObject({ userId: 7, endpoint: ENDPOINT, p256dh: "p256dh-key", auth: "auth-key" })
        expect(args.update).toMatchObject({ userId: 7, p256dh: "p256dh-key", auth: "auth-key" })
        expect(args.update.lastSeenAt).toBeInstanceOf(Date)
        // پیام حذف نمی‌کند و چیزی برنمی‌گرداند جز فیلدهای غیرحساس
        expect(result).toEqual({ id: "sub_1", userId: 7, endpoint: ENDPOINT, lastSeenAt: row.lastSeenAt })
    })
})

describe("removePushSubscription", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it("deletes only rows matching both endpoint and the current userId", async () => {
        prismaMock.pushSubscription.deleteMany.mockResolvedValue({ count: 1 })

        const result = await removePushSubscription(7, ENDPOINT)

        expect(prismaMock.pushSubscription.deleteMany).toHaveBeenCalledWith({
            where: { endpoint: ENDPOINT, userId: 7 },
        })
        expect(result).toEqual({ removed: true })
    })

    it("is idempotent when nothing matches (foreign or already-removed subscription)", async () => {
        prismaMock.pushSubscription.deleteMany.mockResolvedValue({ count: 0 })

        const result = await removePushSubscription(7, ENDPOINT)

        expect(result).toEqual({ removed: false })
    })
})
