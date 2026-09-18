import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* E1 — تست‌های لایه سرویس auth.service (بدون DB زنده):                 */
/* مسابقه‌ی ثبت‌نام همزمان روی email @unique → Prisma P2002 باید        */
/* در مرز خطا (§9.11) به 409 CONFLICT تبدیل شود، نه 500 خام.           */
/* Prisma کاملاً mock است؛ تشخیص کد Prisma فقط با duck-typing.          */
/* ------------------------------------------------------------------ */

const { prismaMock, getPrismaMock } = vi.hoisted(() => {
    const prismaMock = {
        user: {
            findUnique: vi.fn(),
            create: vi.fn(),
        },
    }
    return { prismaMock, getPrismaMock: vi.fn(() => prismaMock) }
})

vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: getPrismaMock }))

vi.mock("bcryptjs", () => ({ default: { hash: vi.fn(async () => "hashed-password") } }))

import { EmailTakenError, ServiceError, UsernameTakenError } from "./errors"
import { registerUser } from "./auth.service"

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
