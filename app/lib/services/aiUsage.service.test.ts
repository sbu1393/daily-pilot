// فاز ۱ — تست‌های aiUsage.service
// پوشش: ساخت رویداد RESERVED، requestId تکراری → IDEMPOTENCY_CONFLICT،
// transitionهای مجاز/نامعتبر (state machine سند §11)، fail-closed خطاهای DB.

import { beforeEach, describe, expect, it, vi } from "vitest"

import {
    assertTransitionAllowed,
    createReservedEvent,
    findEventStatusByRequestId,
    markEventConsumed,
    markEventReleased,
} from "./aiUsage.service"

function makePrisma() {
    return {
        aiUsageEvent: {
            findUnique: vi.fn(),
            create: vi.fn(),
            updateMany: vi.fn(),
        },
    }
}

const BASE = {
    requestId: "req-1",
    userId: 7,
    feature: "analyze",
    units: 1,
}

describe("findEventStatusByRequestId", () => {
    it("returns null when no event exists", async () => {
        const prisma = makePrisma()
        prisma.aiUsageEvent.findUnique.mockResolvedValue(null)

        await expect(findEventStatusByRequestId(prisma, "req-1")).resolves.toBeNull()
    })

    it("returns the stored status", async () => {
        const prisma = makePrisma()
        prisma.aiUsageEvent.findUnique.mockResolvedValue({ status: "CONSUMED" })

        await expect(findEventStatusByRequestId(prisma, "req-1")).resolves.toBe("CONSUMED")
    })

    it("is fail-closed: DB error → QuotaUnavailableError", async () => {
        const prisma = makePrisma()
        prisma.aiUsageEvent.findUnique.mockRejectedValue(new Error("db down"))

        await expect(findEventStatusByRequestId(prisma, "req-1")).rejects.toMatchObject({
            code: "QUOTA_UNAVAILABLE",
            status: 503,
        })
    })
})

describe("createReservedEvent", () => {
    it("creates a RESERVED event with attempts=1 and safe metadata", async () => {
        const prisma = makePrisma()
        prisma.aiUsageEvent.create.mockResolvedValue({ id: 1, ...BASE, status: "RESERVED" })

        const event = await createReservedEvent(prisma, { ...BASE, model: "mock-model" })

        expect(event.status).toBe("RESERVED")
        const data = prisma.aiUsageEvent.create.mock.calls[0][0].data
        expect(data.status).toBe("RESERVED")
        expect(data.attempts).toBe(1)
        expect(data.units).toBe(1)
        expect(data.model).toBe("mock-model")
        // هیچ فیلد حساسی در data نیست
        expect(JSON.stringify(data)).not.toMatch(/password|token|prompt|secret/i)
    })

    it("duplicate requestId (P2002) → IdempotencyConflictError", async () => {
        const prisma = makePrisma()
        prisma.aiUsageEvent.create.mockRejectedValue({ code: "P2002" })

        await expect(createReservedEvent(prisma, BASE)).rejects.toMatchObject({
            code: "IDEMPOTENCY_CONFLICT",
            status: 409,
        })
    })

    it("other DB errors → fail-closed QuotaUnavailableError", async () => {
        const prisma = makePrisma()
        prisma.aiUsageEvent.create.mockRejectedValue(new Error("db down"))

        await expect(createReservedEvent(prisma, BASE)).rejects.toMatchObject({
            code: "QUOTA_UNAVAILABLE",
            status: 503,
        })
    })
})

describe("markEventConsumed / markEventReleased", () => {
    it("consumed transition succeeds only from RESERVED", async () => {
        const prisma = makePrisma()
        prisma.aiUsageEvent.updateMany.mockResolvedValue({ count: 1 })

        await expect(markEventConsumed(prisma, "req-1")).resolves.toBe(true)
        const args = prisma.aiUsageEvent.updateMany.mock.calls[0][0]
        expect(args.where).toEqual({ requestId: "req-1", status: "RESERVED" })
        expect(args.data).toEqual({ status: "CONSUMED" })
    })

    it("consumed transition returns false when already consumed (count 0)", async () => {
        const prisma = makePrisma()
        prisma.aiUsageEvent.updateMany.mockResolvedValue({ count: 0 })

        await expect(markEventConsumed(prisma, "req-1")).resolves.toBe(false)
    })

    it("released transition succeeds only from RESERVED", async () => {
        const prisma = makePrisma()
        prisma.aiUsageEvent.updateMany.mockResolvedValue({ count: 1 })

        await expect(markEventReleased(prisma, "req-1")).resolves.toBe(true)
        const args = prisma.aiUsageEvent.updateMany.mock.calls[0][0]
        expect(args.where).toEqual({ requestId: "req-1", status: "RESERVED" })
        expect(args.data).toEqual({ status: "RELEASED" })
    })

    it("released transition returns false when already released (count 0)", async () => {
        const prisma = makePrisma()
        prisma.aiUsageEvent.updateMany.mockResolvedValue({ count: 0 })

        await expect(markEventReleased(prisma, "req-1")).resolves.toBe(false)
    })

    it.each([markEventConsumed, markEventReleased])(
        "%p is fail-closed: DB error → QuotaUnavailableError",
        async (fn) => {
            const prisma = makePrisma()
            prisma.aiUsageEvent.updateMany.mockRejectedValue(new Error("db down"))

            await expect(fn(prisma, "req-1")).rejects.toMatchObject({
                code: "QUOTA_UNAVAILABLE",
                status: 503,
            })
        },
    )
})

describe("assertTransitionAllowed (state machine §11)", () => {
    it("RESERVED → CONSUMED allowed", () => {
        expect(assertTransitionAllowed("RESERVED", "CONSUMED")).toBe("allowed")
    })
    it("RESERVED → RELEASED allowed", () => {
        expect(assertTransitionAllowed("RESERVED", "RELEASED")).toBe("allowed")
    })
    it("CONSUMED → CONSUMED idempotent", () => {
        expect(assertTransitionAllowed("CONSUMED", "CONSUMED")).toBe("idempotent")
    })
    it("RELEASED → RELEASED idempotent", () => {
        expect(assertTransitionAllowed("RELEASED", "RELEASED")).toBe("idempotent")
    })
    it("CONSUMED → RELEASED conflict (invalid)", () => {
        expect(assertTransitionAllowed("CONSUMED", "RELEASED")).toBe("conflict")
    })
    it("RELEASED → CONSUMED conflict (invalid)", () => {
        expect(assertTransitionAllowed("RELEASED", "CONSUMED")).toBe("conflict")
    })
})
