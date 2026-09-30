import { beforeEach, describe, expect, it, vi } from "vitest"

/* گارد مرکزی رمز موقت — اثبات اینکه مسیر authenticated در این وضعیت بسته است. */

const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn() }))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))

import {
    requireVerifiedUser,
    PASSWORD_CHANGE_REQUIRED_CODE,
} from "@/app/lib/requireVerifiedUser"
import { ServiceError } from "@/app/lib/services/errors"

const USER = { id: 7, email: "user@example.com", role: "USER", mustChangePassword: false }

beforeEach(() => {
    vi.clearAllMocks()
})

describe("requireVerifiedUser", () => {
    it("بدون نشست ⇒ 401 UNAUTHORIZED", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        await expect(requireVerifiedUser()).rejects.toMatchObject({
            status: 401,
            code: "UNAUTHORIZED",
        })
    })

    it("وضعیت عادی ⇒ کاربر برمی‌گردد (بدون تغییر رفتار)", async () => {
        mocks.getCurrentUser.mockResolvedValue(USER)
        await expect(requireVerifiedUser()).resolves.toMatchObject({ id: 7 })
    })

    it("mustChangePassword ⇒ 403 PASSWORD_CHANGE_REQUIRED  (جلوگیری از bypass با API مستقیم)", async () => {
        mocks.getCurrentUser.mockResolvedValue({ ...USER, mustChangePassword: true })

        await expect(requireVerifiedUser()).rejects.toMatchObject({
            status: 403,
            code: PASSWORD_CHANGE_REQUIRED_CODE,
        })
    })

    it("خطا یک ServiceError است تا envelope استانداردِ پروژه را بگیرد", async () => {
        mocks.getCurrentUser.mockResolvedValue({ ...USER, mustChangePassword: true })

        await expect(requireVerifiedUser()).rejects.toBeInstanceOf(ServiceError)
    })

    it("پیام خطا به کاربر می‌گوید چه باید بکند، نه اینکه «ممنوع» است", async () => {
        mocks.getCurrentUser.mockResolvedValue({ ...USER, mustChangePassword: true })

        await expect(requireVerifiedUser()).rejects.toThrow(/رمز عبور جدید/)
    })

    it("فلگ فقط از DB خوانده می‌شود (JWT هیچ نقشی ندارد)", async () => {
        mocks.getCurrentUser.mockResolvedValue(USER)

        await requireVerifiedUser()

        // یعنی تصمیم از خروجی getCurrentUser (که از DB می‌خواند) گرفته شده،
        // نه از کوکی/کلاینت. گارد خودش هیچ منبع دیگری را نمی‌خواند.
        expect(mocks.getCurrentUser).toHaveBeenCalledTimes(1)
    })
})
