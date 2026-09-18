// فاز ۲ — F5/A4: تست‌های مرز external reporter (سند فاز ۲ §21)
//
// الزامات قرارداد:
//   - ورودی صرفاً رکورد normalized+redacted است (هیچ Error خام/request/body/credential)،
//   - هیچ vendor/network/dependency و هیچ persistence دوباره‌ای وجود ندارد،
//   - هیچ تغییری در رفتار فعلی ایجاد نمی‌کند (پیش‌فرض no-op)،
//   - fail-open است (throw/rejection adapter بی‌صدا swallow می‌شود).

import { afterEach, describe, expect, it, vi } from "vitest"

import {
    getExternalReporter,
    noopExternalReporter,
    reportExternal,
    setExternalReporter,
} from "../reportExternal"
import type { ExternalReportPayload } from "../reportExternal"
import type { NormalizedErrorRecord } from "../normalizeError"
import type { ObservabilityContext } from "../types"

const CONTEXT: ObservabilityContext = {
    requestId: "req-external-test",
    endpoint: "POST /api/test",
    userId: 11,
    feature: "observability",
}

const RECORD: NormalizedErrorRecord = {
    errorCode: "QUOTA_UNAVAILABLE",
    statusCode: 503,
    category: "DATABASE",
    severity: "ERROR",
    safeMessage: "quota db unavailable",
    stack: "Error: boom\n    at f ()",
    metadata: { prismaCode: "P2002" },
}

afterEach(() => {
    setExternalReporter(null)
    vi.restoreAllMocks()
})

describe("reportExternal — Phase 2 seam (§21 / A4)", () => {
    it("is a no-op by default (no vendor, no network, no side effect)", () => {
        expect(getExternalReporter()).toBe(noopExternalReporter)
        expect(() => reportExternal(RECORD, CONTEXT)).not.toThrow()
    })

    it("passes only the already normalized+redacted record and correlation ids", () => {
        const seen: ExternalReportPayload[] = []
        setExternalReporter((payload) => {
            seen.push(payload)
        })

        reportExternal(RECORD, CONTEXT)

        expect(seen).toHaveLength(1)
        expect(seen[0]!.record).toBe(RECORD)
        expect(seen[0]!.requestId).toBe("req-external-test")
        expect(seen[0]!.endpoint).toBe("POST /api/test")
        expect(seen[0]!.feature).toBe("observability")
        expect(seen[0]!.userId).toBe(11)
        // هیچ کلید خام/حساسی غیر از رکورد redact‌شده در payload نیست
        expect(Object.keys(seen[0]!)).toEqual(
            expect.arrayContaining(["record", "requestId", "endpoint", "feature", "userId"]),
        )
        expect(JSON.stringify(seen[0])).not.toContain("password")
    })

    it("omits optional correlation fields when the context does not have them", () => {
        const seen: ExternalReportPayload[] = []
        setExternalReporter((payload) => {
            seen.push(payload)
        })

        reportExternal(RECORD, { requestId: "r", endpoint: "e" })

        expect(seen[0]).not.toHaveProperty("feature")
        expect(seen[0]).not.toHaveProperty("userId")
    })

    it("swallows a throwing adapter (fail-open — never breaks the request path)", () => {
        setExternalReporter(() => {
            throw new Error("vendor exploded")
        })

        expect(() => reportExternal(RECORD, CONTEXT)).not.toThrow()
    })

    it("swallows a rejecting async adapter without unhandled rejection", async () => {
        setExternalReporter(async () => {
            throw new Error("async vendor exploded")
        })

        expect(() => reportExternal(RECORD, CONTEXT)).not.toThrow()
        await new Promise((resolve) => setTimeout(resolve, 0))
    })

    it("restores the no-op reporter when reset to null", () => {
        setExternalReporter(() => {})
        expect(getExternalReporter()).not.toBe(noopExternalReporter)
        setExternalReporter(null)
        expect(getExternalReporter()).toBe(noopExternalReporter)
    })

    it("does not persist anything itself and performs no network call (no DB/vendor import)", async () => {
        const src = await import("node:fs").then((fs) =>
            fs.promises.readFile("src/lib/observability/reportExternal.ts", "utf-8"),
        )
        // هیچ import اجرایی از DB یا SDK خارجی وجود ندارد (فقط import type)
        expect(src).not.toMatch(/@prisma\/client/)
        expect(src).not.toMatch(/getPrisma/)
        expect(src).not.toMatch(/from\s+["'](?!\.)[^"']*["']/)
        expect(src).not.toMatch(/\bfetch\s*\(/)
        expect(src).not.toMatch(/XMLHttpRequest|axios\.|https?\.request/)
    })
})
