import { describe, expect, it } from "vitest"
import { authorizeCronRequest, CRON_SECRET_ENV } from "./cronAuth"

function headers(map: Record<string, string>) {
    return { get: (name: string) => map[name.toLowerCase()] ?? null }
}

describe("authorizeCronRequest", () => {
    it("is fail-closed (503) when CRON_SECRET is not configured", () => {
        expect(authorizeCronRequest(headers({}), undefined)).toMatchObject({
            ok: false,
            status: 503,
            code: "CRON_NOT_CONFIGURED",
        })
        expect(authorizeCronRequest(headers({}), "   ")).toMatchObject({ ok: false, status: 503 })
    })

    it("rejects a missing secret when configured (401)", () => {
        expect(authorizeCronRequest(headers({}), "top-secret")).toMatchObject({
            ok: false,
            status: 401,
            code: "UNAUTHORIZED",
        })
    })

    it("rejects a wrong secret (401)", () => {
        expect(authorizeCronRequest(headers({ authorization: "Bearer nope" }), "top-secret")).toMatchObject({
            ok: false,
            status: 401,
        })
    })

    it("accepts a correct Bearer token", () => {
        expect(authorizeCronRequest(headers({ authorization: "Bearer top-secret" }), "top-secret")).toEqual({ ok: true })
    })

    it("accepts a correct x-cron-secret header", () => {
        expect(authorizeCronRequest(headers({ "x-cron-secret": "top-secret" }), "top-secret")).toEqual({ ok: true })
    })

    it("exposes the env key name used for the secret", () => {
        expect(CRON_SECRET_ENV).toBe("CRON_SECRET")
    })
})
