import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* M1 (audit) — getCurrentUser: تفکیک خطای انتظاری (توکن نامعتبر/منقضی)  */
/* از خطای غیرانتظاری (دیتابیس/زیرساخت).                                */
/* فاز ۵ — گام ۱۳: پلن برگشتی resolve سرور-محور است (lazy expiration +   */
/* entitlement) و آینه‌ی کهنه‌ی User.plan هرگز به مصرف‌کننده نمی‌رسد.     */
/* next/headers و getPrisma mock می‌شوند؛ jsonwebtoken واقعی است تا      */
/* رفتار واقعی verify (منقضی/امضای اشتباه) تست شود.                    */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    cookieToken: vi.fn(),
    findUnique: vi.fn(),
    userUpdateMany: vi.fn(),
    entFindUnique: vi.fn(),
    entUpdateMany: vi.fn(),
}))

vi.mock("next/headers", () => ({
    cookies: async () => ({ get: (name: string) => mocks.cookieToken(name) }),
}))

vi.mock("./getPrisma", () => ({
    getPrisma: () => ({
        user: { findUnique: mocks.findUnique, updateMany: mocks.userUpdateMany },
        entitlement: { findUnique: mocks.entFindUnique, updateMany: mocks.entUpdateMany },
    }),
}))

import jwt from "jsonwebtoken"
import { EntitlementConflictError } from "./services/errors"
import { getCurrentUser } from "./getCurrentUser"

const SECRET = "unit-test-secret"
const OTHER_SECRET = "another-secret"
const USER = {
    id: 1,
    username: "test",
    email: "test@example.com",
    timezone: "Asia/Tehran",
    role: "USER",
}

const cookieWith = (token: string) => ({ value: token })

/* Phase 5 — Step 13: ردیف entitlement که lazyExpire/effective plan رویش تصمیم می‌گیرد. */
const ENTITLEMENT = {
    id: "ent_1",
    userId: 1,
    provider: "ZARINPAL",
    status: "ACTIVE",
    planCode: "PRO",
    // دوره‌ی فعال نسبت به «حالا» — تا تست وابسته به تاریخ واقعی اجرا نشود
    currentPeriodStart: new Date(Date.now() - 24 * 60 * 60 * 1000),
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
}

describe("getCurrentUser (M1 — auth vs infrastructure failures)", () => {
    const originalSecret = process.env.JWT_SECRET

    beforeEach(() => {
        vi.clearAllMocks()
        process.env.JWT_SECRET = SECRET
        mocks.findUnique.mockResolvedValue(USER)
        // بدون ردیف entitlement → effective plan = FREE (سند §16/§17)
        mocks.entFindUnique.mockResolvedValue(null)
        mocks.entUpdateMany.mockResolvedValue({ count: 1 })
        mocks.userUpdateMany.mockResolvedValue({ count: 1 })
        mocks.cookieToken.mockReturnValue(
            cookieWith(jwt.sign({ id: 1, email: "test@example.com" }, SECRET)),
        )
    })

    afterEach(() => {
        if (originalSecret === undefined) delete process.env.JWT_SECRET
        else process.env.JWT_SECRET = originalSecret
        vi.restoreAllMocks()
    })

    it("returns the session user for a valid token", async () => {
        await expect(getCurrentUser()).resolves.toEqual({ ...USER, plan: "FREE" })

        expect(mocks.cookieToken).toHaveBeenCalledWith("token")
        expect(mocks.findUnique).toHaveBeenCalledWith({
            where: { id: 1 },
            select: expect.objectContaining({
                id: true,
                username: true,
                email: true,
                timezone: true,
                role: true,
            }),
        })
    })

    /* ---------------- Phase 5 — Step 13: effective plan ---------------- */

    it("never reads the stale User.plan mirror — effective plan comes from entitlement state", async () => {
        await getCurrentUser()

        // آینه‌ی User.plan حتی از DB هم خوانده نمی‌شود؛ پس مقدار کهنه‌اش به مصرف‌کننده نمی‌رسد
        expect(mocks.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ select: expect.not.objectContaining({ plan: true }) }),
        )
    })

    it("exposes PRO when the entitlement row is ACTIVE and still valid (no writes)", async () => {
        mocks.entFindUnique.mockResolvedValue(ENTITLEMENT)

        await expect(getCurrentUser()).resolves.toMatchObject({ id: 1, plan: "PRO" })

        expect(mocks.entUpdateMany).not.toHaveBeenCalled()
        expect(mocks.userUpdateMany).not.toHaveBeenCalled()
    })

    it("resolves to FREE and materializes expiration when the period has ended", async () => {
        mocks.entFindUnique
            .mockResolvedValueOnce({ ...ENTITLEMENT, currentPeriodEnd: new Date("2026-01-01T00:00:00.000Z") })
            .mockResolvedValueOnce({ ...ENTITLEMENT, status: "EXPIRED", currentPeriodEnd: new Date("2026-01-01T00:00:00.000Z") })

        await expect(getCurrentUser()).resolves.toMatchObject({ plan: "FREE" })

        // transition شرطی و race-safe (فقط اگر همان period هنوز برقرار باشد) + آینه‌ی سروری plan
        expect(mocks.entUpdateMany).toHaveBeenCalledWith({
            where: {
                userId: 1,
                status: "ACTIVE",
                currentPeriodStart: ENTITLEMENT.currentPeriodStart,
                currentPeriodEnd: new Date("2026-01-01T00:00:00.000Z"),
            },
            data: { status: "EXPIRED" },
        })
        expect(mocks.userUpdateMany).toHaveBeenCalledWith({ where: { id: 1 }, data: { plan: "FREE" } })
    })

    it("does not downgrade a concurrently renewed entitlement (conflict instead of stale PRO→FREE)", async () => {
        mocks.entFindUnique.mockResolvedValue({ ...ENTITLEMENT, currentPeriodEnd: new Date("2026-01-01T00:00:00.000Z") })
        mocks.entUpdateMany.mockResolvedValue({ count: 0 })

        await expect(getCurrentUser()).rejects.toBeInstanceOf(EntitlementConflictError)

        // هیچ FREE کردن کاربر روی تمدید هم‌زمان رخ نمی‌دهد
        expect(mocks.userUpdateMany).not.toHaveBeenCalled()
    })

    it("returns role from the DB (Phase 4 — Step 3)", async () => {
        await expect(getCurrentUser()).resolves.toMatchObject({ role: "USER" })

        // DB lookup per request — role is only ever sourced from the DB select
        expect(mocks.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({
                select: expect.objectContaining({ role: true }),
            }),
        )
    })

    it("returns role=ADMIN when the DB row is ADMIN (Phase 4 — Step 3)", async () => {
        mocks.findUnique.mockResolvedValue({ ...USER, role: "ADMIN" })

        await expect(getCurrentUser()).resolves.toMatchObject({ role: "ADMIN" })
        // role فقط از DB و مستقل از مسیر effective plan
        expect(mocks.entFindUnique).toHaveBeenCalledWith({ where: { userId: 1 }, select: expect.any(Object) })
    })

    it("reflects a DB role change on the next request — no role cache (Phase 4 — Step 3)", async () => {
        mocks.findUnique.mockResolvedValue({ ...USER, role: "USER" })
        await expect(getCurrentUser()).resolves.toMatchObject({ role: "USER" })

        // همان session/JWT، بدون هیچ cache — role فقط از DB هر بار خوانده می‌شود
        mocks.findUnique.mockResolvedValue({ ...USER, role: "ADMIN" })
        await expect(getCurrentUser()).resolves.toMatchObject({ role: "ADMIN" })
        expect(mocks.findUnique).toHaveBeenCalledTimes(2)
    })

    it("never sources role from the JWT payload (JWT stays exactly {id, email})", async () => {
        // توکن حاوی یک claim غیرمجاز role است — باید کاملاً نادیده گرفته شود؛
        // مقدار برگشتی فقط از DB می‌آید
        mocks.cookieToken.mockReturnValue(
            cookieWith(jwt.sign({ id: 1, email: "test@example.com", role: "ADMIN" }, SECRET)),
        )
        mocks.findUnique.mockResolvedValue({ ...USER, role: "USER" })

        await expect(getCurrentUser()).resolves.toMatchObject({ role: "USER" })
    })

    it("returns null (no DB call) when the session cookie is absent", async () => {
        mocks.cookieToken.mockReturnValue(undefined)

        await expect(getCurrentUser()).resolves.toBeNull()
        expect(mocks.findUnique).not.toHaveBeenCalled()
    })

    it("returns null (never throws) for an expired token — expected auth failure", async () => {
        mocks.cookieToken.mockReturnValue(
            cookieWith(jwt.sign({ id: 1, email: "test@example.com" }, SECRET, { expiresIn: -10 })),
        )

        await expect(getCurrentUser()).resolves.toBeNull()
        expect(mocks.findUnique).not.toHaveBeenCalled()
    })

    it("returns null (never throws) for a token signed with another secret", async () => {
        mocks.cookieToken.mockReturnValue(
            cookieWith(jwt.sign({ id: 1, email: "test@example.com" }, OTHER_SECRET)),
        )

        await expect(getCurrentUser()).resolves.toBeNull()
        expect(mocks.findUnique).not.toHaveBeenCalled()
    })

    it("logs with context and rethrows on a database failure (M1 — no misleading 401)", async () => {
        const dbError = new Error("connection pool exhausted")
        mocks.findUnique.mockRejectedValue(dbError)
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

        await expect(getCurrentUser()).rejects.toThrow("connection pool exhausted")

        expect(errorSpy).toHaveBeenCalledWith("getCurrentUser: user lookup failed", {
            userId: 1,
            error: dbError,
        })
    })

    it("still throws when JWT_SECRET is missing (unchanged contract)", async () => {
        delete process.env.JWT_SECRET

        await expect(getCurrentUser()).rejects.toThrow("JWT_SECRET is not defined")
        expect(mocks.findUnique).not.toHaveBeenCalled()
    })
})
