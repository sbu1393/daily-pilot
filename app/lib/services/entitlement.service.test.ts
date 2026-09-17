// فاز ۵ — گام ۱۷: unit test های entitlement.service (سند §35: «entitlement activation»،
// «entitlement renewal»، «expired entitlement»، «effective plan resolution» و بخش
// Entitlement tests: first purchase · active renewal · expired renewal · correct start/end ·
// no shortening active entitlement · plan becomes PRO · expiration changes plan to FREE ·
// stale expiration cannot downgrade renewed entitlement)
//
// فقط `PrismaClientLike` تزریق‌شده mock می‌شود (الگوی repo) — هیچ DB واقعی، هیچ P2002 جعلیِ
// پنهان‌کننده‌ی race: هر سناریوی هم‌زمانی با همان شمارش/state واقعی که سرویس می‌خواند مدل شده است.

import { beforeEach, describe, expect, it, vi } from "vitest"

import { EntitlementConflictError } from "./errors"
import { activate, lazyExpire, renew, resolveEffectivePlan } from "./entitlement.service"

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date("2026-09-17T10:00:00.000Z")
const USER = 7

function row(overrides: Record<string, unknown> = {}) {
    return {
        id: "ent_1",
        userId: USER,
        provider: "ZARINPAL",
        status: "ACTIVE",
        planCode: "PRO",
        currentPeriodStart: new Date(NOW.getTime() - 10 * DAY),
        currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY),
        ...overrides,
    }
}

function makeDb() {
    return {
        entitlement: {
            findUnique: vi.fn(),
            create: vi.fn(),
            updateMany: vi.fn(),
        },
        user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    }
}

type Db = ReturnType<typeof makeDb>

const INPUT = { userId: USER, provider: "ZARINPAL" as const, entitlementDays: 30 }

describe("entitlement.service — first purchase (activate)", () => {
    let db: Db

    beforeEach(() => {
        db = makeDb()
    })

    it("creates the first entitlement from now with the purchased duration and sets User.plan = PRO", async () => {
        db.entitlement.findUnique.mockResolvedValue(null)
        const created = row({ currentPeriodStart: NOW, currentPeriodEnd: new Date(NOW.getTime() + 30 * DAY) })
        db.entitlement.create.mockResolvedValue(created)

        const result = await activate(db as never, INPUT, NOW)

        expect(result).toEqual(created)
        expect(db.entitlement.create).toHaveBeenCalledTimes(1)
        const createArgs = db.entitlement.create.mock.calls[0][0]
        expect(createArgs.data).toMatchObject({
            userId: USER,
            provider: "ZARINPAL",
            status: "ACTIVE",
            planCode: "PRO",
            currentPeriodStart: NOW,
            currentPeriodEnd: new Date(NOW.getTime() + 30 * DAY),
        })
        // آینه‌ی سروری plan فقط PRO می‌شود (§18)
        expect(db.user.updateMany).toHaveBeenCalledWith({ where: { id: USER }, data: { plan: "PRO" } })
        expect(db.entitlement.updateMany).not.toHaveBeenCalled()
    })

    it("rejects an invalid purchased duration before touching the database (invariant)", async () => {
        for (const days of [0, -30, 1.5, Number.NaN]) {
            await expect(
                activate(db as never, { ...INPUT, entitlementDays: days }, NOW),
            ).rejects.toBeInstanceOf(EntitlementConflictError)
        }
        expect(db.entitlement.findUnique).not.toHaveBeenCalled()
        expect(db.entitlement.create).not.toHaveBeenCalled()
    })

    it("retries the unique(userId) creation race and only then gives up", async () => {
        db.entitlement.findUnique.mockResolvedValue(null)
        db.entitlement.create
            .mockRejectedValueOnce({ code: "P2002" })
            .mockResolvedValueOnce(row({ currentPeriodStart: NOW }))

        await expect(activate(db as never, INPUT, NOW)).resolves.toMatchObject({ id: "ent_1" })
        expect(db.entitlement.create).toHaveBeenCalledTimes(2)
    })

    it("fails closed with ENTITLEMENT_CONFLICT when the race never resolves", async () => {
        db.entitlement.findUnique.mockResolvedValue(null)
        db.entitlement.create.mockRejectedValue({ code: "P2002" })

        await expect(activate(db as never, INPUT, NOW)).rejects.toBeInstanceOf(
            EntitlementConflictError,
        )
        // هیچ plan ای جعل نمی‌شود
        expect(db.user.updateMany).not.toHaveBeenCalled()
    })

    it("maps any creation failure to ENTITLEMENT_CONFLICT (no raw DB detail leaks)", async () => {
        db.entitlement.findUnique.mockResolvedValue(null)
        db.entitlement.create.mockRejectedValue(new Error("db down: relation Entitlement"))

        await expect(activate(db as never, INPUT, NOW)).rejects.toBeInstanceOf(
            EntitlementConflictError,
        )
    })

    it("fails closed when the User.plan mirror cannot be written (missing user row)", async () => {
        db.entitlement.findUnique.mockResolvedValue(null)
        db.entitlement.create.mockResolvedValue(row())
        db.user.updateMany.mockResolvedValue({ count: 0 })

        await expect(activate(db as never, INPUT, NOW)).rejects.toBeInstanceOf(
            EntitlementConflictError,
        )
    })
})

describe("entitlement.service — renewal / new period (§16)", () => {
    let db: Db

    beforeEach(() => {
        db = makeDb()
    })

    it("extends an active period from its current end (never shortens it)", async () => {
        const existing = row()
        db.entitlement.findUnique
            .mockResolvedValueOnce(existing) // read
            .mockResolvedValueOnce(row({ currentPeriodEnd: new Date(existing.currentPeriodEnd.getTime() + 30 * DAY) })) // re-read
        db.entitlement.updateMany.mockResolvedValue({ count: 1 })

        const result = await renew(db as never, INPUT, NOW)

        expect(db.entitlement.updateMany).toHaveBeenCalledWith({
            where: {
                userId: USER,
                status: "ACTIVE",
                currentPeriodStart: existing.currentPeriodStart,
                currentPeriodEnd: existing.currentPeriodEnd,
            },
            data: {
                provider: "ZARINPAL",
                status: "ACTIVE",
                planCode: "PRO",
                // start دست‌نخورده؛ end = end قبلی + مدت خریداری‌شده
                currentPeriodStart: existing.currentPeriodStart,
                currentPeriodEnd: new Date(existing.currentPeriodEnd.getTime() + 30 * DAY),
            },
        })
        expect(db.user.updateMany).toHaveBeenCalledWith({ where: { id: USER }, data: { plan: "PRO" } })
        expect(result.currentPeriodEnd.getTime()).toBeGreaterThan(existing.currentPeriodEnd.getTime())
    })

    it("uses the order snapshot duration, not the current configuration", async () => {
        const existing = row()
        db.entitlement.findUnique.mockResolvedValueOnce(existing).mockResolvedValueOnce(existing)
        db.entitlement.updateMany.mockResolvedValue({ count: 1 })

        await renew(db as never, { ...INPUT, entitlementDays: 7 }, NOW)

        const data = db.entitlement.updateMany.mock.calls[0][0].data
        expect(data.currentPeriodEnd).toEqual(new Date(existing.currentPeriodEnd.getTime() + 7 * DAY))
    })

    it("starts a fresh period from now when the stored period already ended", async () => {
        const stale = row({ currentPeriodEnd: new Date(NOW.getTime() - DAY) })
        db.entitlement.findUnique.mockResolvedValueOnce(stale).mockResolvedValueOnce(row())
        db.entitlement.updateMany.mockResolvedValue({ count: 1 })

        await renew(db as never, INPUT, NOW)

        const data = db.entitlement.updateMany.mock.calls[0][0].data
        expect(data.currentPeriodStart).toEqual(NOW)
        expect(data.currentPeriodEnd).toEqual(new Date(NOW.getTime() + 30 * DAY))
    })

    it("starts a fresh period for an EXPIRED row", async () => {
        db.entitlement.findUnique
            .mockResolvedValueOnce(row({ status: "EXPIRED", currentPeriodEnd: new Date(NOW.getTime() - 5 * DAY) }))
            .mockResolvedValueOnce(row({ status: "ACTIVE" }))
        db.entitlement.updateMany.mockResolvedValue({ count: 1 })

        await renew(db as never, INPUT, NOW)

        const data = db.entitlement.updateMany.mock.calls[0][0].data
        expect(data.status).toBe("ACTIVE")
        expect(data.currentPeriodStart).toEqual(NOW)
        expect(data.currentPeriodEnd).toEqual(new Date(NOW.getTime() + 30 * DAY))
    })

    it("re-reads and recomputes when a concurrent change wins the conditional update", async () => {
        const first = row()
        const second = row({ currentPeriodEnd: new Date(first.currentPeriodEnd.getTime() + DAY) })
        db.entitlement.findUnique
            .mockResolvedValueOnce(first)
            .mockResolvedValueOnce(second)
            .mockResolvedValueOnce(second)
        db.entitlement.updateMany
            .mockResolvedValueOnce({ count: 0 }) // کسی هم‌زمان نوشت
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 1 })

        await renew(db as never, INPUT, NOW)

        expect(db.entitlement.updateMany).toHaveBeenCalledTimes(2)
        // تلاش دوم روی state تازه محاسبه شده است (نه state کهنه)
        expect(db.entitlement.updateMany.mock.calls[1][0].where.currentPeriodEnd).toEqual(
            second.currentPeriodEnd,
        )
    })

    it("fails closed when the conditional update never matches (bounded attempts)", async () => {
        db.entitlement.findUnique.mockResolvedValue(row())
        db.entitlement.updateMany.mockResolvedValue({ count: 0 })

        await expect(renew(db as never, INPUT, NOW)).rejects.toBeInstanceOf(EntitlementConflictError)
        expect(db.entitlement.updateMany).toHaveBeenCalledTimes(3)
        expect(db.user.updateMany).not.toHaveBeenCalled()
    })
})

describe("entitlement.service — lazy expiration (§17)", () => {
    let db: Db

    beforeEach(() => {
        db = makeDb()
    })

    it("returns FREE without any write when there is no entitlement row", async () => {
        db.entitlement.findUnique.mockResolvedValue(null)

        await expect(lazyExpire(db as never, USER, NOW)).resolves.toEqual({
            effectivePlan: "FREE",
            entitlement: null,
        })
        expect(db.entitlement.updateMany).not.toHaveBeenCalled()
        expect(db.user.updateMany).not.toHaveBeenCalled()
    })

    it("keeps PRO without any write while the stored period is still valid", async () => {
        const active = row()
        db.entitlement.findUnique.mockResolvedValue(active)

        await expect(lazyExpire(db as never, USER, NOW)).resolves.toEqual({
            effectivePlan: "PRO",
            entitlement: active,
        })
        expect(db.entitlement.updateMany).not.toHaveBeenCalled()
        expect(db.user.updateMany).not.toHaveBeenCalled()
    })

    it("materializes EXPIRED + User.plan = FREE with a conditional update when the period has passed", async () => {
        const expired = row({ currentPeriodEnd: new Date(NOW.getTime() - DAY) })
        db.entitlement.findUnique
            .mockResolvedValueOnce(expired)
            .mockResolvedValueOnce(row({ status: "EXPIRED", currentPeriodEnd: expired.currentPeriodEnd }))
        db.entitlement.updateMany.mockResolvedValue({ count: 1 })

        const result = await lazyExpire(db as never, USER, NOW)

        expect(db.entitlement.updateMany).toHaveBeenCalledWith({
            where: {
                userId: USER,
                status: "ACTIVE",
                currentPeriodStart: expired.currentPeriodStart,
                currentPeriodEnd: expired.currentPeriodEnd,
            },
            data: { status: "EXPIRED" },
        })
        expect(db.user.updateMany).toHaveBeenCalledWith({ where: { id: USER }, data: { plan: "FREE" } })
        expect(result.effectivePlan).toBe("FREE")
        expect(result.entitlement?.status).toBe("EXPIRED")
    })

    it("returns FREE as-is for an already materialized EXPIRED row (no repeat write)", async () => {
        db.entitlement.findUnique.mockResolvedValue(row({ status: "EXPIRED" }))

        await expect(lazyExpire(db as never, USER, NOW)).resolves.toMatchObject({
            effectivePlan: "FREE",
        })
        expect(db.entitlement.updateMany).not.toHaveBeenCalled()
    })

    it("never downgrades a concurrently renewed entitlement (expiration is state-conditional)", async () => {
        const stale = row({ currentPeriodEnd: new Date(NOW.getTime() - DAY) })
        const renewed = row({ currentPeriodEnd: new Date(NOW.getTime() + 30 * DAY) })
        db.entitlement.findUnique.mockResolvedValueOnce(stale).mockResolvedValueOnce(renewed)
        // هم‌زمان تمدید شده → update شرطی روی state قدیمی match نمی‌کند
        db.entitlement.updateMany.mockResolvedValue({ count: 0 })

        const result = await lazyExpire(db as never, USER, NOW)

        expect(result.effectivePlan).toBe("PRO")
        expect(result.entitlement).toEqual(renewed)
        // هیچ FREE کردنی روی تمدید هم‌زمان رخ نمی‌دهد
        expect(db.user.updateMany).not.toHaveBeenCalled()
    })

    it("fails closed with ENTITLEMENT_CONFLICT when every attempt loses the race", async () => {
        db.entitlement.findUnique.mockResolvedValue(
            row({ currentPeriodEnd: new Date(NOW.getTime() - DAY) }),
        )
        db.entitlement.updateMany.mockResolvedValue({ count: 0 })

        await expect(lazyExpire(db as never, USER, NOW)).rejects.toBeInstanceOf(
            EntitlementConflictError,
        )
        expect(db.user.updateMany).not.toHaveBeenCalled()
    })
})

describe("entitlement.service — effective plan resolution", () => {
    it("derives PRO from an active valid entitlement and FREE otherwise (stored state only)", async () => {
        const activeDb = makeDb()
        activeDb.entitlement.findUnique.mockResolvedValue(row())
        await expect(resolveEffectivePlan(activeDb as never, USER, NOW)).resolves.toBe("PRO")

        const freeDb = makeDb()
        freeDb.entitlement.findUnique.mockResolvedValue(null)
        await expect(resolveEffectivePlan(freeDb as never, USER, NOW)).resolves.toBe("FREE")

        const expiredDb = makeDb()
        expiredDb.entitlement.findUnique.mockResolvedValue(
            row({ status: "EXPIRED", currentPeriodEnd: new Date(NOW.getTime() - DAY) }),
        )
        await expect(resolveEffectivePlan(expiredDb as never, USER, NOW)).resolves.toBe("FREE")
    })
})
