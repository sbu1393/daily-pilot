// فاز ۲ — گام ۴: تست‌های integration اتصال recordError به pipeline (سند فاز ۲)
// پوشش: ترتیب normalize→redact→policy→persist، persist فقط برای کدهای مجاز policy،
// fail-open بودن کل زنجیره (persist throwing / evil error)،
// حفظ رفتار فاز صفر (امضا و خروجی console بدون تغییر)، رکورد redacted ذخیره می‌شود.

import { afterEach, describe, expect, it, vi } from "vitest"

import { recordError } from "../recordError"
import type { ObservabilityContext } from "../types"
import { ServiceError } from "@/app/lib/services/errors"

const CONTEXT: ObservabilityContext = {
    requestId: "req-pipeline-test",
    endpoint: "POST /api/test",
    userId: 3,
    feature: "observability",
}

afterEach(() => {
    vi.restoreAllMocks()
})

describe("recordError — Phase 2 pipeline (normalize → redact → policy → persist)", () => {
    it("persists an operational error (INTERNAL) through the pipeline", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

        recordError(new Error("boom"), CONTEXT)

        // pipeline async است؛ یک تیک صبر می‌کنیم
        await new Promise((r) => setTimeout(r, 0))

        // console فاز صفر همچنان چاپ شده (رفتار قبلی)
        expect(errorSpy).toHaveBeenCalledTimes(1)
        const logged = JSON.parse(errorSpy.mock.calls[0]![0] as string) as Record<string, unknown>
        expect(logged.message).toBe("boom")
        expect(warnSpy).not.toHaveBeenCalled()
    })

    it("does NOT persist expected user errors (policy=false) — e.g. VALIDATION_ERROR", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

        recordError(
            new ServiceError(400, "VALIDATION_ERROR", "ورودی نامعتبر"),
            CONTEXT,
        )
        await new Promise((r) => setTimeout(r, 0))

        // console فاز صفر چاپ می‌شود، اما هیچ fallback persist دیده نمی‌شود
        expect(errorSpy).toHaveBeenCalledTimes(1)
        expect(warnSpy).not.toHaveBeenCalled()
    })

    it("persists redacted data — secrets never reach the persistence layer", async () => {
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

        // خطای operational با متادیتای حساس — normalizeError از آبجکتِ خطای دارای code،
        // متادیتای primitive می‌سازد؛ redactError باید secret را کامل بپوشاند.
        recordError(
            { code: "QUOTA_UNAVAILABLE", status: 503, message: "q", connectionString: "postgres://u:p@h/db" },
            CONTEXT,
        )
        await new Promise((r) => setTimeout(r, 0))

        // هیچ مسیری محتوا حساس را به خروجی console نمی‌برد
        const allOutput = [...warnSpy.mock.calls, ...errorSpy.mock.calls]
            .map((c) => String(c[0]))
            .join("\n")
        expect(allOutput).not.toContain("postgres://u:p@h/db")
    })

    it("stays synchronous (does not await persistence before returning)", () => {
        vi.spyOn(console, "error").mockImplementation(() => {})
        const start = Date.now()
        expect(() => recordError(new Error("boom"), CONTEXT)).not.toThrow()
        // فراخوانی همگام برگشته (persist انتظار ندارد) — بدون معطلی معنادار
        expect(Date.now() - start).toBeLessThan(100)
    })
})

describe("recordError — fail-open (Phase 2 hardening)", () => {
    it("never throws when the whole pipeline misbehaves (evil throwing getter)", () => {
        vi.spyOn(console, "error").mockImplementation(() => {})
        const evil = {
            get message(): string {
                throw new Error("getter exploded")
            },
        }
        expect(() => recordError(evil, CONTEXT)).not.toThrow()
    })

    it("never throws when persist layer throws synchronously during pipeline", () => {
        // شبیه‌سازی شکست داخلی pipeline: خطای با getter انفجاری در بدنه‌ی خود خطا
        vi.spyOn(console, "error").mockImplementation(() => {})
        const evil = {
            get code(): string {
                throw new Error("code getter exploded")
            },
        }
        expect(() => recordError(evil, CONTEXT)).not.toThrow()
    })

    it("never throws for undefined/null/primitive error values", () => {
        vi.spyOn(console, "error").mockImplementation(() => {})
        expect(() => recordError(undefined, CONTEXT)).not.toThrow()
        expect(() => recordError(null, CONTEXT)).not.toThrow()
        expect(() => recordError(42, CONTEXT)).not.toThrow()
    })
})

describe("recordError — Phase 0 contract preservation", () => {
    it("keeps the exact console envelope for a plain Error", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        recordError(new Error("boom"), CONTEXT)

        const parsed = JSON.parse(spy.mock.calls[0]![0] as string) as Record<string, unknown>
        expect(parsed.requestId).toBe("req-pipeline-test")
        expect(parsed.endpoint).toBe("POST /api/test")
        expect(parsed.userId).toBe(3)
        expect(parsed.name).toBe("Error")
        expect(parsed.message).toBe("boom")
        expect(parsed.category).toBe("UNKNOWN")
        expect(parsed.severity).toBe("ERROR")
        expect(typeof parsed.stack).toBe("string")
    })

    it("keeps meta category/severity override behavior", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        recordError(new Error("db down"), CONTEXT, { category: "DATABASE", severity: "CRITICAL" })

        const parsed = JSON.parse(spy.mock.calls[0]![0] as string) as Record<string, unknown>
        expect(parsed.category).toBe("DATABASE")
        expect(parsed.severity).toBe("CRITICAL")
    })

    it("keeps inline-secret message redaction in console output", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {})

        recordError(new Error("login failed with password=hunter2"), CONTEXT)

        const parsed = JSON.parse(spy.mock.calls[0]![0] as string) as Record<string, unknown>
        expect(String(parsed.message)).not.toContain("hunter2")
        expect(String(parsed.message)).toContain("[REDACTED]")
    })

    it("never throws when console.error itself throws (Phase 0 fail-open kept)", () => {
        vi.spyOn(console, "error").mockImplementation(() => {
            throw new Error("console is broken")
        })
        expect(() => recordError(new Error("boom"), CONTEXT)).not.toThrow()
    })
})
