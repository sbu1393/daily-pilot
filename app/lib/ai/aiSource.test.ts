import { describe, expect, it } from "vitest"

/* ------------------------------------------------------------------ */
/* C7 — §7.13 «Mock از AI واقعی جدا قابل تشخیص است» + §9.5             */
/* («Mock Result باید در UI قابل تشخیص باشد») — نگاشت نمایشی source.   */
/* ------------------------------------------------------------------ */

import { aiSourceNotice } from "./aiSource"

describe("aiSourceNotice (C7 — §7.13 mock identifiability in UI)", () => {
    it("returns the mock warning for source = mock", () => {
        const notice = aiSourceNotice("mock")
        expect(notice).not.toBeNull()
        expect(notice).toContain("⚠️")
        expect(notice).toContain("تحلیل پیش‌فرض")
    })

    it("returns the real-AI attribution for source = 1xai", () => {
        expect(aiSourceNotice("1xai")).toContain("هوش مصنوعی")
    })

    it("distinguishes mock from real AI (different messages)", () => {
        expect(aiSourceNotice("mock")).not.toBe(aiSourceNotice("1xai"))
    })

    it("returns null for unknown or missing source values", () => {
        expect(aiSourceNotice(null)).toBeNull()
        expect(aiSourceNotice(undefined)).toBeNull()
        expect(aiSourceNotice("")).toBeNull()
        expect(aiSourceNotice("unknown-provider")).toBeNull()
    })
})
