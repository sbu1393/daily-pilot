import { beforeEach, describe, expect, it, vi } from "vitest"

/* userData.service — خروجی امن داده‌ها + حذف حساب با تأیید رمز. */

const { prismaMock, getPrismaMock, compareMock } = vi.hoisted(() => {
    const prismaMock = {
        user: {
            findUnique: vi.fn(),
            delete: vi.fn(),
        },
        errorLog: { deleteMany: vi.fn() },
        otpCode: { deleteMany: vi.fn() },
        $transaction: vi.fn(),
    }
    return {
        prismaMock,
        getPrismaMock: vi.fn(() => prismaMock),
        compareMock: vi.fn(),
    }
})

vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: getPrismaMock }))
vi.mock("bcryptjs", () => ({
    default: {
        compare: (...args: unknown[]) => compareMock(...args),
    },
}))

import { buildUserDataExport, deleteUserAccount } from "./userData.service"
import { UserNotFoundError, WrongPasswordError } from "./errors"

const EXPORT_ROW = {
    id: 7,
    username: "ali",
    email: "ali@example.com",
    firstName: "علی",
    lastName: null,
    birthDate: null,
    phone: null,
    image: null,
    timezone: "Asia/Tehran",
    locale: "fa",
    calendar: "JALALI",
    plan: "FREE",
    role: "USER",
    reminderEnabled: true,
    reminderTime: "08:30",
    tasks: [{ id: 1, title: "کار" }],
    dailyPlans: [{ id: 2, dayKey: "2026-01-01" }],
    entitlement: null,
}

beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.user.findUnique.mockResolvedValue(EXPORT_ROW)
    prismaMock.user.delete.mockResolvedValue({})
    prismaMock.errorLog.deleteMany.mockResolvedValue({ count: 1 })
    prismaMock.otpCode.deleteMany.mockResolvedValue({ count: 1 })
    prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prismaMock))
    compareMock.mockResolvedValue(true)
})

describe("buildUserDataExport", () => {
    it("پروفایل، تنظیمات، تسک‌ها و برنامه‌های روزانه را برمی‌گرداند", async () => {
        const data = await buildUserDataExport(7)

        expect(data).toMatchObject({
            meta: { app: "روزساز", formatVersion: 1 },
            profile: { id: 7, username: "ali", timezone: "Asia/Tehran" },
            settings: { reminderEnabled: true, reminderTime: "08:30" },
            tasks: EXPORT_ROW.tasks,
            dailyPlans: EXPORT_ROW.dailyPlans,
            entitlement: null,
        })
        expect(data.meta.exportedAt).toEqual(expect.any(String))
    })

    it("هش رمز و فیلدهای داخلی/اعتبارنامه هرگز select نمی‌شوند", async () => {
        await buildUserDataExport(7)

        const select = prismaMock.user.findUnique.mock.calls[0][0].select as Record<string, unknown>
        expect(select).not.toHaveProperty("password")
        expect(select).not.toHaveProperty("mustChangePassword")
        expect(select).not.toHaveProperty("pushSubscriptions")
        expect(select).not.toHaveProperty("passwordResetTokens")
    })

    it("کاربر ناموجود → UserNotFoundError", async () => {
        prismaMock.user.findUnique.mockResolvedValue(null)

        await expect(buildUserDataExport(999)).rejects.toBeInstanceOf(UserNotFoundError)
    })
})

describe("deleteUserAccount", () => {
    beforeEach(() => {
        prismaMock.user.findUnique.mockResolvedValue({
            password: "hashed-password",
            email: "ali@example.com",
        })
    })

    it("رمز اشتباه → WrongPasswordError و هیچ حذفی انجام نمی‌شود", async () => {
        compareMock.mockResolvedValue(false)

        await expect(deleteUserAccount(7, "wrong-password")).rejects.toBeInstanceOf(WrongPasswordError)

        expect(prismaMock.$transaction).not.toHaveBeenCalled()
        expect(prismaMock.user.delete).not.toHaveBeenCalled()
    })

    it("کاربر ناموجود → UserNotFoundError", async () => {
        prismaMock.user.findUnique.mockResolvedValue(null)

        await expect(deleteUserAccount(999, "any-password")).rejects.toBeInstanceOf(UserNotFoundError)
        expect(compareMock).not.toHaveBeenCalled()
    })

    it("رمز درست → لاگ‌ها/OTP پاک و کاربر حذف می‌شود (Cascade بقیه را می‌برد)", async () => {
        await deleteUserAccount(7, "correct-password")

        expect(compareMock).toHaveBeenCalledWith("correct-password", "hashed-password")
        expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
        expect(prismaMock.errorLog.deleteMany).toHaveBeenCalledWith({ where: { userId: 7 } })
        expect(prismaMock.otpCode.deleteMany).toHaveBeenCalledWith({ where: { email: "ali@example.com" } })
        expect(prismaMock.user.delete).toHaveBeenCalledWith({ where: { id: 7 } })
    })

    it("خطای وسط تراکنش به بیرون منتقل می‌شود (rollback بر عهده Prisma)", async () => {
        prismaMock.user.delete.mockRejectedValue(new Error("db down"))

        await expect(deleteUserAccount(7, "correct-password")).rejects.toThrow("db down")
    })
})
