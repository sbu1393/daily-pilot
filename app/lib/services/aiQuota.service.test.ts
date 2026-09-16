// فاز ۱ — تست‌های aiQuota.service
// پوشش سند §8/§9/§11/§13/§15: رزرو موفق ۱/چند یونیت، QUOTA_EXCEEDED، requestId تکراری،
// complete/release موفق و idempotent، transition نامعتبر، خطاهای DB → QUOTA_UNAVAILABLE،
// all-or-nothing بودن رزرو (rollback event هنگام quota denial).

import { beforeEach, describe, expect, it, vi } from "vitest"

import {
    completeQuota,
    releaseQuota,
    reserveQuota,
    type ReserveQuotaInput,
} from "./aiQuota.service"

const NOW = new Date("2026-09-16T12:00:00.000Z")

function makePrisma() {
    return {
        aiUsage: {
            upsert: vi.fn(),
            findUnique: vi.fn(),
            findFirst: vi.fn(),
            update: vi.fn(),
            updateMany: vi.fn(),
        },
        aiUsageEvent: {
            findUnique: vi.fn(),
            create: vi.fn(),
            updateMany: vi.fn(),
        },
        $transaction: vi.fn(),
    }
}

function makeInput(overrides: Partial<ReserveQuotaInput> = {}): ReserveQuotaInput {
    return {
        userId: 7,
        requestId: "req-1",
        allowedUnits: 15,
        units: 1,
        feature: "analyze",
        periodStart: NOW,
        ...overrides,
    }
}

/** سیمولیشن $transaction: callback را با همان prisma صدا می‌زند (mock یکپارچه) */
function wireTransaction(prisma: ReturnType<typeof makePrisma>, impl?: (tx: any) => Promise<any>) {
    prisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<any>) =>
        fn(impl ?? prisma),
    )
}

describe("reserveQuota", () => {
    let prisma: ReturnType<typeof makePrisma>

    beforeEach(() => {
        prisma = makePrisma()
        prisma.aiUsageEvent.findUnique.mockResolvedValue(null) // requestId جدید
        prisma.aiUsage.upsert.mockResolvedValue({ id: 100 })
        prisma.aiUsage.findUnique.mockResolvedValue({ reservedUnits: 0, consumedUnits: 0 })
        prisma.aiUsage.updateMany.mockResolvedValue({ count: 1 })
        prisma.aiUsageEvent.create.mockResolvedValue({ id: 1 })
        wireTransaction(prisma)
    })

    it("reserves 1 unit atomically (event + conditional increment inside transaction)", async () => {
        await expect(reserveQuota(prisma, makeInput())).resolves.toBeUndefined()

        expect(prisma.$transaction).toHaveBeenCalledTimes(1)
        expect(prisma.aiUsageEvent.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                requestId: "req-1",
                userId: 7,
                units: 1,
                status: "RESERVED",
            }),
        })
        const args = prisma.aiUsage.updateMany.mock.calls[0][0]
        expect(args.where.id).toBe(100)
        expect(args.data.reservedUnits).toEqual({ increment: 1 })
    })

    it("reserves multiple units (ai-test = 3 units, all-or-nothing)", async () => {
        prisma.aiUsage.findUnique.mockResolvedValue({ reservedUnits: 0, consumedUnits: 0 })

        await reserveQuota(prisma, makeInput({ units: 3, allowedUnits: 300 }))

        const args = prisma.aiUsage.updateMany.mock.calls[0][0]
        expect(args.data.reservedUnits).toEqual({ increment: 3 })
    })

    it("throws QUOTA_EXCEEDED when claimedTotal exceeds allowedUnits and rolls back event", async () => {
        // 14 رزرو شده + 1 مصرف شده؛ درخواست 3 واحدی با سقف 15 → 14+1+3=18 > 15
        prisma.aiUsage.findUnique.mockResolvedValue({ reservedUnits: 14, consumedUnits: 1 })

        await expect(
            reserveQuota(prisma, makeInput({ units: 3 })),
        ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", status: 429 })

        // all-or-nothing: چون throw داخل transaction بود، create رویداد rollback شده است
        // (شبیه‌ساز ما rollback واقعی ندارد؛ برای اطمینان چک می‌کنیم increment هرگز اجرا نشده)
        expect(prisma.aiUsage.updateMany).not.toHaveBeenCalled()
    })

    it("throws QUOTA_EXCEEDED exactly at the boundary when over by one (15+1 > 15)", async () => {
        prisma.aiUsage.findUnique.mockResolvedValue({ reservedUnits: 15, consumedUnits: 0 })

        await expect(reserveQuota(prisma, makeInput({ units: 1 }))).rejects.toMatchObject({
            code: "QUOTA_EXCEEDED",
        })
    })

    it("succeeds exactly at the boundary (14 used, 1 requested, limit 15)", async () => {
        prisma.aiUsage.findUnique.mockResolvedValue({ reservedUnits: 14, consumedUnits: 1 })

        // 14 + 1 + 1 = 16 > 15 → باید رد شود
        await expect(reserveQuota(prisma, makeInput({ units: 1 }))).rejects.toMatchObject({
            code: "QUOTA_EXCEEDED",
        })

        // اما 13+1+1=15 <= 15 → موفق
        prisma.aiUsage.findUnique.mockResolvedValue({ reservedUnits: 13, consumedUnits: 1 })
        await expect(reserveQuota(prisma, makeInput({ units: 1 }))).resolves.toBeUndefined()
    })

    it.each(["RESERVED", "CONSUMED", "RELEASED"])(
        "duplicate requestId (%s) → IDEMPOTENCY_CONFLICT before any reservation",
        async (status) => {
            prisma.aiUsageEvent.findUnique.mockResolvedValue({ status })

            await expect(reserveQuota(prisma, makeInput())).rejects.toMatchObject({
                code: "IDEMPOTENCY_CONFLICT",
                status: 409,
            })
            // هیچ رزرو، رویداد یا incrementی انجام نشده
            expect(prisma.aiUsage.upsert).not.toHaveBeenCalled()
            expect(prisma.aiUsageEvent.create).not.toHaveBeenCalled()
            expect(prisma.aiUsage.updateMany).not.toHaveBeenCalled()
        },
    )

    it("fail-closed: upsert DB error → QUOTA_UNAVAILABLE", async () => {
        prisma.aiUsage.upsert.mockRejectedValue(new Error("db down"))

        await expect(reserveQuota(prisma, makeInput())).rejects.toMatchObject({
            code: "QUOTA_UNAVAILABLE",
            status: 503,
        })
    })

    it("fail-closed: transaction DB error → QUOTA_UNAVAILABLE", async () => {
        prisma.$transaction.mockRejectedValue(new Error("connection lost"))

        await expect(reserveQuota(prisma, makeInput())).rejects.toMatchObject({
            code: "QUOTA_UNAVAILABLE",
            status: 503,
        })
    })

    it("handles first-row creation race with bounded retry then fail-closed", async () => {
        const race = { code: "P2002" }
        prisma.aiUsage.upsert
            .mockRejectedValueOnce(race)
            .mockRejectedValueOnce(race)
            .mockResolvedValueOnce({ id: 100 })

        await expect(reserveQuota(prisma, makeInput())).resolves.toBeUndefined()
        expect(prisma.aiUsage.upsert).toHaveBeenCalledTimes(3)
    })

    it("gives up after bounded retries and fails closed", async () => {
        prisma.aiUsage.upsert.mockRejectedValue({ code: "P2002" })

        await expect(reserveQuota(prisma, makeInput())).rejects.toMatchObject({
            code: "QUOTA_UNAVAILABLE",
        })
        expect(prisma.aiUsage.upsert).toHaveBeenCalledTimes(3)
    })
})

describe("completeQuota", () => {
    let prisma: ReturnType<typeof makePrisma>

    beforeEach(() => {
        prisma = makePrisma()
        prisma.aiUsageEvent.findUnique.mockResolvedValue({ status: "RESERVED" })
        wireTransaction(prisma)
        prisma.aiUsageEvent.updateMany.mockResolvedValue({ count: 1 })
        prisma.aiUsageEvent.findUnique
            .mockResolvedValueOnce({ status: "RESERVED" })
            .mockResolvedValueOnce({ units: 2, userId: 7 })
        prisma.aiUsage.findFirst.mockResolvedValue({ id: 100 })
        prisma.aiUsage.update.mockResolvedValue({})
    })

    it("moves counters atomically (reserved −2 / consumed +2) and marks CONSUMED", async () => {
        const result = await completeQuota(prisma, "req-1", 2)

        expect(result).toBe(true)
        expect(prisma.$transaction).toHaveBeenCalledTimes(1)
        expect(prisma.aiUsageEvent.updateMany).toHaveBeenCalledWith({
            where: { requestId: "req-1", status: "RESERVED" },
            data: { status: "CONSUMED" },
        })
        expect(prisma.aiUsage.update).toHaveBeenCalledWith({
            where: { id: 100 },
            data: {
                reservedUnits: { decrement: 2 },
                consumedUnits: { increment: 2 },
            },
        })
    })

    it("is idempotent: already CONSUMED → no-op (false), no counter movement", async () => {
        prisma.aiUsageEvent.findUnique.mockReset()
        prisma.aiUsageEvent.findUnique.mockResolvedValue({ status: "CONSUMED" })

        const result = await completeQuota(prisma, "req-1", 1)

        expect(result).toBe(false)
        expect(prisma.aiUsage.update).not.toHaveBeenCalled()
        expect(prisma.aiUsageEvent.updateMany).not.toHaveBeenCalled()
    })

    it("invalid transition: RELEASED → complete → AI_USAGE_CONFLICT (409)", async () => {
        prisma.aiUsageEvent.findUnique.mockReset()
        prisma.aiUsageEvent.findUnique.mockResolvedValue({ status: "RELEASED" })

        await expect(completeQuota(prisma, "req-1", 1)).rejects.toMatchObject({
            code: "AI_USAGE_CONFLICT",
            status: 409,
        })
        expect(prisma.aiUsage.update).not.toHaveBeenCalled()
    })

    it("fail-closed: transaction DB error → QUOTA_UNAVAILABLE", async () => {
        prisma.$transaction.mockRejectedValue(new Error("db down"))

        await expect(completeQuota(prisma, "req-1", 1)).rejects.toMatchObject({
            code: "QUOTA_UNAVAILABLE",
            status: 503,
        })
    })
})

describe("releaseQuota", () => {
    let prisma: ReturnType<typeof makePrisma>

    beforeEach(() => {
        prisma = makePrisma()
        prisma.aiUsageEvent.findUnique.mockResolvedValue({ status: "RESERVED" })
        wireTransaction(prisma)
        prisma.aiUsageEvent.updateMany.mockResolvedValue({ count: 1 })
        prisma.aiUsageEvent.findUnique
            .mockResolvedValueOnce({ status: "RESERVED" })
            .mockResolvedValueOnce({ units: 1, userId: 7 })
        prisma.aiUsage.findFirst.mockResolvedValue({ id: 100 })
        prisma.aiUsage.update.mockResolvedValue({})
    })

    it("decrements reservedUnits only (no consumedUnits change) and marks RELEASED", async () => {
        const result = await releaseQuota(prisma, "req-1", 1)

        expect(result).toBe(true)
        expect(prisma.aiUsageEvent.updateMany).toHaveBeenCalledWith({
            where: { requestId: "req-1", status: "RESERVED" },
            data: { status: "RELEASED" },
        })
        expect(prisma.aiUsage.update).toHaveBeenCalledWith({
            where: { id: 100 },
            data: { reservedUnits: { decrement: 1 } },
        })
    })

    it("is idempotent: already RELEASED → no-op (false), no counter movement", async () => {
        prisma.aiUsageEvent.findUnique.mockReset()
        prisma.aiUsageEvent.findUnique.mockResolvedValue({ status: "RELEASED" })

        const result = await releaseQuota(prisma, "req-1", 1)

        expect(result).toBe(false)
        expect(prisma.aiUsage.update).not.toHaveBeenCalled()
    })

    it("invalid transition: CONSUMED → release → AI_USAGE_CONFLICT (409)", async () => {
        prisma.aiUsageEvent.findUnique.mockReset()
        prisma.aiUsageEvent.findUnique.mockResolvedValue({ status: "CONSUMED" })

        await expect(releaseQuota(prisma, "req-1", 1)).rejects.toMatchObject({
            code: "AI_USAGE_CONFLICT",
            status: 409,
        })
        expect(prisma.aiUsage.update).not.toHaveBeenCalled()
    })

    it("fail-closed: release DB error → QUOTA_UNAVAILABLE (event stays RESERVED for reconciliation)", async () => {
        prisma.$transaction.mockRejectedValue(new Error("db down"))

        await expect(releaseQuota(prisma, "req-1", 1)).rejects.toMatchObject({
            code: "QUOTA_UNAVAILABLE",
            status: 503,
        })
        // چون transaction شکست خورد، هیچ update موفقی ثبت نشده
        expect(prisma.aiUsage.update).not.toHaveBeenCalled()
    })
})

describe("HTTP independence", () => {
    it("service modules import nothing from next/server", async () => {
        const quotaSrc = await import("node:fs").then((fs) =>
            fs.promises.readFile("app/lib/services/aiQuota.service.ts", "utf-8"),
        )
        const usageSrc = await import("node:fs").then((fs) =>
            fs.promises.readFile("app/lib/services/aiUsage.service.ts", "utf-8"),
        )
        expect(quotaSrc).not.toMatch(/from\s+["']next/)
        expect(usageSrc).not.toMatch(/from\s+["']next/)
    })
})
