import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, type NextResponse } from "next/server"
import bcrypt from "bcryptjs"

/* POST /api/auth/set-new-password — مصرف توکنِ سنجاق‌شده به نشست + نوشتن رمز دائمی. */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    isRateLimited: vi.fn(),
    tokenFindFirst: vi.fn(),
    tokenDeleteMany: vi.fn(),
    userUpdate: vi.fn(),
    createSession: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/rateLimit", () => ({ isRateLimited: mocks.isRateLimited }))
// createSession به JWT_SECRET نیاز دارد که در محیط تست نیست ⇒ mock می‌شود.
// رفتار کوکی واقعی در app/lib/createSession جداگانه سنجیده می‌شود؛ اینجا قراردادِ
// فراخوانی (کاربرِ بدون grant + عمر پیش‌فرض) بررسی می‌شود.
vi.mock("@/app/lib/createSession", () => ({
    createSession: mocks.createSession,
    DEFAULT_SESSION_MAX_AGE_SECONDS: 604800,
}))
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

const USER = {
    id: 7,
    email: "user@example.com",
    mustChangePassword: true,
    // grant نشست: همان توکنی که رمز موقت را احراز کرده
    resetTokenId: "tok_1",
}
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
    // createSession کوکی را روی همان response می‌نویسد و همان را برمی‌گرداند.
    mocks.createSession.mockImplementation((_user: unknown, response: NextResponse) => {
        response.cookies.set("token", "issued-token", { path: "/" })
        return response
    })
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

    it("نشستِ بدون grant (مثلاً نشستی که با رمز دائمی ساخته شده) ⇒ رد", async () => {
        // بدون این گارد، هر نشست معتبرِ کاربر می‌توانست با داشتن یک توکن باز
        // `currentPassword` در change-password را دور بزند.
        mocks.getCurrentUser.mockResolvedValue({ ...USER, resetTokenId: null })

        const res = await POST(req({ newPassword: "aVeryNewPassword1", newPasswordConfirm: "aVeryNewPassword1" }))

        expect(res.status).toBe(400)
        expect((await res.json()).error.code).toBe("PASSWORD_RESET_INVALID")
        // حتی یک کوئری توکن هم نباید زده شود
        expect(mocks.tokenFindFirst).not.toHaveBeenCalled()
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

    it("فقط توکنِ سنجاق‌شده به همین نشست را بررسی می‌کند، نه «آخرین توکن باز»", async () => {
        await POST(req({ newPassword: "aVeryNewPassword1", newPasswordConfirm: "aVeryNewPassword1" }))
        expect(mocks.tokenFindFirst).toHaveBeenCalledWith({
            where: { id: "tok_1", userId: 7, usedAt: null, invalidatedAt: null },
            select: { id: true, expiresAt: true },
        })
    })
})

/**
 * regression: بعد از موفقیت، کاربر نباید با نشستِ کوتاه‌عمرِ «رمز موقت» (≈۱۵ دقیقه)
 * رها شود؛ یک نشستِ عادی باید روی همان response صادر شود.
 */
describe("POST /api/auth/set-new-password — صدور نشست عادی", () => {
    const body = { newPassword: "aVeryNewPassword1", newPasswordConfirm: "aVeryNewPassword1" }

    it("بعد از موفقیت createSession صادر می‌شود و کوکی روی همان response 200 ست می‌شود", async () => {
        const res = await POST(req(body))

        expect(res.status).toBe(200)
        expect(mocks.createSession).toHaveBeenCalledTimes(1)
        // کاربر نباید مجبور به login مجدد شود ⇒ cookie در همان پاسخ موفق.
        expect(res.cookies.get("token")?.value).toBe("issued-token")
    })

    it("نشست تازه هیچ resetTokenId ندارد و mustChangePassword آن false است", async () => {
        await POST(req(body))

        const sessionUser = mocks.createSession.mock.calls[0][0] as {
            id: number
            email: string
            mustChangePassword: boolean
            resetTokenId: string | null
        }

        expect(sessionUser).toEqual({
            id: 7,
            email: "user@example.com",
            mustChangePassword: false,
            resetTokenId: null,
        })
    })

    it("عمر نشست تازه پیش‌فرضِ عادی است، نه عمر باقی‌ماندهٔ توکن", async () => {
        await POST(req(body))

        // الگوی verify-otp: دو آرگومان ⇒ بدون سقف کوتاه‌عمر.
        // سه‌آرگومه‌ای (مثل مسیر رمز موقتِ login که maxAgeSeconds می‌دهد) نشده باشد.
        expect(mocks.createSession.mock.calls[0]).toHaveLength(2)
        expect(mocks.createSession.mock.calls[0][2]).toBeUndefined()
    })

    it("نشست روی همان response پیام موفق ساخته می‌شود و سپس cookie می‌گیرد", async () => {
        const res = await POST(req(body))

        expect(mocks.createSession.mock.calls[0][1]).toBe(res)
        expect(await res.json()).toEqual({ ok: true, message: "رمز عبور با موفقیت تغییر یافت ✅" })
    })

    it("اگر consume توکن شکست بخورد (count=0) نشست عادی صادر نمی‌شود", async () => {
        mocks.tokenDeleteMany.mockResolvedValue({ count: 0 })

        const res = await POST(req(body))

        expect(res.status).toBe(400)
        expect(mocks.createSession).not.toHaveBeenCalled()
        expect(res.cookies.get("token")).toBeUndefined()
    })

    it("اگر نوشتن رمز/فلگ شکست بخورد نشست عادی صادر نمی‌شود", async () => {
        mocks.userUpdate.mockRejectedValue(new Error("db down"))

        const res = await POST(req(body))

        expect(res.status).toBe(500)
        expect(mocks.createSession).not.toHaveBeenCalled()
        expect(res.cookies.get("token")).toBeUndefined()
    })

    it("توکن منقضی ⇒ نه رمز عوض می‌شود، نه نشست صادر می‌شود", async () => {
        mocks.tokenFindFirst.mockResolvedValue({ id: "tok_1", expiresAt: new Date(Date.now() - 1) })

        const res = await POST(req(body))

        expect(res.status).toBe(400)
        expect(mocks.createSession).not.toHaveBeenCalled()
        expect(mocks.userUpdate).not.toHaveBeenCalled()
    })

    it("نشستِ بدون grant ⇒ نشست صادر نمی‌شود", async () => {
        mocks.getCurrentUser.mockResolvedValue({ ...USER, resetTokenId: null })

        const res = await POST(req(body))

        expect(res.status).toBe(400)
        expect(mocks.createSession).not.toHaveBeenCalled()
    })

    it("بدون احراز هویت ⇒ 401 و نشست صادر نمی‌شود", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await POST(req(body))

        expect(res.status).toBe(401)
        expect(mocks.createSession).not.toHaveBeenCalled()
    })

    it("خطای اعتبارسنجی ⇒ نشست صادر نمی‌شود", async () => {
        const res = await POST(req({ newPassword: "aVeryNewPassword1", newPasswordConfirm: "mismatch" }))

        expect(res.status).toBe(400)
        expect(mocks.createSession).not.toHaveBeenCalled()
    })

    it("با rate limit ⇒ 429 و نشست صادر نمی‌شود", async () => {
        mocks.isRateLimited.mockReturnValue(true)

        const res = await POST(req(body))

        expect(res.status).toBe(429)
        expect(mocks.createSession).not.toHaveBeenCalled()
    })
})
