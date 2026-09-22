import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* ADR-07 / Phase 3-A — sender tests. `web-push` is mocked: no network. */
/* ------------------------------------------------------------------ */

const webpushMock = vi.hoisted(() => ({
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
}))

vi.mock("web-push", () => ({
    default: {
        setVapidDetails: webpushMock.setVapidDetails,
        sendNotification: webpushMock.sendNotification,
    },
}))

import { sendPushNotification } from "./sender"
import { PUSH_ENV } from "./config"

const ENV = {
    [PUSH_ENV.publicKey]: "BPublicKey",
    [PUSH_ENV.privateKey]: "PrivateKeySecret",
    [PUSH_ENV.subject]: "mailto:ops@rozsaz.example",
}

const SUBSCRIPTION = { endpoint: "https://push.example.com/x", p256dh: "p-key", auth: "a-key" }
const PAYLOAD = { type: "task-reminder", taskId: 42, title: "تماس", body: "وقتشه", url: "/dashboard?taskId=42" }

describe("sendPushNotification", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        webpushMock.sendNotification.mockResolvedValue({ statusCode: 201, body: "", headers: {} })
    })

    it("configures VAPID and sends a validated JSON payload", async () => {
        const result = await sendPushNotification(SUBSCRIPTION, PAYLOAD, { envSource: ENV })

        expect(result).toEqual({ ok: true, statusCode: 201 })
        expect(webpushMock.setVapidDetails).toHaveBeenCalledWith(
            ENV[PUSH_ENV.subject],
            ENV[PUSH_ENV.publicKey],
            ENV[PUSH_ENV.privateKey],
        )
        expect(webpushMock.sendNotification).toHaveBeenCalledTimes(1)
        const [target, body, options] = webpushMock.sendNotification.mock.calls[0]
        expect(target).toEqual({ endpoint: SUBSCRIPTION.endpoint, keys: { p256dh: "p-key", auth: "a-key" } })
        expect(JSON.parse(body)).toEqual(PAYLOAD)
        expect(options).toEqual({ TTL: 3600 })
        // هیچ secretی داخل payload نیست
        expect(body).not.toContain("PrivateKeySecret")
    })

    it("rejects a malformed payload without configuring or sending", async () => {
        const result = await sendPushNotification(SUBSCRIPTION, { type: "task-reminder", title: "" }, { envSource: ENV })

        expect(result).toEqual({ ok: false, reason: "invalid_payload" })
        expect(webpushMock.sendNotification).not.toHaveBeenCalled()
        expect(webpushMock.setVapidDetails).not.toHaveBeenCalled()
    })

    it("returns not_configured when VAPID env is missing (no throw)", async () => {
        const result = await sendPushNotification(SUBSCRIPTION, PAYLOAD, { envSource: {} })

        expect(result).toEqual({ ok: false, reason: "not_configured" })
        expect(webpushMock.sendNotification).not.toHaveBeenCalled()
    })

    it("maps a 410 response to gone", async () => {
        webpushMock.sendNotification.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 410 }))

        const result = await sendPushNotification(SUBSCRIPTION, PAYLOAD, { envSource: ENV })

        expect(result).toEqual({ ok: false, reason: "gone", statusCode: 410 })
    })

    it("maps a 404 response to gone", async () => {
        webpushMock.sendNotification.mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 404 }))

        const result = await sendPushNotification(SUBSCRIPTION, PAYLOAD, { envSource: ENV })

        expect(result).toEqual({ ok: false, reason: "gone", statusCode: 404 })
    })

    it("maps any other failure to failed", async () => {
        webpushMock.sendNotification.mockRejectedValue(new Error("network boom"))

        const result = await sendPushNotification(SUBSCRIPTION, PAYLOAD, { envSource: ENV })

        expect(result).toEqual({ ok: false, reason: "failed", statusCode: undefined })
    })

    it("honors a custom TTL", async () => {
        await sendPushNotification(SUBSCRIPTION, PAYLOAD, { envSource: ENV, ttlSeconds: 60 })

        expect(webpushMock.sendNotification.mock.calls[0][2]).toEqual({ TTL: 60 })
    })
})
