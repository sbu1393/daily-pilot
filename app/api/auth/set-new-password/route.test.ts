import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import bcrypt from "bcryptjs"

/* POST /api/auth/set-new-password — مصرف توکن + نوشتن رمز دائمی. */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    isRateLimited: vi.fn(),
    tokenFindFirst: vi.fn(),
    tokenDeleteMany: vi.fn(),
    userUpdate: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/rateLimit", () => ({ isRateLimited: mocks.isRateLimited }))
vi.mock("@/app/lib/getPrisma", () => ({
    getPrisma: () => ({
        passwordResetToken: {
            findFirst: mocks.tokenFindFirst,
            deleteMany: mocks.tokenDeleteMany,
        },
        user: { update: mocks.userUpdate },
        // $transaction همان callback را با یک tx هم‌شکل صدا می‌زند.
        $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
            cb({
                passwordResetToken: {
                    findFirst: mocks.tokenFindFirst,
                    deleteMany: mocks.tokenDeleteMany,
                },
                user: { update: mocks.userUpdate },
            }),
    }),
}))

import { POST } from "@/app/api/auth/set-new-password/route"

const USER = { id: 7, email: "user@example.com", mustChangePassword: true }
const FUTURE = new Date(Date.now() + 60_000).toISOString()

const req = (body: unknown) =>
    new NextRequest("http://localhost/api/auth/set-new-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    })

beforeEach(() => {
    vi.clearAllMocks()
    mocks.getCurrentUser.mockResolvedValue(USER)
    mocks.isRateLimited.mockReturnValue(false)
    mocks.tokenFindFirst.mockResolvedValue({ id: "tok_1", expiresAt: new Date(FUTURE) })
    mocks.tokenDeleteMany.mockResolvedValue({ count: 1 })
    mocks.userUpdate.mockResolvedValue({})
})

describe("POST /api/auth/set-new-password — احراز هویت", () => {
    it("بدون نشست ⇒ 401 و هیچ کاری انجام نمی‌شود", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await POST(req({ newPassword: "aVeryNewPassword1", newPasswordConfirm: "aVeryNewPassword1" }))

        expect(res.status).toBe(401)
        expect(mocks.userUpdate).not.toHaveBeenCalled()
    })

    it("در وضعیت رمز موقت کار می‌کند (گاردِ requireVerifiedUser را صدا نمی‌زند)", async () => {
        // همین تست یعنی enforcement مسیر تعیین رمز را مسدود نکرده است.
        const res = await POST(req({ newPassword: "aVeryNewPassword1", newPasswordConfirm: "aVeryNewPassword1" }))
        expect(res.status).toBe(200)
    })

    it("rate limit کاربر ⇒ 429", async () => {
        mocks.isRateLimited.mockReturnValue(true)
        const res = await POST(req({ newPassword: "aVeryNewPassword1", newPasswordConfirm: "aVeryNewPassword1" }))
        expect(res.status).toBe(429)
        expect(mocks.userUpdate).not.toHaveBeenCalled()
    })
})

describe("POST /api/auth/set-new-password — اعتبارسنجی", () => {
    it("عدم تطابق رمز و تکرار ⇒ 400", async () => {
        const res = await POST(req({ newPassword: "aVeryNewPassword1", newPasswordConfirm: "somethingElse" }))
        expect(res.status).toBe(400)
        expect(mocks.userUpdate).not.toHaveBeenCalled()
    })

    it("رمز کوتاه‌تر از ۸ کاراکتر ⇒ 400", async () => {
        const res = await POST(req({ newPassword: "short", newPasswordConfirm: "short" }))
        expect(res.status).toBe(400)
    })

    it("کلاینت اجازه ندارد currentPassword بفرستد (strict)", async () => {
        const res = await POST(
            req({ newPassword: "aVeryNewPassword1", newPasswordConfirm: "aVeryNewPassword1", currentPassword: "temp" }),
        )
        expect(res.status).toBe(400)
        expect(mocks.userUpdate).not.toHaveBeenCalled()
    })
})

describe("POST /api/auth/set-new-password — lifecycle توکن", () => {
    it("موفق: توکن حذف، رمز هش‌شده نوشته و فلگ صفر می‌شود", async () => {
        const res = await POST(req({ newPassword: "aVeryNewPassword1", newPasswordConfirm: "aVeryNewPassword1" }))

        expect(res.status).toBe(200)
        expect(mocks.tokenDeleteMany).toHaveBeenCalledWith({ where: { id: "tok_1", userId: 7 } })

        const update = mocks.userUpdate.mock.calls[0][0]
        expect(update.data.mustChangePassword).toBe(false)
        expect(update.data.password).not.toBe("aVeryNewPassword1")
        expect(await bcrypt.compare("aVeryNewPassword1", update.data.password)).toBe(true)
    })

    it("توکن منقضی ⇒ رد و هیچ رمزی نوشته نمی‌شود", async () => {
        mocks.tokenFindFirst.mockResolvedValue({
            id: "tok_1",
            expiresAt: new Date(Date.now() - 1),
        })

        const res = await POST(req({ newPassword: "aVeryNewPassword1", newPasswordConfirm: "aVeryNewPassword1" }))

        expect(res.status).toBe(400)
        expect((await res.json()).error.code).toBe("PASSWORD_RESET_INVALID")
        expect(mocks.userUpdate).not.toHaveBeenCalled()
    })

    it("نبودِ توکن فعال ⇒ رد", async () => {
        mocks.tokenFindFirst.mockResolvedValue(null)

        const res = await POST(req({ newPassword: "aVeryNewPassword1", newPasswordConfirm: "aVeryNewPassword1" }))

        expect(res.status).toBe(400)
        expect(mocks.userUpdate).not.toHaveBeenCalled()
    })

    it("مصرف دوبارهٔ همان توکن (replay) ⇒ رد و رمز تغییر نمی‌کند", async () => {
        // deleteMany با count=0 یعنی این توکن قبلاً مصرف شده (race یا replay).
        mocks.tokenDeleteMany.mockResolvedValue({ count: 0 })

        const res = await POST(req({ newPassword: "aVeryNewPassword1", newPasswordConfirm: "aVeryNewPassword1" }))

        expect(res.status).toBe(400)
        expect((await res.json()).error.code).toBe("PASSWORD_RESET_INVALID")
        expect(mocks.userUpdate).not.toHaveBeenCalled()
    })

    it("فقط جدیدترین توکن باز کاربر را بررسی می‌کند", async () => {
        await POST(req({ newPassword: "aVeryNewPassword1", newPasswordConfirm: "aVeryNewPassword1" }))
        expect(mocks.tokenFindFirst).toHaveBeenCalledWith({
            where: { userId: 7, usedAt: null, invalidatedAt: null },
            orderBy: { createdAt: "desc" },
            select: { id: true, expiresAt: true },
        })
    })
})
