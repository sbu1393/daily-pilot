import { beforeEach, describe, expect, it, vi } from "vitest"

/* changePassword — تضمین «بعد از تغییر رمز، رمز موقت دیگر کار نمی‌کند». */

const { prismaMock, getPrismaMock } = vi.hoisted(() => {
    const prismaMock = {
        user: {
            findUnique: vi.fn(),
            update: vi.fn(),
        },
        passwordResetToken: {
            updateMany: vi.fn(),
        },
    }
    return { prismaMock, getPrismaMock: vi.fn(() => prismaMock) }
})

vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: getPrismaMock }))

const compareMock = vi.fn()
vi.mock("bcryptjs", () => ({
    default: {
        hash: vi.fn(async () => "hashed-new-password"),
        compare: (...args: unknown[]) => compareMock(...args),
    },
}))

import { changePassword } from "./auth.service"

beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.user.findUnique.mockResolvedValue({ password: "hashed-old-password" })
    prismaMock.user.update.mockResolvedValue({})
    prismaMock.passwordResetToken.updateMany.mockResolvedValue({ count: 1 })
    compareMock.mockResolvedValue(true)
})

describe("changePassword — باطل‌سازی رمز موقت", () => {
    it("بعد از تغییر موفق رمز، توکن‌های باز رمز موقت را invalidate می‌کند", async () => {
        await changePassword(7, "current-password", "aBrandNewPassword1")

        expect(prismaMock.passwordResetToken.updateMany).toHaveBeenCalledWith({
            where: { userId: 7, usedAt: null, invalidatedAt: null },
            data: { invalidatedAt: expect.any(Date) },
        })
    })

    it("ترتیب درست است: اول رمز نوشته می‌شود، بعد توکن باطل می‌شود", async () => {
        const order: string[] = []
        prismaMock.user.update.mockImplementation(async () => {
            order.push("update-password")
            return {}
        })
        prismaMock.passwordResetToken.updateMany.mockImplementation(async () => {
            order.push("invalidate-token")
            return { count: 1 }
        })

        await changePassword(7, "current-password", "aBrandNewPassword1")

        expect(order).toEqual(["update-password", "invalidate-token"])
    })

    it("اگر رمز فعلی غلط باشد، نه رمز نوشته می‌شود نه توکنی باطل", async () => {
        compareMock.mockResolvedValue(false)

        await expect(
            changePassword(7, "wrong-password", "aBrandNewPassword1"),
        ).rejects.toMatchObject({ code: "WRONG_PASSWORD" })

        expect(prismaMock.user.update).not.toHaveBeenCalled()
        expect(prismaMock.passwordResetToken.updateMany).not.toHaveBeenCalled()
    })

    it("اگر رمز جدید با قبلی یکی باشد، هیچ تغییری (و هیچ باطل‌سازی‌ای) انجام نمی‌شود", async () => {
        await expect(changePassword(7, "same-password", "same-password")).rejects.toMatchObject({
            code: "SAME_PASSWORD",
        })

        expect(prismaMock.user.update).not.toHaveBeenCalled()
        expect(prismaMock.passwordResetToken.updateMany).not.toHaveBeenCalled()
    })
})
