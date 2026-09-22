// یادآورها — route tests برای POST /api/notifications/reminder
//
// تمرکز: userId فقط از نشست، زمان فقط "HH:MM" معتبر، و اینکه این مسیر هیچ Push
// نمی‌فرستد و `reminderSentOn` (ضد-تکرار روزانه) را دست نمی‌زند.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    getPrisma: vi.fn(),
    isRateLimited: vi.fn(() => false),
    recordError: vi.fn(),
    update: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: mocks.getPrisma }))
vi.mock("@/app/lib/rateLimit", () => ({ isRateLimited: mocks.isRateLimited }))
vi.mock("@/src/lib/observability/recordError", () => ({ recordError: mocks.recordError }))

import { POST } from "./route"

const USER = { id: 7, email: "user@example.com" }

function post(body: unknown) {
    return POST(
        new NextRequest("http://localhost/api/notifications/reminder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: typeof body === "string" ? body : JSON.stringify(body),
        }),
    )
}

beforeEach(() => {
    mocks.getCurrentUser.mockReset().mockResolvedValue(USER)
    mocks.getPrisma.mockReset().mockReturnValue({ user: { update: mocks.update } })
    mocks.isRateLimited.mockReset().mockReturnValue(false)
    mocks.recordError.mockReset()
    mocks.update.mockReset().mockResolvedValue({ reminderEnabled: true, reminderTime: "09:00" })
})

describe("POST /api/notifications/reminder", () => {
    it("بدون نشست → 401 و هیچ نوشتنی", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await post({ enabled: true, time: "09:00" })

        expect(res.status).toBe(401)
        expect(mocks.update).not.toHaveBeenCalled()
    })

    it("rate limit → 429", async () => {
        mocks.isRateLimited.mockReturnValue(true)

        const res = await post({ enabled: true, time: "09:00" })

        expect(res.status).toBe(429)
        expect(mocks.update).not.toHaveBeenCalled()
        const [limiterKey] = mocks.isRateLimited.mock.calls[0] as unknown as [string]
        expect(limiterKey).toBe(`push:reminder:user:${USER.id}`)
    })

    it("ورودی نامعتبر → 400 بدون نوشتن", async () => {
        const invalid: unknown[] = [
            {},
            { enabled: true },
            { time: "09:00" },
            { enabled: "yes", time: "09:00" },
            { enabled: true, time: "9:00" },
            { enabled: true, time: "24:00" },
            { enabled: true, time: "09:60" },
            { enabled: true, time: "09:00:00" },
            "not-json",
        ]

        for (const body of invalid) {
            const res = await post(body)
            expect(res.status).toBe(400)
            expect(await res.json()).toMatchObject({ ok: false, error: { code: "VALIDATION_ERROR" } })
        }

        expect(mocks.update).not.toHaveBeenCalled()
    })

    it("فقط دو فیلد مجاز و فقط برای کاربر نشست ذخیره می‌شود", async () => {
        const res = await post({ enabled: true, time: "07:30", userId: 999, plan: "PRO" })

        expect(res.status).toBe(200)
        expect(await res.json()).toMatchObject({
            ok: true,
            data: { reminderEnabled: true, reminderTime: "09:00" },
        })

        expect(mocks.update).toHaveBeenCalledTimes(1)
        expect(mocks.update).toHaveBeenCalledWith({
            where: { id: USER.id },
            data: { reminderEnabled: true, reminderTime: "07:30" },
            select: { reminderEnabled: true, reminderTime: true },
        })
    })

    it("خاموش کردن یادآور هم آینه می‌شود (cron دیگر ارسال نمی‌کند)", async () => {
        mocks.update.mockResolvedValue({ reminderEnabled: false, reminderTime: "07:30" })

        const res = await post({ enabled: false, time: "07:30" })

        expect(res.status).toBe(200)
        expect(mocks.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: { reminderEnabled: false, reminderTime: "07:30" } }),
        )
        // هیچ فیلد دیگری (مثل reminderSentOn) لمس نمی‌شود
        const call = mocks.update.mock.calls[0] as unknown as [{ select: Record<string, boolean> }]
        expect(Object.keys(call[0].select)).toEqual(["reminderEnabled", "reminderTime"])
    })

    it("خطای غیرمنتظره → 500 و recordError", async () => {
        mocks.update.mockRejectedValue(new Error("db down"))

        const res = await post({ enabled: true, time: "09:00" })

        expect(res.status).toBe(500)
        expect(mocks.recordError).toHaveBeenCalledTimes(1)
    })
})
