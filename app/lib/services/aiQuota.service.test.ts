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

/** سیمولیشن $transaction با یک کلاینت `tx` متمایز — تست مرز تراکنش (سند §18) */
function wireTransactionClient(
    prisma: ReturnType<typeof makePrisma>,
    tx: ReturnType<typeof makePrisma>,
) {
    prisma.$transaction.mockImplementation(async (fn: (client: any) => Promise<any>) => fn(tx))
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

    /* ---- P1-4: bounded optimistic retry (بدون denial جعلی، بدون overspend) ---- */

    it("retries on a concurrent change instead of returning a false QUOTA_EXCEEDED", async () => {
        prisma.aiUsage.findUnique
            .mockResolvedValueOnce({ reservedUnits: 0, consumedUnits: 0 }) // read اول
            .mockResolvedValueOnce({ reservedUnits: 1, consumedUnits: 0 }) // read تازه بعد از رقابت
        prisma.aiUsage.updateMany
            .mockResolvedValueOnce({ count: 0 }) // CAS باخت
            .mockResolvedValueOnce({ count: 1 }) // دور بعد موفق

        await expect(reserveQuota(prisma, makeInput({ units: 1 }))).resolves.toBeUndefined()

        expect(prisma.aiUsage.findUnique).toHaveBeenCalledTimes(2)
        expect(prisma.aiUsage.updateMany).toHaveBeenCalledTimes(2)
        // هر دور فقط units را increment می‌کند — هرگز overspend
        for (const call of prisma.aiUsage.updateMany.mock.calls) {
            expect(call[0].data.reservedUnits).toEqual({ increment: 1 })
        }
    })

    it("exhausts bounded retries under pure contention with QUOTA_UNAVAILABLE (not a false QUOTA_EXCEEDED)", async () => {
        prisma.aiUsage.findUnique.mockResolvedValue({ reservedUnits: 0, consumedUnits: 0 })
        prisma.aiUsage.updateMany.mockResolvedValue({ count: 0 })

        await expect(reserveQuota(prisma, makeInput())).rejects.toMatchObject({
            code: "QUOTA_UNAVAILABLE",
            status: 503,
        })
        // حلقه بی‌پایان نیست: حداکثر ۵ دور
        expect(prisma.aiUsage.findUnique).toHaveBeenCalledTimes(5)
        expect(prisma.aiUsage.updateMany).toHaveBeenCalledTimes(5)
    })

    it("still rejects immediately with QUOTA_EXCEEDED when the fresh read is genuinely over the limit", async () => {
        prisma.aiUsage.findUnique.mockResolvedValue({ reservedUnits: 15, consumedUnits: 0 })

        await expect(reserveQuota(prisma, makeInput({ units: 1 }))).rejects.toMatchObject({
            code: "QUOTA_EXCEEDED",
            status: 429,
        })
        // exceed واقعی → هیچ تلاش incrementی انجام نمی‌شود
        expect(prisma.aiUsage.updateMany).not.toHaveBeenCalled()
    })
})

describe("completeQuota", () => {
    let prisma: ReturnType<typeof makePrisma>

    beforeEach(() => {
        prisma = makePrisma()
        wireTransaction(prisma)
        prisma.aiUsageEvent.findUnique
            .mockResolvedValueOnce({ status: "RESERVED" })
            .mockResolvedValueOnce({ units: 2, userId: 7 })
        prisma.aiUsageEvent.updateMany.mockResolvedValue({ count: 1 })
        // P1-3: decrement روی همان periodStart رزرو (updateMany شرطی، نه findFirst+update)
        prisma.aiUsage.updateMany.mockResolvedValue({ count: 1 })
    })

    it("moves counters atomically (reserved −2 / consumed +2) and marks CONSUMED", async () => {
        const periodStart = new Date("2026-09-01T00:00:00.000Z")
        const result = await completeQuota(prisma, "req-1", 2, { periodStart })

        expect(result).toBe(true)
        expect(prisma.$transaction).toHaveBeenCalledTimes(1)
        expect(prisma.aiUsageEvent.updateMany).toHaveBeenCalledWith({
            where: { requestId: "req-1", status: "RESERVED" },
            data: { status: "CONSUMED" },
        })
        expect(prisma.aiUsage.updateMany).toHaveBeenCalledWith({
            where: {
                userId: 7,
                periodType: "MONTHLY",
                periodStart,
                reservedUnits: { gte: 2 },
            },
            data: {
                reservedUnits: { decrement: 2 },
                consumedUnits: { increment: 2 },
            },
        })
        // هیچ انتخاب مبهم «آخرین ماه»ای وجود ندارد
        expect(prisma.aiUsage.findFirst).not.toHaveBeenCalled()
    })

    it("is idempotent: already CONSUMED → no-op (false), no counter movement", async () => {
        prisma.aiUsageEvent.findUnique.mockReset()
        prisma.aiUsageEvent.findUnique.mockResolvedValue({ status: "CONSUMED" })

        const result = await completeQuota(prisma, "req-1", 1, {
            periodStart: new Date("2026-09-01T00:00:00.000Z"),
        })

        expect(result).toBe(false)
        expect(prisma.aiUsage.updateMany).not.toHaveBeenCalled()
        expect(prisma.aiUsageEvent.updateMany).not.toHaveBeenCalled()
    })

    it("invalid transition: RELEASED → complete → AI_USAGE_CONFLICT (409)", async () => {
        prisma.aiUsageEvent.findUnique.mockReset()
        prisma.aiUsageEvent.findUnique.mockResolvedValue({ status: "RELEASED" })

        await expect(
            completeQuota(prisma, "req-1", 1, {
                periodStart: new Date("2026-09-01T00:00:00.000Z"),
            }),
        ).rejects.toMatchObject({
            code: "AI_USAGE_CONFLICT",
            status: 409,
        })
        expect(prisma.aiUsage.updateMany).not.toHaveBeenCalled()
    })

    it("fail-closed: transaction DB error → QUOTA_UNAVAILABLE", async () => {
        prisma.$transaction.mockRejectedValue(new Error("db down"))

        await expect(
            completeQuota(prisma, "req-1", 1, {
                periodStart: new Date("2026-09-01T00:00:00.000Z"),
            }),
        ).rejects.toMatchObject({
            code: "QUOTA_UNAVAILABLE",
            status: 503,
        })
    })

    it("targets the reservation's own period across a month rollover (no findFirst desc)", async () => {
        const sepPeriod = new Date("2026-09-01T00:00:00.000Z")
        await completeQuota(prisma, "req-1", 1, { periodStart: sepPeriod })

        const args = prisma.aiUsage.updateMany.mock.calls[0][0]
        expect(args.where.periodStart).toBe(sepPeriod)
        expect(prisma.aiUsage.findFirst).not.toHaveBeenCalled()
    })

    it("fail-closed when the exact period row cannot absorb the decrement (invariant reservedUnits >= 0)", async () => {
        prisma.aiUsage.updateMany.mockResolvedValue({ count: 0 })

        await expect(
            completeQuota(prisma, "req-1", 1, {
                periodStart: new Date("2026-09-01T00:00:00.000Z"),
            }),
        ).rejects.toMatchObject({ code: "QUOTA_UNAVAILABLE", status: 503 })
    })

    it("rejects a missing periodStart as fail-closed QUOTA_UNAVAILABLE", async () => {
        await expect(
            completeQuota(prisma, "req-1", 1, undefined as unknown as { periodStart: Date }),
        ).rejects.toMatchObject({ code: "QUOTA_UNAVAILABLE", status: 503 })
    })
})

describe("releaseQuota", () => {
    let prisma: ReturnType<typeof makePrisma>

    beforeEach(() => {
        prisma = makePrisma()
        wireTransaction(prisma)
        prisma.aiUsageEvent.findUnique
            .mockResolvedValueOnce({ status: "RESERVED" })
            .mockResolvedValueOnce({ units: 1, userId: 7 })
        prisma.aiUsageEvent.updateMany.mockResolvedValue({ count: 1 })
        // P1-3: decrement روی همان periodStart رزرو
        prisma.aiUsage.updateMany.mockResolvedValue({ count: 1 })
    })

    it("decrements reservedUnits only (no consumedUnits change) and marks RELEASED", async () => {
        const periodStart = new Date("2026-09-01T00:00:00.000Z")
        const result = await releaseQuota(prisma, "req-1", 1, { periodStart })

        expect(result).toBe(true)
        expect(prisma.aiUsageEvent.updateMany).toHaveBeenCalledWith({
            where: { requestId: "req-1", status: "RESERVED" },
            data: { status: "RELEASED" },
        })
        expect(prisma.aiUsage.updateMany).toHaveBeenCalledWith({
            where: {
                userId: 7,
                periodType: "MONTHLY",
                periodStart,
                reservedUnits: { gte: 1 },
            },
            data: { reservedUnits: { decrement: 1 } },
        })
        expect(prisma.aiUsage.findFirst).not.toHaveBeenCalled()
    })

    it("writes the given failureCode on the same atomic RESERVED → RELEASED transition (فاز ۱ §۱۲)", async () => {
        const periodStart = new Date("2026-09-01T00:00:00.000Z")
        const result = await releaseQuota(prisma, "req-1", undefined, {
            failureCode: "AI_PROVIDER_UNAVAILABLE",
            periodStart,
        })

        expect(result).toBe(true)
        expect(prisma.aiUsageEvent.updateMany).toHaveBeenCalledWith({
            where: { requestId: "req-1", status: "RESERVED" },
            data: { status: "RELEASED", failureCode: "AI_PROVIDER_UNAVAILABLE" },
        })
        // کاهش شمارنده دست‌نخورده است
        expect(prisma.aiUsage.updateMany).toHaveBeenCalledWith({
            where: {
                userId: 7,
                periodType: "MONTHLY",
                periodStart,
                reservedUnits: { gte: 1 },
            },
            data: { reservedUnits: { decrement: 1 } },
        })
    })

    it("omits failureCode entirely when none is provided (backward-compatible payload)", async () => {
        await releaseQuota(prisma, "req-1", undefined, {
            periodStart: new Date("2026-09-01T00:00:00.000Z"),
        })

        expect(prisma.aiUsageEvent.updateMany).toHaveBeenCalledWith({
            where: { requestId: "req-1", status: "RESERVED" },
            data: { status: "RELEASED" },
        })
    })

    it("is idempotent: already RELEASED → no-op (false), no counter movement", async () => {
        prisma.aiUsageEvent.findUnique.mockReset()
        prisma.aiUsageEvent.findUnique.mockResolvedValue({ status: "RELEASED" })

        const result = await releaseQuota(prisma, "req-1", 1, {
            periodStart: new Date("2026-09-01T00:00:00.000Z"),
        })

        expect(result).toBe(false)
        expect(prisma.aiUsage.updateMany).not.toHaveBeenCalled()
    })

    it("invalid transition: CONSUMED → release → AI_USAGE_CONFLICT (409)", async () => {
        prisma.aiUsageEvent.findUnique.mockReset()
        prisma.aiUsageEvent.findUnique.mockResolvedValue({ status: "CONSUMED" })

        await expect(
            releaseQuota(prisma, "req-1", 1, {
                periodStart: new Date("2026-09-01T00:00:00.000Z"),
            }),
        ).rejects.toMatchObject({
            code: "AI_USAGE_CONFLICT",
            status: 409,
        })
        expect(prisma.aiUsage.updateMany).not.toHaveBeenCalled()
    })

    it("fail-closed: release DB error → QUOTA_UNAVAILABLE (event stays RESERVED for reconciliation)", async () => {
        prisma.$transaction.mockRejectedValue(new Error("db down"))

        await expect(
            releaseQuota(prisma, "req-1", 1, {
                periodStart: new Date("2026-09-01T00:00:00.000Z"),
            }),
        ).rejects.toMatchObject({
            code: "QUOTA_UNAVAILABLE",
            status: 503,
        })
        // چون transaction شکست خورد، هیچ update موفقی ثبت نشده
        expect(prisma.aiUsage.updateMany).not.toHaveBeenCalled()
    })

    it("fail-closed when the exact period row is missing/insufficient (invariant reservedUnits >= 0)", async () => {
        prisma.aiUsage.updateMany.mockResolvedValue({ count: 0 })

        await expect(
            releaseQuota(prisma, "req-1", 1, {
                periodStart: new Date("2026-09-01T00:00:00.000Z"),
            }),
        ).rejects.toMatchObject({ code: "QUOTA_UNAVAILABLE", status: 503 })
    })

    it("targets the reservation's own period across a month rollover (no findFirst desc)", async () => {
        const sepPeriod = new Date("2026-09-01T00:00:00.000Z")
        await releaseQuota(prisma, "req-1", 1, { periodStart: sepPeriod })

        expect(prisma.aiUsage.updateMany.mock.calls[0][0].where.periodStart).toBe(sepPeriod)
        expect(prisma.aiUsage.findFirst).not.toHaveBeenCalled()
    })
})

describe("§18 service boundaries + transaction client (D3)", () => {
    it("reserve: event creation and quota CAS run on the transaction client, never on root prisma", async () => {
        const root = makePrisma()
        const tx = makePrisma()

        root.aiUsageEvent.findUnique.mockResolvedValue(null) // idempotency pre-check
        root.aiUsage.upsert.mockResolvedValue({ id: 100 })
        tx.aiUsage.findUnique.mockResolvedValue({ reservedUnits: 0, consumedUnits: 0 })
        tx.aiUsage.updateMany.mockResolvedValue({ count: 1 })
        tx.aiUsageEvent.create.mockResolvedValue({ id: 1 })
        wireTransactionClient(root, tx)

        await expect(reserveQuota(root, makeInput())).resolves.toBeUndefined()

        // creation + CAS روی همان tx تراکنش (§18 / atomicity)
        expect(tx.aiUsageEvent.create).toHaveBeenCalledTimes(1)
        expect(tx.aiUsage.updateMany).toHaveBeenCalledTimes(1)
        // هیچ event/quota mutation روی root prisma
        expect(root.aiUsageEvent.create).not.toHaveBeenCalled()
        expect(root.aiUsage.updateMany).not.toHaveBeenCalled()
        // خواندن idempotency و upsert ردیف دوره، عمدتاً قبل از تراکنش و روی root است
        expect(root.aiUsageEvent.findUnique).toHaveBeenCalledTimes(1)
        expect(root.aiUsage.upsert).toHaveBeenCalledTimes(1)
    })

    it("complete: event transition and quota-row update run on the transaction client", async () => {
        const root = makePrisma()
        const tx = makePrisma()

        root.aiUsageEvent.findUnique.mockResolvedValue({ status: "RESERVED" }) // pre-check
        tx.aiUsageEvent.findUnique.mockResolvedValue({ units: 1, userId: 7 })
        tx.aiUsageEvent.updateMany.mockResolvedValue({ count: 1 })
        tx.aiUsage.updateMany.mockResolvedValue({ count: 1 })
        wireTransactionClient(root, tx)

        await expect(
            completeQuota(root, "req-1", undefined, { periodStart: NOW }),
        ).resolves.toBe(true)

        expect(tx.aiUsageEvent.updateMany).toHaveBeenCalledTimes(1)
        expect(tx.aiUsage.updateMany).toHaveBeenCalledTimes(1)
        expect(root.aiUsageEvent.updateMany).not.toHaveBeenCalled()
        expect(root.aiUsage.updateMany).not.toHaveBeenCalled()
    })

    it("release: event transition (with failureCode) and quota-row update run on the transaction client", async () => {
        const root = makePrisma()
        const tx = makePrisma()

        root.aiUsageEvent.findUnique.mockResolvedValue({ status: "RESERVED" })
        tx.aiUsageEvent.findUnique.mockResolvedValue({ units: 1, userId: 7 })
        tx.aiUsageEvent.updateMany.mockResolvedValue({ count: 1 })
        tx.aiUsage.updateMany.mockResolvedValue({ count: 1 })
        wireTransactionClient(root, tx)

        await expect(
            releaseQuota(root, "req-1", undefined, {
                periodStart: NOW,
                failureCode: "AI_PROVIDER_UNAVAILABLE",
            }),
        ).resolves.toBe(true)

        expect(tx.aiUsageEvent.updateMany).toHaveBeenCalledTimes(1)
        expect(tx.aiUsageEvent.updateMany.mock.calls[0][0].data).toEqual({
            status: "RELEASED",
            failureCode: "AI_PROVIDER_UNAVAILABLE",
        })
        expect(tx.aiUsage.updateMany).toHaveBeenCalledTimes(1)
        expect(root.aiUsageEvent.updateMany).not.toHaveBeenCalled()
        expect(root.aiUsage.updateMany).not.toHaveBeenCalled()
    })

    it("source boundary: aiQuota owns no direct AiUsageEvent access but keeps the transaction (§18)", async () => {
        const fs = await import("node:fs")
        const quotaSrc = await fs.promises.readFile("app/lib/services/aiQuota.service.ts", "utf-8")
        const usageSrc = await fs.promises.readFile("app/lib/services/aiUsage.service.ts", "utf-8")

        // creation/state-transition مالکیت aiUsage است (سند §18)
        expect(quotaSrc).not.toMatch(/aiUsageEvent\./)
        expect(quotaSrc).toMatch(/\$transaction/)
        expect(quotaSrc).toMatch(/transitionEventToConsumed/)
        expect(quotaSrc).toMatch(/transitionEventToReleased/)
        // aiUsage نباید به aiQuota وابسته باشد و نباید transaction بسازد
        expect(usageSrc).not.toMatch(/from\s+["']\.\/aiQuota\.service["']/)
        expect(usageSrc).not.toMatch(/\$transaction/)
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
