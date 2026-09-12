import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke test: GET /api/planner/suggestion (ADR-006/S2).    */
/* getDaySuggestion mocked: no DB, no rebalance engine.                */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    getDaySuggestion: vi.fn(),
    getCanonicalToday: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/services/planner.service", () => ({ getDaySuggestion: mocks.getDaySuggestion }))
vi.mock("@/app/lib/canonicalDay", () => ({ getCanonicalToday: mocks.getCanonicalToday }))

import { GET } from "./route"
import { ServiceError } from "@/app/lib/services/errors"

const USER = { id: 1, username: "test", email: "test@example.com", timezone: "Asia/Tehran" }
const DAY_KEY = "2026-03-05"

const SUGGESTION = {
    dayKey: DAY_KEY,
    capacityMinutes: 300,
    planned: [
        { taskId: 2, estimatedMinutes: 60, suggestedMinutes: 60, partial: false, weight: 54 },
        { taskId: 1, estimatedMinutes: 30, suggestedMinutes: 30, partial: false, weight: 27 },
    ],
    unfitted: [
        { taskId: 3, estimatedMinutes: 120, weight: 84 },
        { taskId: 4, estimatedMinutes: 90, weight: 45 },
    ],
    plannedMinutes: 90,
    remainingMinutes: 210,
    usedDefaultEstimate: [],
}

const callGET = (query = "") =>
    GET(new NextRequest(`http://localhost/api/planner/suggestion${query}`))

describe("GET /api/planner/suggestion", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
        mocks.getCanonicalToday.mockReturnValue(DAY_KEY)
    })

    it("returns 200 with { ok: true, data: suggestion } for an explicit date", async () => {
        mocks.getDaySuggestion.mockResolvedValue(SUGGESTION)

        const res = await callGET(`?date=${DAY_KEY}`)

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: SUGGESTION })
        expect(mocks.getDaySuggestion).toHaveBeenCalledWith(1, DAY_KEY)
    })

    it("defaults to the user's canonical today when date is omitted", async () => {
        mocks.getDaySuggestion.mockResolvedValue(SUGGESTION)

        const res = await callGET()

        expect(res.status).toBe(200)
        expect(mocks.getCanonicalToday).toHaveBeenCalledWith("Asia/Tehran")
        expect(mocks.getDaySuggestion).toHaveBeenCalledWith(1, DAY_KEY)
    })

    it("returns a structured suggestion payload (planned + unfitted + accounting)", async () => {
        mocks.getDaySuggestion.mockResolvedValue(SUGGESTION)

        const res = await callGET(`?date=${DAY_KEY}`)
        const parsed = (await res.json()) as { ok: boolean; data: typeof SUGGESTION }

        expect(parsed.ok).toBe(true)
        expect(Array.isArray(parsed.data.planned)).toBe(true)
        expect(Array.isArray(parsed.data.unfitted)).toBe(true)
        expect(parsed.data.planned.every((p) => p.taskId > 0 && p.suggestedMinutes > 0)).toBe(true)
        expect(parsed.data.plannedMinutes + parsed.data.remainingMinutes).toBeLessThanOrEqual(
            parsed.data.capacityMinutes,
        )
    })

    it("returns 400 VALIDATION_ERROR for a malformed date and never calls the service", async () => {
        const res = await callGET("?date=05-03-2026")

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.getDaySuggestion).not.toHaveBeenCalled()
    })

    it("returns 401 UNAUTHORIZED when not authenticated and never calls the service", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await callGET(`?date=${DAY_KEY}`)

        expect(res.status).toBe(401)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        })
        expect(mocks.getDaySuggestion).not.toHaveBeenCalled()
    })

    it("propagates a ServiceError with its status and code", async () => {
        mocks.getDaySuggestion.mockRejectedValue(
            new ServiceError(404, "DAY_NOT_FOUND", "برنامهای برای این روز ثبت نشده"),
        )

        const res = await callGET(`?date=${DAY_KEY}`)

        expect(res.status).toBe(404)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("DAY_NOT_FOUND")
    })

    it("returns 500 INTERNAL without leaking details for unmapped failures", async () => {
        mocks.getDaySuggestion.mockRejectedValue(new Error("db down"))

        const res = await callGET(`?date=${DAY_KEY}`)

        expect(res.status).toBe(500)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("INTERNAL")
        expect(parsed.error.message).not.toContain("db down")
    })
})
