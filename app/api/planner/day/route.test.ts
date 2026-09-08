import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke test: GET /api/planner/day (ADR-04).               */
/* getDaySummary mocked: no DB, no rebalance engine.                   */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    getDaySummary: vi.fn(),
    setDayPlan: vi.fn(),
    getCanonicalToday: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/services/planner.service", () => ({
    getDaySummary: mocks.getDaySummary,
    setDayPlan: mocks.setDayPlan,
}))
vi.mock("@/app/lib/canonicalDay", () => ({ getCanonicalToday: mocks.getCanonicalToday }))

import { GET, POST } from "./route"
import { ServiceError } from "@/app/lib/services/errors"

const USER = { id: 1, username: "test", email: "test@example.com", timezone: "Asia/Tehran" }
const DAY_KEY = "2026-01-01"
const SUMMARY = {
    dayKey: DAY_KEY,
    availableMinutes: 120,
    spentMinutes: 40,
    savedMinutes: 20,
    openBudgetMinutes: 60,
}

describe("GET /api/planner/day", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
        mocks.getCanonicalToday.mockReturnValue(DAY_KEY)
    })

    it("returns 200 with { ok: true, data: summary } — summary is the direct data value", async () => {
        mocks.getDaySummary.mockResolvedValue(SUMMARY)

        const res = await GET(new NextRequest(`http://localhost/api/planner/day?dayKey=${DAY_KEY}`))

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: SUMMARY })
        expect(mocks.getDaySummary).toHaveBeenCalledWith(1, DAY_KEY)
    })

    it("defaults to getCanonicalToday(user.timezone) when dayKey is omitted", async () => {
        mocks.getDaySummary.mockResolvedValue(SUMMARY)

        const res = await GET(new NextRequest("http://localhost/api/planner/day"))

        expect(mocks.getCanonicalToday).toHaveBeenCalledWith("Asia/Tehran")
        expect(mocks.getDaySummary).toHaveBeenCalledWith(1, DAY_KEY)
        expect(res.status).toBe(200)
    })

    it("returns 400 VALIDATION_ERROR for a malformed dayKey and never calls the service", async () => {
        const res = await GET(new NextRequest("http://localhost/api/planner/day?dayKey=01-01-2026"))

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.getDaySummary).not.toHaveBeenCalled()
    })

    it("propagates a ServiceError with its status and code", async () => {
        mocks.getDaySummary.mockRejectedValue(
            new ServiceError(404, "DAY_NOT_FOUND", "برنامهای برای این روز ثبت نشده"),
        )

        const res = await GET(new NextRequest(`http://localhost/api/planner/day?dayKey=${DAY_KEY}`))

        expect(res.status).toBe(404)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("DAY_NOT_FOUND")
    })

    it("returns 401 UNAUTHORIZED when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await GET(new NextRequest(`http://localhost/api/planner/day?dayKey=${DAY_KEY}`))

        expect(res.status).toBe(401)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        })
        expect(mocks.getDaySummary).not.toHaveBeenCalled()
    })
})

describe("POST /api/planner/day", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
    })

    it("returns 200 with { ok: true, data: { plan, summary } }", async () => {
        const plan = { id: 1, dayKey: DAY_KEY, availableMinutes: 120, planVersion: 2 }
        mocks.setDayPlan.mockResolvedValue({ plan, summary: SUMMARY })

        const res = await POST(
            new NextRequest("http://localhost/api/planner/day", {
                method: "POST",
                body: JSON.stringify({ dayKey: DAY_KEY, availableMinutes: 120 }),
            }),
        )

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: { plan, summary: SUMMARY } })
        expect(mocks.setDayPlan).toHaveBeenCalledWith(1, DAY_KEY, 120)
    })

    it("returns 400 VALIDATION_ERROR for an invalid body and never calls the service", async () => {
        const res = await POST(
            new NextRequest("http://localhost/api/planner/day", {
                method: "POST",
                body: JSON.stringify({ dayKey: "2026-1-1", availableMinutes: 120 }),
            }),
        )

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.setDayPlan).not.toHaveBeenCalled()
    })

    it("propagates a ServiceError with its status and code", async () => {
        mocks.setDayPlan.mockRejectedValue(
            new ServiceError(409, "PLAN_CONFLICT", "برنامه در حال ویرایش است"),
        )

        const res = await POST(
            new NextRequest("http://localhost/api/planner/day", {
                method: "POST",
                body: JSON.stringify({ dayKey: DAY_KEY, availableMinutes: 120 }),
            }),
        )

        expect(res.status).toBe(409)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("PLAN_CONFLICT")
    })

    it("returns 401 UNAUTHORIZED when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await POST(
            new NextRequest("http://localhost/api/planner/day", {
                method: "POST",
                body: JSON.stringify({ dayKey: DAY_KEY, availableMinutes: 120 }),
            }),
        )

        expect(res.status).toBe(401)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        })
        expect(mocks.setDayPlan).not.toHaveBeenCalled()
    })
})