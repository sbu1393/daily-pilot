import { describe, expect, it } from "vitest"
import { PUSH_ENV, resolvePushConfig } from "./config"

const VALID = {
    [PUSH_ENV.publicKey]: "BPublicKey",
    [PUSH_ENV.privateKey]: "PrivateKeySecret",
    [PUSH_ENV.subject]: "mailto:ops@rozsaz.example",
}

describe("resolvePushConfig", () => {
    it("returns the VAPID config when all keys are present and valid", () => {
        const result = resolvePushConfig(VALID)

        expect(result).toEqual({
            ok: true,
            config: { publicKey: "BPublicKey", privateKey: "PrivateKeySecret", subject: "mailto:ops@rozsaz.example" },
        })
    })

    it("accepts an https subject", () => {
        const result = resolvePushConfig({ ...VALID, [PUSH_ENV.subject]: "https://rozsaz.example" })

        expect(result.ok).toBe(true)
    })

    it("reports every missing key without leaking values", () => {
        const result = resolvePushConfig({})

        expect(result.ok).toBe(false)
        if (!result.ok) {
            expect(result.missing).toEqual([PUSH_ENV.publicKey, PUSH_ENV.privateKey, PUSH_ENV.subject])
            expect(JSON.stringify(result)).not.toContain("PrivateKeySecret")
        }
    })

    it("treats an invalid subject as a problem", () => {
        const result = resolvePushConfig({ ...VALID, [PUSH_ENV.subject]: "not-a-subject" })

        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.missing).toEqual([PUSH_ENV.subject])
    })

    it("treats whitespace-only keys as missing", () => {
        const result = resolvePushConfig({ ...VALID, [PUSH_ENV.privateKey]: "   " })

        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.missing).toEqual([PUSH_ENV.privateKey])
    })

    it("does not require the client public key for server sending", () => {
        const result = resolvePushConfig(VALID)

        expect(result.ok).toBe(true)
    })
})
