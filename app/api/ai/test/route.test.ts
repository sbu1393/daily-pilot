import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke test: GET /api/ai/test (C8 — ADR-04 conformance).  */
/* runAiSamples mocked: بدون فراخوانی AI واقعی.                        */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    runAiSamples: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/services/analysis.service", () => ({ runAiSamples: mocks.runAiSamples }))

import { GET } from "./route"

const USER = { id: 1, username: "test", email: "test@example.com", timezone: "Asia/Tehran" }
const SAMPLES = [
    { source: "1xai", analysis: { priority: "HIGH", score: 90, estimatedMinutes: 45, reason: "دلیل", category: "Work" }, attempts: 1 },
    { source: "mock", analysis: { priority: "LOW", score: 40, estimatedMinutes: 15, reason: "دلیل", category: "Personal" }, attempts: 0 },
]

describe("GET /api/ai/test (C8 — ADR-04 envelope)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
    })

    it("returns 200 with the standard success envelope { ok: true, data: results }", async () => {
        mocks.runAiSamples.mockResolvedValue(SAMPLES)

        const res = await GET()

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: SAMPLES })
        expect(mocks.runAiSamples).toHaveBeenCalledTimes(1)
    })

    it("keeps the payload under data (payload preserved, envelope added)", async () => {
        mocks.runAiSamples.mockResolvedValue(SAMPLES)

        const res = await GET()
        const parsed = await res.json()

        expect(parsed.ok).toBe(true)
        expect(Array.isArray(parsed.data)).toBe(true)
        expect(parsed.data).toEqual(SAMPLES)
        expect(parsed.data[0].source).toBe("1xai")
    })

    it("returns 401 UNAUTHORIZED envelope when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await GET()

        expect(res.status).toBe(401)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        })
        expect(mocks.runAiSamples).not.toHaveBeenCalled()
    })

    it("propagates ServiceError through the standard error envelope", async () => {
        // runAiSamples در حال حاضر ServiceError پرتاب نمی‌کند؛ این تست قرارداد ADR-04
        // مسیر خطای احتمالی را قفل می‌کند (defense against regression).
        mocks.runAiSamples.mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }))

        const res = await GET()

        // خطای عمومی → 500 INTERNAL با همان ساختار envelope
        expect(res.status).toBe(500)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("INTERNAL")
        expect(parsed.error.message).toEqual(expect.any(String))
    })
})
