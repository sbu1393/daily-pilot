import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import bcrypt from "bcryptjs"

/* POST /api/auth/forgot-password — صدور رمز موقت + ضد enumeration. */

const mocks = vi.hoisted(() => ({
    verifyTurnstile: vi.fn(),
    isRateLimited: vi.fn(),
    clientIp: vi.fn(),
    userFindUnique: vi.fn(),
    tokenCreate: vi.fn(),
    tokenUpdateMany: vi.fn(),
    tokenDelete: vi.fn(),
    sendEmail: vi.fn(),
}))

vi.mock("@/app/lib/turnstile", () => ({ verifyTurnstile: mocks.verifyTurnstile }))
vi.mock("@/app/lib/rateLimit", () => ({
    isRateLimited: mocks.isRateLimited,
    clientIp: mocks.clientIp,
}))
vi.mock("@/app/lib/email", () => ({
    sendEmail: mocks.sendEmail,
    // مسیر لاگ سمت سرور از همین ماسک استفاده می‌کند؛ نبودنش باعث INTERNAL می‌شد.
    maskEmailForLog: (email: string) => {
        const at = email.indexOf("@")
        return at <= 0 ? "***" : `${email.slice(0, 2)}***${email.slice(at)}`
    },
}))
vi.mock("@/app/lib/getPrisma", () => ({
    getPrisma: () => ({
        user: { findUnique: mocks.userFindUnique },
        passwordResetToken: {
            create: mocks.tokenCreate,
            updateMany: mocks.tokenUpdateMany,
            delete: mocks.tokenDelete,
        },
    }),
}))

import { POST } from "@/app/api/auth/forgot-password/route"

const EMAIL = "user@example.com"

const req = (body: unknown) =>
    new NextRequest("http://localhost/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    })

beforeEach(() => {
    vi.clearAllMocks()
    mocks.verifyTurnstile.mockResolvedValue(true)
    mocks.isRateLimited.mockReturnValue(false)
    mocks.clientIp.mockReturnValue("1.2.3.4")
    mocks.sendEmail.mockResolvedValue({ sent: true, id: "res_1" })
    mocks.tokenCreate.mockResolvedValue({ id: "tok_1" })
    mocks.tokenUpdateMany.mockResolvedValue({ count: 1 })
    mocks.userFindUnique.mockResolvedValue({ id: 7, email: EMAIL })
})

describe("POST /api/auth/forgot-password — ایمیل موجود", () => {
    it("۲۰۰ برمی‌گرداند و رمز موقت را فقط به‌صورت hash ذخیره می‌کند", async () => {
        const res = await POST(req({ email: EMAIL, turnstileToken: "t" }))

        expect(res.status).toBe(200)
        expect(mocks.tokenCreate).toHaveBeenCalledTimes(1)

        const stored = mocks.tokenCreate.mock.calls[0][0].data as { tokenHash: string }
        const emailed = passwordFromEmailHtml()

        // رمزی که ایمیل شده هرگز نباید همان چیزی باشد که در DB ذخیره شده
        expect(stored.tokenHash).not.toBe(emailed)
        expect(stored.tokenHash).toMatch(/^\$2[aby]\$\d{2}\$/)
    })

    it("توکن‌های قبلی همان کاربر را invalidate می‌کند", async () => {
        await POST(req({ email: EMAIL, turnstileToken: "t" }))
        expect(mocks.tokenUpdateMany).toHaveBeenCalledWith({
            where: { userId: 7, usedAt: null, invalidatedAt: null },
            data: { invalidatedAt: expect.any(Date) },
        })
    })

    it("ایمیل شامل همان رمزی است که ذخیره شده و قابل verify است", async () => {
        await POST(req({ email: EMAIL, turnstileToken: "t" }))
        const stored = mocks.tokenCreate.mock.calls[0][0].data.tokenHash as string

        const raw = passwordFromEmailHtml()
        expect(raw).toBeDefined()
        expect(await bcrypt.compare(raw, stored)).toBe(true)
    })

    it("هیچ plaintext رمز موقت در پاسخ HTTP نمی‌رود", async () => {
        const res = await POST(req({ email: EMAIL, turnstileToken: "t" }))
        expect(JSON.stringify(await res.json())).not.toContain(passwordFromEmailHtml())
    })
})

describe("POST /api/auth/forgot-password — ضد enumeration", () => {
    it("برای ایمیل ناموجود، پاسخ باید با ایمیل موجود یکسان باشد", async () => {
        mocks.userFindUnique.mockResolvedValue(null)

        const known = await POST(req({ email: EMAIL, turnstileToken: "t" }))
        const knownBody = await known.json()

        mocks.tokenCreate.mockClear()
        mocks.sendEmail.mockClear()

        const unknown = await POST(req({ email: "nobody@example.com", turnstileToken: "t" }))
        const unknownBody = await unknown.json()

        expect(unknown.status).toBe(known.status)
        expect(unknownBody).toEqual(knownBody)
        // و هیچ توکن/ایمیلی برای ایمیل ناموجود ساخته نشده
        expect(mocks.tokenCreate).not.toHaveBeenCalled()
        expect(mocks.sendEmail).not.toHaveBeenCalled()
    })

    it("پیام پاسخ هیچ اشاره‌ای به وجود حساب نمی‌کند", async () => {
        mocks.userFindUnique.mockResolvedValue(null)
        const res = await POST(req({ email: "nobody@example.com", turnstileToken: "t" }))
        const body = await res.json()
        expect(JSON.stringify(body)).toContain("اگر این ایمیل در سامانه باشد")
        expect(JSON.stringify(body)).not.toMatch(/پیدا نشد|یافت نشد|نامعتبر/)
    })
})

describe("POST /api/auth/forgot-password — captcha و rate limit", () => {
    it("captcha نامعتبر ⇒ 400 و هیچ توکنی ساخته نمی‌شود", async () => {
        mocks.verifyTurnstile.mockResolvedValue(false)

        const res = await POST(req({ email: EMAIL, turnstileToken: "bad" }))

        expect(res.status).toBe(400)
        expect((await res.json()).error.code).toBe("CAPTCHA_FAILED")
        expect(mocks.tokenCreate).not.toHaveBeenCalled()
        expect(mocks.sendEmail).not.toHaveBeenCalled()
    })

    it("rate limit روی IP ⇒ 429 و پیش از هر کار دیتابیسی", async () => {
        mocks.isRateLimited.mockImplementation((key: string) => key.startsWith("forgot:ip:"))

        const res = await POST(req({ email: EMAIL, turnstileToken: "t" }))

        expect(res.status).toBe(429)
        expect(mocks.userFindUnique).not.toHaveBeenCalled()
    })

    it("rate limit روی ایمیل ⇒ پاسخ یکسان می‌دهد (نشت نمی‌کند) و توکن نمی‌سازد", async () => {
        mocks.isRateLimited.mockImplementation((key: string) => key.startsWith("forgot:email:"))

        const res = await POST(req({ email: EMAIL, turnstileToken: "t" }))

        expect(res.status).toBe(200)
        expect(mocks.tokenCreate).not.toHaveBeenCalled()
    })
})

describe("POST /api/auth/forgot-password — اعتبارسنجی و شکست ارسال", () => {
    it("بدنهٔ نامعتبر ⇒ 400", async () => {
        const res = await POST(req({ email: "not-an-email", turnstileToken: "t" }))
        expect(res.status).toBe(400)
        expect((await res.json()).error.code).toBe("VALIDATION_ERROR")
    })

    it("شکست Resend ⇒ 503 و توکن بی‌مصرف پاک می‌شود (پاسخ موفق دروغین نمی‌دهد)", async () => {
        mocks.sendEmail.mockResolvedValue({ sent: false, error: "boom" })

        const res = await POST(req({ email: EMAIL, turnstileToken: "t" }))

        expect(res.status).toBe(503)
        expect((await res.json()).error.code).toBe("EMAIL_DELIVERY_FAILED")
        expect(mocks.tokenDelete).toHaveBeenCalledWith({ where: { id: "tok_1" } })
    })
})

/** استخراج رمز موقت از HTML ایمیل تا ثابت کنیم ذخیره‌سازی plaintext نیست. */
function passwordFromEmailHtml(): string {
    const html = mocks.sendEmail.mock.calls[0]?.[2] as string | undefined
    return /letter-spacing:1px">([^<]+)</.exec(html ?? "")?.[1] ?? ""
}
