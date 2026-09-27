import { describe, expect, it } from "vitest"

import { PUSH_ENV, isPushConfigured, isValidVapidSubject, readPushConfiguration } from "./config"

/* ------------------------------------------------------------------ */
/* Web Push — تست پیکربندی سرور                                        */
/*                                                                     */
/* نکته‌ی امنیتی کلیدی که این فایل قفل می‌کند: خروجی نبودِ پیکربندی فقط  */
/* «نام» متغیرها را برمی‌گرداند، هرگز مقدارها را — پس نه در پاسخ route  */
/* و نه در لاگ، کلید خصوصی لو نمی‌رود.                                  */
/* ------------------------------------------------------------------ */

const VALID: Record<string, string> = {
    [PUSH_ENV.publicKey]: "BPublicKeyExample1234567890",
    [PUSH_ENV.privateKey]: "private-key-example",
    [PUSH_ENV.subject]: "mailto:admin@example.com",
}

describe("readPushConfiguration", () => {
    it("با هر سه متغیر معتبر → configured", () => {
        const result = readPushConfiguration(VALID)

        expect(result.configured).toBe(true)
        expect(result.missing).toEqual([])
        if (result.configured) {
            expect(result.config.publicKey).toBe(VALID[PUSH_ENV.publicKey])
            expect(result.config.privateKey).toBe(VALID[PUSH_ENV.privateKey])
            expect(result.config.subject).toBe(VALID[PUSH_ENV.subject])
        }
    })

    it("مقدارها trim می‌شوند", () => {
        const result = readPushConfiguration({
            [PUSH_ENV.publicKey]: `  ${VALID[PUSH_ENV.publicKey]}  `,
            [PUSH_ENV.privateKey]: `\n${VALID[PUSH_ENV.privateKey]}\t`,
            [PUSH_ENV.subject]: ` ${VALID[PUSH_ENV.subject]} `,
        })

        expect(result.configured).toBe(true)
        if (result.configured) {
            expect(result.config.publicKey).toBe(VALID[PUSH_ENV.publicKey])
            expect(result.config.privateKey).toBe(VALID[PUSH_ENV.privateKey])
            expect(result.config.subject).toBe(VALID[PUSH_ENV.subject])
        }
    })

    it.each([
        [PUSH_ENV.publicKey],
        [PUSH_ENV.privateKey],
        [PUSH_ENV.subject],
    ])("نبودِ %s → configured=false و نام همان متغیر در missing", (key) => {
        const env = { ...VALID }
        delete env[key]

        const result = readPushConfiguration(env)

        expect(result.configured).toBe(false)
        expect(result.missing).toContain(key)
    })

    it("مقدار فقط-فاصله مثل نبودِ متغیر است", () => {
        const result = readPushConfiguration({ ...VALID, [PUSH_ENV.subject]: "   " })

        expect(result.configured).toBe(false)
        expect(result.missing).toEqual([PUSH_ENV.subject])
    })

    it("در حالت نبودِ پیکربندی هیچ مقداری برگردانده نمی‌شود", () => {
        const result = readPushConfiguration({
            [PUSH_ENV.publicKey]: "public-value-secret-ish",
            [PUSH_ENV.privateKey]: "super-secret-private-key",
        })

        expect(result.configured).toBe(false)
        expect(result.config).toBeNull()
        expect(JSON.stringify(result)).not.toContain("super-secret-private-key")
        expect(JSON.stringify(result)).not.toContain("public-value-secret-ish")
    })

    it("env خالی → هر سه متغیر missing", () => {
        const result = readPushConfiguration({})

        expect(result.configured).toBe(false)
        expect(result.missing.sort()).toEqual(Object.values(PUSH_ENV).sort())
    })
})

describe("isValidVapidSubject", () => {
    it("mailto معتبر و https را می‌پذیرد", () => {
        expect(isValidVapidSubject("mailto:admin@example.com")).toBe(true)
        expect(isValidVapidSubject("mailto:ops+push@roozchin.app")).toBe(true)
        expect(isValidVapidSubject("https://roozchin.app/push")).toBe(true)
    })

    it("موارد نامعتبر را رد می‌کند", () => {
        expect(isValidVapidSubject("")).toBe(false)
        expect(isValidVapidSubject("mailto:not-an-email")).toBe(false)
        expect(isValidVapidSubject("mailto:")).toBe(false)
        expect(isValidVapidSubject("http://insecure.example.com")).toBe(false)
        expect(isValidVapidSubject("admin@example.com")).toBe(false)
        expect(isValidVapidSubject("   ")).toBe(false)
    })
})

describe("isPushConfigured", () => {
    it("معتبر بودن subject را هم لحاظ می‌کند", () => {
        expect(isPushConfigured(VALID)).toBe(true)
        expect(isPushConfigured({ ...VALID, [PUSH_ENV.subject]: "http://x.example" })).toBe(false)
        expect(isPushConfigured({ ...VALID, [PUSH_ENV.subject]: "" })).toBe(false)
    })
})
