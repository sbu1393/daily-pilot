import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* E1 — تست‌های لایه سرویس auth.service (بدون DB زنده):                 */
/* مسابقه‌ی ثبت‌نام همزمان روی email @unique → Prisma P2002 باید        */
/* در مرز خطا (§9.11) به 409 CONFLICT تبدیل شود، نه 500 خام.           */
/* Prisma کاملاً mock است؛ تشخیص کد Prisma فقط با duck-typing.          */
/* ------------------------------------------------------------------ */

const { prismaMock, getPrismaMock, bcryptHash, bcryptCompare } = vi.hoisted(() => {
    const prismaMock = {
        user: {
            findUnique: vi.fn(),
            create: vi.fn(),
        },
    }
    return {
        prismaMock,
        getPrismaMock: vi.fn(() => prismaMock),
        bcryptHash: vi.fn(async () => "hashed-password"),
        bcryptCompare: vi.fn(async () => false),
    }
})

vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: getPrismaMock }))

vi.mock("bcryptjs", () => ({ default: { hash: bcryptHash, compare: bcryptCompare } }))

import { EmailTakenError, InvalidCredentialsError, ServiceError, UsernameTakenError } from "./errors"
import { authenticate, registerUser } from "./auth.service"

const INPUT = { username: "testuser", email: "test@example.com", password: "secret123" }

describe("registerUser (E1 — uniqueness race)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it("creates the user when the pre-check finds no duplicate (happy path unchanged)", async () => {
        prismaMock.user.findUnique.mockResolvedValue(null)
        const created = { id: 7, username: "testuser", email: "test@example.com" }
        prismaMock.user.create.mockResolvedValue(created)

        await expect(registerUser(INPUT)).resolves.toEqual(created)
        expect(prismaMock.user.create).toHaveBeenCalledWith({
            data: {
                username: "testuser",
                email: "test@example.com",
                password: "hashed-password",
                // لنگر دورهٔ سهمیه از لحظهٔ ثبت‌نام (مسیر A). مقدار `expect.any(Date)`
                // چون زمان دقیق در اختیار تست نیست.
                quotaAnchorAt: expect.any(Date),
            },
        })
    })

    it("throws UsernameTakenError when the pre-check finds a duplicate username", async () => {
        prismaMock.user.findUnique
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 8 })

        await expect(registerUser(INPUT)).rejects.toBeInstanceOf(UsernameTakenError)
        expect(prismaMock.user.create).not.toHaveBeenCalled()
    })
    it("throws EmailTakenError when the pre-check finds a duplicate email", async () => {
        prismaMock.user.findUnique.mockResolvedValue({ id: 3, email: "test@example.com" })

        await expect(registerUser(INPUT)).rejects.toBeInstanceOf(EmailTakenError)
        expect(prismaMock.user.create).not.toHaveBeenCalled()
    })

    it("converts a concurrent-registration P2002 race into the same 409 CONFLICT ServiceError", async () => {
        // پیش‌چک پیدا نمی‌کند ولی create بین دو درخواست همزمان روی @unique email شکست می‌خورد
        prismaMock.user.findUnique.mockResolvedValue(null)
        prismaMock.user.create.mockRejectedValue({ code: "P2002", meta: { target: ["email"] } })

        const thrown = await registerUser(INPUT).catch((e: unknown) => e)

        expect(thrown).toBeInstanceOf(ServiceError)
        expect((thrown as ServiceError).status).toBe(409)
        expect((thrown as ServiceError).code).toBe("CONFLICT")
    })

    it("rethrows unknown infrastructure errors untouched so the generic 500 path stays intact", async () => {
        prismaMock.user.findUnique.mockResolvedValue(null)
        prismaMock.user.create.mockRejectedValue({ code: "P1001", message: "db unreachable" })

        await expect(registerUser(INPUT)).rejects.toMatchObject({ code: "P1001" })
    })
})

/* ------------------------------------------------------------------ */
/* authenticate — شاخهٔ رمز موقت (پایهٔ سشنِ محدود در route لاگین)      */
/* ------------------------------------------------------------------ */

describe("authenticate — رمز موقت", () => {
    const USER = { id: 7, email: "test@example.com", password: "permanent-hash" }
    // باید آینده باشد وگرنه توکن منقضی تلقی می‌شود (TTL رمز موقت ۱۵ دقیقه است).
    const EXPIRES_AT = new Date(Date.now() + 15 * 60 * 1000)

    function makeClient(overrides: Record<string, unknown> = {}) {
        return {
            user: {
                findUnique: vi.fn(async () => USER),
                update: vi.fn(async () => ({})),
            },
            passwordResetToken: {
                findFirst: vi.fn(async () => ({
                    id: "tok_1",
                    tokenHash: "temp-hash",
                    attempts: 0,
                    maxAttempts: 5,
                    expiresAt: EXPIRES_AT,
                    usedAt: null,
                    invalidatedAt: null,
                })),
                updateMany: vi.fn(async () => ({ count: 1 })),
                deleteMany: vi.fn(async () => ({ count: 1 })),
            },
            ...overrides,
        }
    }

    beforeEach(() => {
        vi.clearAllMocks()
        // `mockReset` نه `mockClear`: صفِ `mockResolvedValueOnce` از تست قبلی نباید
        // به تست بعدی نشت کند.
        bcryptCompare.mockReset()
        bcryptCompare.mockResolvedValue(false)
    })

    it("وقتی رمز دائمی درست است، اصلاً توکن بازیابی لمس نمی‌شود", async () => {
        const client = makeClient()
        bcryptCompare.mockResolvedValue(true)

        const result = await authenticate("test@example.com", "right", client as never)

        expect(result).toEqual({ kind: "NORMAL", user: USER })
        expect(client.passwordResetToken.findFirst).not.toHaveBeenCalled()
    })

    it("رمز موقت درست ⇒ TEMPORARY به‌همراه مشخصات grant (tokenId + expiresAt)", async () => {
        const client = makeClient()
        // رمز دائمی رد می‌شود، رمز موقت قبول
        bcryptCompare.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

        const result = await authenticate("test@example.com", "tempPass", client as never)

        expect(result).toEqual({
            kind: "TEMPORARY",
            user: USER,
            resetTokenId: "tok_1",
            resetExpiresAt: EXPIRES_AT,
        })
    })

    it("نبودِ توکن فعال ⇒ همان InvalidCredentialsError (بدون نشت وضعیت)", async () => {
        const client = makeClient({
            passwordResetToken: {
                findFirst: vi.fn(async () => null),
                updateMany: vi.fn(async () => ({ count: 1 })),
                deleteMany: vi.fn(async () => ({ count: 1 })),
            },
        })
        bcryptCompare.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

        await expect(authenticate("test@example.com", "tempPass", client as never)).rejects.toBeInstanceOf(
            InvalidCredentialsError,
        )
    })

    it("کاربر ناموجود ⇒ InvalidCredentialsError و هیچ جست‌وجوی توکنی", async () => {
        const client = makeClient({ user: { findUnique: vi.fn(async () => null), update: vi.fn() } })

        await expect(authenticate("nobody@example.com", "x", client as never)).rejects.toBeInstanceOf(
            InvalidCredentialsError,
        )
        expect(client.passwordResetToken.findFirst).not.toHaveBeenCalled()
    })
})
