import { afterEach, describe, expect, it } from "vitest"
import {
    getVapidPublicKey,
    isPushSupported,
    subscriptionToPayload,
    urlBase64ToUint8Array,
} from "./client"

/* tests run in the node environment (no DOM) — browser APIs are only exercised
   through the pure helpers, matching the project's existing abstraction level. */

describe("urlBase64ToUint8Array", () => {
    it("decodes standard base64", () => {
        expect(Array.from(urlBase64ToUint8Array("AQID"))).toEqual([1, 2, 3])
    })

    it("decodes base64url characters (- and _)", () => {
        // "-_8" → base64url for bytes [0xFB, 0xFF]
        expect(Array.from(urlBase64ToUint8Array("-_8"))).toEqual([251, 255])
    })

    it("tolerates padding and ignores invalid characters", () => {
        expect(Array.from(urlBase64ToUint8Array("AQID=="))).toEqual([1, 2, 3])
        expect(Array.from(urlBase64ToUint8Array("AQ!ID"))).toEqual([1, 2, 3])
    })

    it("returns an empty array for an empty key", () => {
        expect(urlBase64ToUint8Array("").length).toBe(0)
    })
})

describe("subscriptionToPayload", () => {
    const json = { endpoint: "https://push.example.com/x", keys: { p256dh: "p", auth: "a" } }

    it("extracts endpoint + keys from a browser subscription", () => {
        const sub = { toJSON: () => json } as unknown as PushSubscription

        expect(subscriptionToPayload(sub)).toEqual({
            endpoint: "https://push.example.com/x",
            keys: { p256dh: "p", auth: "a" },
        })
    })

    it("returns null for missing subscription", () => {
        expect(subscriptionToPayload(null)).toBeNull()
        expect(subscriptionToPayload(undefined)).toBeNull()
    })

    it.each([
        ["missing endpoint", { keys: { p256dh: "p", auth: "a" } }],
        ["missing keys", { endpoint: "https://x" }],
        ["missing auth", { endpoint: "https://x", keys: { p256dh: "p" } }],
    ])("returns null for %s", (_label, payload) => {
        const sub = { toJSON: () => payload } as unknown as PushSubscription

        expect(subscriptionToPayload(sub)).toBeNull()
    })
})

describe("environment guards", () => {
    afterEach(() => {
        delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
    })

    it("reports unsupported in a non-browser environment", () => {
        expect(isPushSupported()).toBe(false)
    })

    it("returns the build-time env public key without any network call", async () => {
        process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "BEnvPublicKey"

        await expect(getVapidPublicKey()).resolves.toBe("BEnvPublicKey")
    })
})
