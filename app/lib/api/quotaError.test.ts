import { describe, expect, it } from "vitest"

import { ApiClientError } from "./client"
import { isQuotaExceeded } from "./quotaError"

// تصمیم فقط بر اساس code است: همان 429 با کد دیگر باید false بدهد.
describe("isQuotaExceeded", () => {
    it("returns true for QUOTA_EXCEEDED", () => {
        expect(isQuotaExceeded(new ApiClientError(429, "QUOTA_EXCEEDED", "x"))).toBe(true)
    })

    it("returns false for RATE_LIMITED (same 429 status, different code)", () => {
        expect(isQuotaExceeded(new ApiClientError(429, "RATE_LIMITED", "x"))).toBe(false)
    })

    it("returns false for QUOTA_UNAVAILABLE (503 infrastructure)", () => {
        expect(isQuotaExceeded(new ApiClientError(503, "QUOTA_UNAVAILABLE", "x"))).toBe(false)
    })

    it("returns false for generic errors and non-error values", () => {
        expect(isQuotaExceeded(new Error("boom"))).toBe(false)
        expect(isQuotaExceeded("QUOTA_EXCEEDED")).toBe(false)
        expect(isQuotaExceeded({ code: "QUOTA_EXCEEDED" })).toBe(false)
        expect(isQuotaExceeded(undefined)).toBe(false)
        expect(isQuotaExceeded(null)).toBe(false)
    })
})
