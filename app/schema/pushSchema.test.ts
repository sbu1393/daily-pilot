import { describe, expect, it } from "vitest"
import { pushSubscribeSchema, pushUnsubscribeSchema } from "./pushSchema"

const ENDPOINT = "https://push.example.com/subscriptions/abc123"
const valid = { endpoint: ENDPOINT, keys: { p256dh: "BAbcdefg", auth: "secret-auth" } }

describe("pushSubscribeSchema", () => {
    it("accepts a standard browser subscription payload", () => {
        const parsed = pushSubscribeSchema.safeParse(valid)

        expect(parsed.success).toBe(true)
        if (parsed.success) {
            expect(parsed.data.endpoint).toBe(ENDPOINT)
            expect(parsed.data.keys).toEqual({ p256dh: "BAbcdefg", auth: "secret-auth" })
        }
    })

    it("strips an injected userId (never accepted from the body)", () => {
        const parsed = pushSubscribeSchema.safeParse({ ...valid, userId: 999 })

        expect(parsed.success).toBe(true)
        if (parsed.success) {
            expect(parsed.data).not.toHaveProperty("userId")
        }
    })

    it.each([
        ["missing keys", { endpoint: ENDPOINT }],
        ["missing p256dh", { endpoint: ENDPOINT, keys: { auth: "a" } }],
        ["missing auth", { endpoint: ENDPOINT, keys: { p256dh: "p" } }],
        ["empty p256dh", { endpoint: ENDPOINT, keys: { p256dh: "", auth: "a" } }],
        ["empty auth", { endpoint: ENDPOINT, keys: { p256dh: "p", auth: "" } }],
        ["non-url endpoint", { endpoint: "not-a-url", keys: { p256dh: "p", auth: "a" } }],
        ["non-http(s) endpoint", { endpoint: "ftp://example.com/x", keys: { p256dh: "p", auth: "a" } }],
        ["non-object payload", "nope"],
    ])("rejects %s", (_label, payload) => {
        expect(pushSubscribeSchema.safeParse(payload).success).toBe(false)
    })
})

describe("pushUnsubscribeSchema", () => {
    it("accepts a valid endpoint", () => {
        const parsed = pushUnsubscribeSchema.safeParse({ endpoint: ENDPOINT })

        expect(parsed.success).toBe(true)
        if (parsed.success) expect(parsed.data.endpoint).toBe(ENDPOINT)
    })

    it.each([
        ["null endpoint", { endpoint: null }],
        ["missing endpoint", {}],
        ["non-url endpoint", { endpoint: "javascript:alert(1)" }],
    ])("rejects %s", (_label, payload) => {
        expect(pushUnsubscribeSchema.safeParse(payload).success).toBe(false)
    })
})
