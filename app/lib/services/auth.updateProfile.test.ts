import { beforeEach, describe, expect, it, vi } from "vitest"

/* updateProfile — قرارداد PATCH جزئی: فقط کلیدهای حاضر نوشته می‌شوند. */

const { prismaMock, getPrismaMock } = vi.hoisted(() => {
    const prismaMock = {
        user: {
            findFirst: vi.fn(),
            update: vi.fn(),
        },
    }
    return { prismaMock, getPrismaMock: vi.fn(() => prismaMock) }
})

vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: getPrismaMock }))

import { updateProfile } from "./auth.service"

beforeEach(() => {
    vi.clearAllMocks()
    prismaMock.user.findFirst.mockResolvedValue(null)
    prismaMock.user.update.mockResolvedValue({ id: 7 })
})

const lastData = () =>
    (prismaMock.user.update.mock.calls[0][0] as { data: Record<string, unknown> }).data

describe("updateProfile — partial update", () => {
    it("فقط کلیدی که در بدنه آمده در data نوشته می‌شود", async () => {
        await updateProfile(7, "current-name", { firstName: "علی" })

        expect(lastData()).toEqual({ firstName: "علی" })
        // فیلدهای غایب هرگز null نمی‌شوند
        expect(lastData()).not.toHaveProperty("lastName")
        expect(lastData()).not.toHaveProperty("phone")
        expect(lastData()).not.toHaveProperty("birthDate")
        expect(lastData()).not.toHaveProperty("username")
    })

    it("null و رشتهٔ خالی یعنی پاک کردن صریح", async () => {
        await updateProfile(7, "current-name", { firstName: null, phone: "   " })

        expect(lastData()).toEqual({ firstName: null, phone: null })
    })

    it("تاریخ تولد معتبر به Date تبدیل می‌شود", async () => {
        await updateProfile(7, "current-name", { birthDate: "2026-01-02" })

        expect(lastData().birthDate).toEqual(new Date("2026-01-02"))
    })

    it("بدنهٔ خالی هیچ فیلدی را بازنویسی نمی‌کند", async () => {
        await updateProfile(7, "current-name", {})

        expect(lastData()).toEqual({})
        expect(prismaMock.user.findFirst).not.toHaveBeenCalled()
    })

    it("نام کاربریِ بدون تغییر، بدون جست‌وجوی تکرارپذیری ذخیره می‌شود", async () => {
        await updateProfile(7, "current-name", { username: "current-name" })

        expect(prismaMock.user.findFirst).not.toHaveBeenCalled()
        expect(lastData()).toEqual({ username: "current-name" })
    })

    it("نام کاربریِ تکراری → USERNAME_TAKEN و بدون نوشتن", async () => {
        prismaMock.user.findFirst.mockResolvedValue({ id: 9 })

        await expect(
            updateProfile(7, "current-name", { username: "taken" }),
        ).rejects.toMatchObject({ code: "USERNAME_TAKEN" })

        expect(prismaMock.user.update).not.toHaveBeenCalled()
    })
})
