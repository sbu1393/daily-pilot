import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* Web Push — تست آداپتر ارسال (SDK با mock ایزوله می‌شود)              */
/*                                                                     */
/* هیچ ارسال واقعی انجام نمی‌شود: تنها مرز پکیج web-push mock است.     */
/* قفل‌شده: کلید خصوصی فقط به setVapidDetails می‌رود، payload همان      */
/* قرارداد JSON است، و خطای provider هرگز throw نمی‌شود.                */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
}))

vi.mock("web-push", () => ({
    default: {
        setVapidDetails: mocks.setVapidDetails,
        sendNotification: mocks.sendNotification,
    },
}))

import { deliverPush, ensureVapidDetails, isGoneStatusCode, resetVapidCache, type PushTarget } from "./adapter"

const CONFIG = {
    publicKey: "public-key",
    privateKey: "super-secret-private-key",
    subject: "mailto:admin@example.com",
}

const TARGET: PushTarget = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
    p256dh: "p256dh-value",
    auth: "auth-value",
}

const PAYLOAD = {
    title: "یادآور روزساز",
    body: "وقت برنامه‌ریزی روزت رسیده است ✨",
    url: "/dashboard",
    tag: "dp-reminder-2026-09-22|09:00",
}

beforeEach(() => {
    mocks.setVapidDetails.mockReset()
    mocks.sendNotification.mockReset()
    mocks.sendNotification.mockResolvedValue({ statusCode: 201 })
    resetVapidCache()
})

describe("isGoneStatusCode", () => {
    it("فقط 404/410 را «اشتراک مرده» می‌داند", () => {
        expect(isGoneStatusCode(404)).toBe(true)
        expect(isGoneStatusCode(410)).toBe(true)
        expect(isGoneStatusCode(400)).toBe(false)
        expect(isGoneStatusCode(429)).toBe(false)
        expect(isGoneStatusCode(500)).toBe(false)
        expect(isGoneStatusCode(null)).toBe(false)
        expect(isGoneStatusCode(undefined)).toBe(false)
    })
})

describe("ensureVapidDetails", () => {
    it("برای پیکربندی یکسان فقط یک‌بار صدا زده می‌شود (کش پروسه)", () => {
        ensureVapidDetails(CONFIG)
        ensureVapidDetails(CONFIG)
        ensureVapidDetails({ ...CONFIG, privateKey: "rotated" })

        expect(mocks.setVapidDetails).toHaveBeenCalledTimes(1)
        expect(mocks.setVapidDetails).toHaveBeenCalledWith(
            CONFIG.subject,
            CONFIG.publicKey,
            CONFIG.privateKey,
        )
    })

    it("با عوض شدن کلید/سابجکت دوباره تنظیم می‌شود", () => {
        ensureVapidDetails(CONFIG)
        ensureVapidDetails({ ...CONFIG, publicKey: "other-public-key" })

        expect(mocks.setVapidDetails).toHaveBeenCalledTimes(2)
        expect(mocks.setVapidDetails).toHaveBeenLastCalledWith(
            CONFIG.subject,
            "other-public-key",
            CONFIG.privateKey,
        )
    })
})

describe("deliverPush", () => {
    it("payload JSON قراردادی را با کلیدهای اشتراک ارسال می‌کند", async () => {
        const result = await deliverPush(TARGET, PAYLOAD, CONFIG)

        expect(result).toEqual({ ok: true, statusCode: 201 })
        expect(mocks.sendNotification).toHaveBeenCalledTimes(1)

        const [subscription, body, options] = mocks.sendNotification.mock.calls[0] as [
            { endpoint: string; keys: { p256dh: string; auth: string } },
            string,
            { TTL: number },
        ]

        expect(subscription).toEqual({
            endpoint: TARGET.endpoint,
            keys: { p256dh: TARGET.p256dh, auth: TARGET.auth },
        })
        expect(JSON.parse(body)).toEqual(PAYLOAD)
        expect(options.TTL).toBeGreaterThan(0)
    })

    it("خطای 410 → gone=true (اشتراک مرده) و بدون throw", async () => {
        mocks.sendNotification.mockRejectedValueOnce({ statusCode: 410 })

        const result = await deliverPush(TARGET, PAYLOAD, CONFIG)

        expect(result).toEqual({ ok: false, gone: true, statusCode: 410 })
    })

    it("خطای 404 → gone=true", async () => {
        mocks.sendNotification.mockRejectedValueOnce({ statusCode: 404 })

        expect(await deliverPush(TARGET, PAYLOAD, CONFIG)).toEqual({
            ok: false,
            gone: true,
            statusCode: 404,
        })
    })

    it("خطای موقت (500/بدون کد) → gone=false تا ردیف حذف نشود", async () => {
        mocks.sendNotification.mockRejectedValueOnce({ statusCode: 500 })
        expect(await deliverPush(TARGET, PAYLOAD, CONFIG)).toEqual({
            ok: false,
            gone: false,
            statusCode: 500,
        })

        mocks.sendNotification.mockRejectedValueOnce(new Error("socket hang up"))
        expect(await deliverPush(TARGET, PAYLOAD, CONFIG)).toEqual({
            ok: false,
            gone: false,
            statusCode: null,
        })
    })

    it("پیکربندی نامعتبر (خطای setVapidDetails) → شکست بدون throw", async () => {
        mocks.setVapidDetails.mockImplementationOnce(() => {
            throw new Error("Invalid VAPID keys")
        })

        expect(await deliverPush(TARGET, PAYLOAD, CONFIG)).toEqual({
            ok: false,
            gone: false,
            statusCode: null,
        })
        expect(mocks.sendNotification).not.toHaveBeenCalled()
    })
})
