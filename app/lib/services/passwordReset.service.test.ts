import { describe, it, expect, vi, beforeEach } from "vitest"
import bcrypt from "bcryptjs"

import {
    issueTemporaryPassword,
    consumeTokenForLogin,
    consumeTokenAndSetPassword,
    invalidateActiveTokensForUser,
    findActiveTokenForUser,
    purgeExpiredTokens,
    PasswordResetRejectedError,
    PASSWORD_RESET_TTL_MS,
    PASSWORD_RESET_MAX_ATTEMPTS,
} from "@/app/lib/services/passwordReset.service"

/* passwordReset.service — lifecycle رمز موقت (بدون DB واقعی). */

const NOW = new Date("2026-01-01T00:00:00.000Z")

function makeClient() {
    // هر mock یک آرگومان `any` می‌گیرد تا `mock.calls[0][0]` در تست‌ها قابل
    // استفاده باشد؛ بدون آن، tuple خالی infer می‌شود و assertionها type-error
    // می‌دهند.
    return {
        user: {
            findUnique: vi.fn(async (_args: any) => null),
            update: vi.fn(async (_args: any) => ({})),
        },
        passwordResetToken: {
            create: vi.fn(async (_args: any) => ({ id: "tok_1" })),
            updateMany: vi.fn(async (_args: any) => ({ count: 1 })),
            findFirst: vi.fn(async (_args: any): Promise<any> => null),
            findMany: vi.fn(async (_args: any) => []),
            deleteMany: vi.fn(async (_args: any) => ({ count: 1 })),
            delete: vi.fn(async (_args: any) => ({ id: "tok_1" })),
        },
    }
}

beforeEach(() => {
    vi.restoreAllMocks()
})

describe("issueTemporaryPassword", () => {
    it("هیچ‌وقت plaintext را ذخیره نمی‌کند — فقط bcrypt hash", async () => {
        const client = makeClient()
        const issued = await issueTemporaryPassword(client as never, { userId: 7, now: NOW })

        const call = client.passwordResetToken.create.mock.calls[0][0] as {
            data: { tokenHash: string; expiresAt: Date }
        }
        expect(call.data.tokenHash).not.toBe(issued.temporaryPassword)
        // هش ۶۰ کاراکتری bcrypt با پیشوند مشخص
        expect(call.data.tokenHash).toMatch(/^\$2[aby]\$\d{2}\$/)
        expect(await bcrypt.compare(issued.temporaryPassword, call.data.tokenHash)).toBe(true)
    })

    it("رمز موقت را قبل از صدور، برای همان کاربر invalidate می‌کند (supersede)", async () => {
        const client = makeClient()
        await issueTemporaryPassword(client as never, { userId: 7, now: NOW })

        expect(client.passwordResetToken.updateMany).toHaveBeenCalledWith({
            where: { userId: 7, usedAt: null, invalidatedAt: null },
            data: { invalidatedAt: NOW },
        })
    })

    it("TTL دقیقاً ۱۵ دقیقه است", async () => {
        const client = makeClient()
        const issued = await issueTemporaryPassword(client as never, { userId: 7, now: NOW })
        expect(issued.expiresAt.getTime() - NOW.getTime()).toBe(PASSWORD_RESET_TTL_MS)
        expect(PASSWORD_RESET_TTL_MS).toBe(15 * 60 * 1000)
    })

    it("سقف تلاش پیش‌فرض ۵ است", async () => {
        const client = makeClient()
        await issueTemporaryPassword(client as never, { userId: 7, now: NOW })
        const call = client.passwordResetToken.create.mock.calls[0][0] as {
            data: { maxAttempts: number }
        }
        expect(call.data.maxAttempts).toBe(PASSWORD_RESET_MAX_ATTEMPTS)
        expect(PASSWORD_RESET_MAX_ATTEMPTS).toBe(5)
    })
})

describe("consumeTokenForLogin", () => {
    async function seedToken(client: ReturnType<typeof makeClient>, raw: string) {
        const tokenHash = await bcrypt.hash(raw, 4)
        client.passwordResetToken.findFirst.mockResolvedValue({
            id: "tok_1",
            tokenHash,
            attempts: 0,
            maxAttempts: 5,
            expiresAt: new Date(NOW.getTime() + PASSWORD_RESET_TTL_MS),
            usedAt: null,
            invalidatedAt: null,
        })
        return raw
    }

    it("رمز موقت درست را قبول می‌کند و توکن را مصرف نمی‌کند (مصرف در تعیین رمز است)", async () => {
        const client = makeClient()
        const raw = await seedToken(client, "ab3DEF2345xy")

        const result = await consumeTokenForLogin(client as never, {
            userId: 7,
            candidate: raw,
            now: NOW,
        })

        expect(result).toEqual({
            ok: true,
            tokenId: "tok_1",
            expiresAt: new Date(NOW.getTime() + PASSWORD_RESET_TTL_MS),
        })
        // مهم: این مسیر سمت لاگین است، نه سمت تغییر رمز
        expect(client.passwordResetToken.deleteMany).not.toHaveBeenCalled()
        expect(client.user.update).not.toHaveBeenCalled()
    })

    it("رمز موقت غلط را رد می‌کند ولی شمارندهٔ تلاش را زیاد می‌کند", async () => {
        const client = makeClient()
        await seedToken(client, "abcDEF2345!@")

        const result = await consumeTokenForLogin(client as never, {
            userId: 7,
            candidate: "wrongOne",
            now: NOW,
        })

        expect(result).toEqual({ ok: false })
        expect(client.passwordResetToken.updateMany).toHaveBeenCalledWith({
            where: { id: "tok_1" },
            data: { attempts: { increment: 1 } },
        })
    })

    it("توکن منقضی را رد می‌کند", async () => {
        const client = makeClient()
        const raw = await seedToken(client, "ab3DEF2345xy")
        ;(client.passwordResetToken.findFirst.mockResolvedValue)({
            id: "tok_1",
            tokenHash: await bcrypt.hash(raw, 4),
            attempts: 0,
            maxAttempts: 5,
            expiresAt: new Date(NOW.getTime() - 1),
            usedAt: null,
            invalidatedAt: null,
        })

        const result = await consumeTokenForLogin(client as never, {
            userId: 7,
            candidate: raw,
            now: NOW,
        })
        expect(result).toEqual({ ok: false })
    })

    it("توکن invalidated/used را رد می‌کند", async () => {
        for (const field of ["usedAt", "invalidatedAt"] as const) {
            const client = makeClient()
            const raw = await seedToken(client, "ab3DEF2345xy")
            ;(client.passwordResetToken.findFirst.mockResolvedValue)({
                id: "tok_1",
                tokenHash: await bcrypt.hash(raw, 4),
                attempts: 0,
                maxAttempts: 5,
                expiresAt: new Date(NOW.getTime() + PASSWORD_RESET_TTL_MS),
                usedAt: null,
                invalidatedAt: null,
                [field]: NOW,
            })

            const result = await consumeTokenForLogin(client as never, {
                userId: 7,
                candidate: raw,
                now: NOW,
            })
            expect(result).toEqual({ ok: false })
        }
    })

    it("پس از ۵ تلاش مجاز، حتی رمز درست هم رد می‌شود (سقف تلاش)", async () => {
        const client = makeClient()
        const raw = await seedToken(client, "ab3DEF2345xy")
        // attempts = 5 و maxAttempts = 5 ⇒ هر پنج تلاش مجاز رفته و این ششمین است
        ;(client.passwordResetToken.findFirst.mockResolvedValue)({
            id: "tok_1",
            tokenHash: await bcrypt.hash(raw, 4),
            attempts: 5,
            maxAttempts: 5,
            expiresAt: new Date(NOW.getTime() + PASSWORD_RESET_TTL_MS),
            usedAt: null,
            invalidatedAt: null,
        })

        const result = await consumeTokenForLogin(client as never, {
            userId: 7,
            candidate: raw,
            now: NOW,
        })
        expect(result).toEqual({ ok: false })
    })

    it("پنجمین تلاش (attempts=4) هنوز مجاز است — سقف دقیقاً ۵ است، نه ۴", async () => {
        const client = makeClient()
        const raw = await seedToken(client, "ab3DEF2345xy")
        ;(client.passwordResetToken.findFirst.mockResolvedValue)({
            id: "tok_1",
            tokenHash: await bcrypt.hash(raw, 4),
            attempts: 4,
            maxAttempts: 5,
            expiresAt: new Date(NOW.getTime() + PASSWORD_RESET_TTL_MS),
            usedAt: null,
            invalidatedAt: null,
        })

        const result = await consumeTokenForLogin(client as never, {
            userId: 7,
            candidate: raw,
            now: NOW,
        })
        expect(result).toEqual({
            ok: true,
            tokenId: "tok_1",
            expiresAt: new Date(NOW.getTime() + PASSWORD_RESET_TTL_MS),
        })
    })

    it("وقتی اصلاً توکنی فعال نیست، رد می‌کند و حتی bcrypt هم اجرا نمی‌شود", async () => {
        const client = makeClient()
        client.passwordResetToken.findFirst.mockResolvedValue(null)
        const compare = vi.spyOn(bcrypt, "compare")

        const result = await consumeTokenForLogin(client as never, {
            userId: 7,
            candidate: "anything",
            now: NOW,
        })

        expect(result).toEqual({ ok: false })
        expect(compare).not.toHaveBeenCalled()
    })
})

describe("consumeTokenAndSetPassword", () => {
    it("توکن را حذف و رمز دائمی + فلگ را در همان تراکنش می‌نویسد", async () => {
        const client = makeClient()

        await consumeTokenAndSetPassword(client as never, {
            userId: 7,
            tokenId: "tok_1",
            newPassword: "aVeryNewPassword1",
        })

        expect(client.passwordResetToken.deleteMany).toHaveBeenCalledWith({
            where: { id: "tok_1", userId: 7 },
        })

        const update = client.user.update.mock.calls[0][0] as unknown as {
            where: { id: number }
            data: { password: string; mustChangePassword: boolean }
        }
        expect(update.where.id).toBe(7)
        expect(update.data.mustChangePassword).toBe(false)
        expect(update.data.password).not.toBe("aVeryNewPassword1")
        expect(await bcrypt.compare("aVeryNewPassword1", update.data.password)).toBe(true)
    })

    it("اگر توکن در همان لحظه مصرف شده باشد (race/replay) هیچ نوشتنی انجام نمی‌شود", async () => {
        const client = makeClient()
        client.passwordResetToken.deleteMany.mockResolvedValue({ count: 0 })

        await expect(
            consumeTokenAndSetPassword(client as never, {
                userId: 7,
                tokenId: "tok_1",
                newPassword: "aVeryNewPassword1",
            }),
        ).rejects.toBeInstanceOf(PasswordResetRejectedError)

        // کلید: رمز جدید نوشته نشده ⇒ replay نتوانسته حساب را تغییر دهد
        expect(client.user.update).not.toHaveBeenCalled()
    })
})

describe("findActiveTokenForUser / invalidate / purge", () => {
    it("فقط جدیدترین توکن باز را برمی‌گرداند", async () => {
        const client = makeClient()
        await findActiveTokenForUser(client as never, 7)

        expect(client.passwordResetToken.findFirst).toHaveBeenCalledWith({
            where: { userId: 7, usedAt: null, invalidatedAt: null },
            orderBy: { createdAt: "desc" },
        })
    })

    it("invalidate فقط توکن‌های باز را می‌بندد", async () => {
        const client = makeClient()
        await invalidateActiveTokensForUser(client as never, 7, NOW)
        expect(client.passwordResetToken.updateMany).toHaveBeenCalledWith({
            where: { userId: 7, usedAt: null, invalidatedAt: null },
            data: { invalidatedAt: NOW },
        })
    })

    it("پاک‌سازی توکن‌های منقضی", async () => {
        const client = makeClient()
        const count = await purgeExpiredTokens(client as never, NOW)
        expect(count).toBe(1)
        expect(client.passwordResetToken.deleteMany).toHaveBeenCalledWith({
            where: { expiresAt: { lt: NOW } },
        })
    })
})
