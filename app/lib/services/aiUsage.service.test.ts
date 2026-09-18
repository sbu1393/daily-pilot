// فاز ۱ — تست‌های aiUsage.service
// پوشش: ساخت رویداد RESERVED، requestId تکراری → IDEMPOTENCY_CONFLICT،
// transitionهای مجاز/نامعتبر (state machine سند §11)، fail-closed خطاهای DB.

import { beforeEach, describe, expect, it, vi } from "vitest"

import {
    RELEASE_FAILED_CODE,
    assertTransitionAllowed,
    createReservedEvent,
    findEventStatusByRequestId,
    markReleaseFailed,
    transitionEventToConsumed,
    transitionEventToReleased,
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

describe("transitionEventToConsumed / transitionEventToReleased (§18 ownership)", () => {
    it("consumed: read → conditional update from RESERVED → returns the event identity", async () => {
        const prisma = makePrisma()
        prisma.aiUsageEvent.findUnique.mockResolvedValue({ units: 2, userId: 7 })
        prisma.aiUsageEvent.updateMany.mockResolvedValue({ count: 1 })

        await expect(transitionEventToConsumed(prisma, "req-1")).resolves.toEqual({
            units: 2,
            userId: 7,
        })

        expect(prisma.aiUsageEvent.findUnique).toHaveBeenCalledWith({
            where: { requestId: "req-1" },
            select: { units: true, userId: true },
        })
        const args = prisma.aiUsageEvent.updateMany.mock.calls[0][0]
        expect(args.where).toEqual({ requestId: "req-1", status: "RESERVED" })
        expect(args.data).toEqual({ status: "CONSUMED" })
        // ترتیب قفل‌شده: read → conditional update (بدون تغییر نسبت به قبل)
        expect(prisma.aiUsageEvent.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
            prisma.aiUsageEvent.updateMany.mock.invocationCallOrder[0],
        )
    })

    it("consumed: returns null when the event does not exist (no update attempted)", async () => {
        const prisma = makePrisma()
        prisma.aiUsageEvent.findUnique.mockResolvedValue(null)

        await expect(transitionEventToConsumed(prisma, "req-1")).resolves.toBeNull()
        expect(prisma.aiUsageEvent.updateMany).not.toHaveBeenCalled()
    })

    it("consumed: returns null when the event is no longer RESERVED (count 0, idempotent no-op)", async () => {
        const prisma = makePrisma()
        prisma.aiUsageEvent.findUnique.mockResolvedValue({ units: 1, userId: 1 })
        prisma.aiUsageEvent.updateMany.mockResolvedValue({ count: 0 })

        await expect(transitionEventToConsumed(prisma, "req-1")).resolves.toBeNull()
    })

    it("released: writes failureCode only when provided (P1-1 compatibility)", async () => {
        const withoutCode = makePrisma()
        withoutCode.aiUsageEvent.findUnique.mockResolvedValue({ units: 1, userId: 7 })
        withoutCode.aiUsageEvent.updateMany.mockResolvedValue({ count: 1 })

        await expect(transitionEventToReleased(withoutCode, "req-1")).resolves.toEqual({
            units: 1,
            userId: 7,
        })
        expect(withoutCode.aiUsageEvent.updateMany.mock.calls[0][0].data).toEqual({
            status: "RELEASED",
        })

        const withCode = makePrisma()
        withCode.aiUsageEvent.findUnique.mockResolvedValue({ units: 1, userId: 7 })
        withCode.aiUsageEvent.updateMany.mockResolvedValue({ count: 1 })

        await expect(
            transitionEventToReleased(withCode, "req-1", "AI_PROVIDER_UNAVAILABLE"),
        ).resolves.toEqual({ units: 1, userId: 7 })
        expect(withCode.aiUsageEvent.updateMany.mock.calls[0][0].data).toEqual({
            status: "RELEASED",
            failureCode: "AI_PROVIDER_UNAVAILABLE",
        })
    })

    it("released: returns null when the event does not exist or is no longer RESERVED", async () => {
        const missing = makePrisma()
        missing.aiUsageEvent.findUnique.mockResolvedValue(null)
        await expect(transitionEventToReleased(missing, "req-1")).resolves.toBeNull()
        expect(missing.aiUsageEvent.updateMany).not.toHaveBeenCalled()

        const already = makePrisma()
        already.aiUsageEvent.findUnique.mockResolvedValue({ units: 1, userId: 7 })
        already.aiUsageEvent.updateMany.mockResolvedValue({ count: 0 })
        await expect(transitionEventToReleased(already, "req-1")).resolves.toBeNull()
    })

    it.each([transitionEventToConsumed, transitionEventToReleased])(
        "%p is fail-closed: DB error on read → QuotaUnavailableError",
        async (fn) => {
            const prisma = makePrisma()
            prisma.aiUsageEvent.findUnique.mockRejectedValue(new Error("db down"))

            await expect(fn(prisma, "req-1")).rejects.toMatchObject({
                code: "QUOTA_UNAVAILABLE",
                status: 503,
            })
        },
    )

    it.each([transitionEventToConsumed, transitionEventToReleased])(
        "%p is fail-closed: DB error on conditional update → QuotaUnavailableError",
        async (fn) => {
            const prisma = makePrisma()
            prisma.aiUsageEvent.findUnique.mockResolvedValue({ units: 1, userId: 7 })
            prisma.aiUsageEvent.updateMany.mockRejectedValue(new Error("db down"))

            await expect(fn(prisma, "req-1")).rejects.toMatchObject({
                code: "QUOTA_UNAVAILABLE",
                status: 503,
            })
        },
    )
})

describe("markReleaseFailed (§13 release failure)", () => {
    it("marks only a still-RESERVED event with failureCode=RELEASE_FAILED (status untouched)", async () => {
        const prisma = makePrisma()
        prisma.aiUsageEvent.updateMany.mockResolvedValue({ count: 1 })

        await expect(markReleaseFailed(prisma, "req-1")).resolves.toBe(true)

        const args = prisma.aiUsageEvent.updateMany.mock.calls[0][0]
        // فقط event همان requestId که هنوز RESERVED است
        expect(args.where).toEqual({ requestId: "req-1", status: "RESERVED" })
        // فقط failureCode — وضعیت transition نمی‌شود (event در RESERVED می‌ماند)
        expect(args.data).toEqual({ failureCode: RELEASE_FAILED_CODE })
        expect(args.data).not.toHaveProperty("status")
    })

    it("returns false when the event is not RESERVED / not found (count 0) without throwing", async () => {
        const prisma = makePrisma()
        prisma.aiUsageEvent.updateMany.mockResolvedValue({ count: 0 })

        await expect(markReleaseFailed(prisma, "req-1")).resolves.toBe(false)
    })

    it("is best-effort: DB error never throws (fail-closed path must not break)", async () => {
        const prisma = makePrisma()
        prisma.aiUsageEvent.updateMany.mockRejectedValue(new Error("db down"))

        await expect(markReleaseFailed(prisma, "req-1")).resolves.toBe(false)
    })

    it("never throws even when the prisma client is unusable", async () => {
        await expect(markReleaseFailed({} as never, "req-1")).resolves.toBe(false)
    })
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
