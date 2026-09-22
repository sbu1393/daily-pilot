import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* ADR-07 فاز ۳-B — reminderDelivery.service tests                     */
/* Prisma is mocked: no DB. تأیید idempotency در سطح primitive و      */
/* مقاوم‌بودن mark* در برابر race حذف (P2025).                        */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({ getPrisma: vi.fn() }))

vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: mocks.getPrisma }))

import {
    claimReminderDelivery,
    isRecordNotFound,
    isUniqueViolation,
    markDeliveryFailed,
    markDeliveryGone,
    markDeliverySent,
} from "./reminderDelivery.service"

function makePrisma(overrides?: {
    create?: () => Promise<unknown>
    update?: () => Promise<unknown>
}) {
    const prisma = {
        taskReminderDelivery: {
            create: vi.fn(overrides?.create ?? (async () => ({ id: "d1" }))),
            update: vi.fn(overrides?.update ?? (async () => ({}))),
        },
    }
    mocks.getPrisma.mockReturnValue(prisma)
    return prisma
}

const input = {
    taskId: 1,
    subscriptionId: "s1",
    reminderAt: new Date("2026-09-22T09:30:00.000Z"),
}

describe("claimReminderDelivery", () => {
    beforeEach(() => vi.clearAllMocks())

    it("claims a new delivery and persists it as PENDING", async () => {
        const prisma = makePrisma()

        const claim = await claimReminderDelivery(input)

        expect(claim).toEqual({ id: "d1" })
        expect(prisma.taskReminderDelivery.create).toHaveBeenCalledWith({
            data: { ...input, status: "PENDING", attempts: 1 },
            select: { id: true },
        })
    })

    it("returns null on a unique violation (already claimed) and never throws", async () => {
        makePrisma({
            create: async () => {
                throw Object.assign(new Error("unique"), { code: "P2002" })
            },
        })

        await expect(claimReminderDelivery(input)).resolves.toBeNull()
    })

    it("rethrows non-unique errors so they stay trackable", async () => {
        makePrisma({
            create: async () => {
                throw Object.assign(new Error("boom"), { code: "P2003" })
            },
        })

        await expect(claimReminderDelivery(input)).rejects.toThrow("boom")
    })
})

describe("delivery error helpers", () => {
    it("recognises Prisma codes", () => {
        expect(isUniqueViolation({ code: "P2002" })).toBe(true)
        expect(isRecordNotFound({ code: "P2025" })).toBe(true)
        expect(isRecordNotFound({ code: "P2002" })).toBe(false)
        expect(isRecordNotFound(null)).toBe(false)
    })
})

describe("mark* status updates", () => {
    beforeEach(() => vi.clearAllMocks())

    it("marks SENT with sentAt and marks FAILED/GONE with a failure code", async () => {
        const prisma = makePrisma()
        const now = new Date("2026-09-22T10:00:00.000Z")

        await markDeliverySent("d1", now)
        await markDeliveryFailed("d1", "HTTP_500")
        await markDeliveryGone("d1", "HTTP_410")

        expect(prisma.taskReminderDelivery.update).toHaveBeenNthCalledWith(1, {
            where: { id: "d1" },
            data: { status: "SENT", sentAt: now },
        })
        expect(prisma.taskReminderDelivery.update).toHaveBeenNthCalledWith(2, {
            where: { id: "d1" },
            data: { status: "FAILED", failureCode: "HTTP_500" },
        })
        expect(prisma.taskReminderDelivery.update).toHaveBeenNthCalledWith(3, {
            where: { id: "d1" },
            data: { status: "GONE", failureCode: "HTTP_410" },
        })
    })

    it("is a no-op when the row was cascade-deleted mid-flight (delete race)", async () => {
        makePrisma({
            update: async () => {
                throw Object.assign(new Error("record not found"), { code: "P2025" })
            },
        })

        await expect(markDeliverySent("d1")).resolves.toBeUndefined()
        await expect(markDeliveryFailed("d1", "HTTP_500")).resolves.toBeUndefined()
        await expect(markDeliveryGone("d1", "HTTP_410")).resolves.toBeUndefined()
    })

    it("still rethrows unexpected DB errors", async () => {
        makePrisma({
            update: async () => {
                throw Object.assign(new Error("db down"), { code: "P1001" })
            },
        })

        await expect(markDeliverySent("d1")).rejects.toThrow("db down")
    })
})
