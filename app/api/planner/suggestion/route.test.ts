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
    touchAuthenticatedActivity: vi.fn(),
    recordProductEvent: vi.fn(),
    getPrisma: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/services/planner.service", () => ({ getDaySuggestion: mocks.getDaySuggestion }))
vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: mocks.getPrisma }))
vi.mock("@/app/lib/services/userActivity.service", () => ({
    touchAuthenticatedActivity: mocks.touchAuthenticatedActivity,
}))
vi.mock("@/app/lib/services/productEvent.service", () => ({
    recordProductEvent: mocks.recordProductEvent,
}))
// M10: فقط getCanonicalToday mock می‌شود؛ اعتبارسنجی روز باید واقعی (قالب + تقویم) تست شود
vi.mock("@/app/lib/canonicalDay", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/canonicalDay")>()),
    getCanonicalToday: mocks.getCanonicalToday,
}))

import { GET } from "./route"
import { ServiceError } from "@/app/lib/services/errors"

describe("GET /api/planner/suggestion — X-Request-ID (فاز صفر §7)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue({
            id: 1,
            username: "test",
            email: "t@example.com",
            timezone: "Asia/Tehran",
        })
        mocks.touchAuthenticatedActivity.mockResolvedValue({ touched: true })
        mocks.recordProductEvent.mockResolvedValue({ recorded: true, eventName: "planner.suggestion_viewed" })
        mocks.getPrisma.mockReturnValue({})
    })

    it("GET success response carries X-Request-ID", async () => {
        mocks.getDaySuggestion.mockResolvedValue({ tasks: [] })

        const res = await callGET("?date=2026-01-02")

        expect(res.status).toBe(200)
        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
    })

    it("GET validation error carries X-Request-ID", async () => {
        const res = await callGET("?date=2026-13-99")

        expect(res.status).toBe(400)
        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
    })
})

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
    protectedTaskIds: [],
    basis: { planVersion: 3, rebalancedVersion: 3, availableMinutes: 300, taskCount: 4 },
    state: "fresh" as const,
}

const callGET = (query = "") =>
    GET(new NextRequest(`http://localhost/api/planner/suggestion${query}`))

describe("GET /api/planner/suggestion", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
        mocks.getCanonicalToday.mockReturnValue(DAY_KEY)
        mocks.touchAuthenticatedActivity.mockResolvedValue({ touched: true })
        mocks.recordProductEvent.mockResolvedValue({
            recorded: true,
            eventName: "planner.suggestion_viewed",
        })
        mocks.getPrisma.mockReturnValue({})
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

    it("passes through the A1 basis metadata and freshness state", async () => {
        mocks.getDaySuggestion.mockResolvedValue(SUGGESTION)

        const res = await callGET(`?date=${DAY_KEY}`)
        const parsed = (await res.json()) as { ok: boolean; data: typeof SUGGESTION }

        expect(parsed.data.state).toBe("fresh")
        expect(parsed.data.basis).toEqual({
            planVersion: 3,
            rebalancedVersion: 3,
            availableMinutes: 300,
            taskCount: 4,
        })
        expect(parsed.data.protectedTaskIds).toEqual([])
    })

    it("returns 400 VALIDATION_ERROR for a malformed date and never calls the service", async () => {
        const res = await callGET("?date=05-03-2026")

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.getDaySuggestion).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR for a calendar-invalid date (M10) and never calls the service", async () => {
        for (const bad of ["2026-02-30", "2026-13-99"]) {
            const res = await callGET(`?date=${bad}`)

            expect(res.status).toBe(400)
            const parsed = await res.json()
            expect(parsed.error.code).toBe("VALIDATION_ERROR")
        }
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

    /* ---------------------------------------------------------------- */
    /* فاز ۳ — گام ۱۰: integration تحلیل (touch + planner.suggestion_viewed) */
    /* ---------------------------------------------------------------- */

    it("touches activity and records planner.suggestion_viewed after successful view", async () => {
        mocks.getDaySuggestion.mockResolvedValue(SUGGESTION)

        const res = await callGET(`?date=${DAY_KEY}`)

        expect(res.status).toBe(200)
        expect(mocks.touchAuthenticatedActivity).toHaveBeenCalledTimes(1)
        expect(mocks.recordProductEvent).toHaveBeenCalledTimes(1)
        expect(mocks.recordProductEvent).toHaveBeenCalledWith(
            1,
            "planner.suggestion_viewed",
            undefined, // allowlist خالی — بدون properties
            expect.objectContaining({
                requestId: expect.any(String),
                endpoint: "/api/planner/suggestion",
                feature: "planner",
            }),
        )
    })

    it("orders the analytics boundary: business success < touch < product event", async () => {
        mocks.getDaySuggestion.mockResolvedValue(SUGGESTION)

        await callGET(`?date=${DAY_KEY}`)

        const businessOrder = mocks.getDaySuggestion.mock.invocationCallOrder[0]
        const touchOrder = mocks.touchAuthenticatedActivity.mock.invocationCallOrder[0]
        const eventOrder = mocks.recordProductEvent.mock.invocationCallOrder[0]
        expect(touchOrder).toBeGreaterThan(businessOrder)
        expect(eventOrder).toBeGreaterThan(touchOrder)
    })

    it("event properties are empty (undefined) — no suggestion/task content leakage", async () => {
        mocks.getDaySuggestion.mockResolvedValue(SUGGESTION)

        await callGET(`?date=${DAY_KEY}`)

        const props = mocks.recordProductEvent.mock.calls[0][2]
        expect(props).toBeUndefined()
        const args = JSON.stringify(mocks.recordProductEvent.mock.calls[0])
        expect(args).not.toContain("planned")
        expect(args).not.toContain("unfitted")
        expect(args).not.toContain("taskId")
        expect(args).not.toContain(DAY_KEY)
    })

    it("propagates the requestId (correlation only)", async () => {
        mocks.getDaySuggestion.mockResolvedValue(SUGGESTION)

        await callGET(`?date=${DAY_KEY}`)

        const ctx = mocks.recordProductEvent.mock.calls[0][3]
        expect(ctx.requestId).toEqual(expect.any(String))
        expect(ctx.endpoint).toBe("/api/planner/suggestion")
        expect(ctx.feature).toBe("planner")
    })

    it("emits no event and no touch on validation failure", async () => {
        const res = await callGET("?date=2026-13-99")

        expect(res.status).toBe(400)
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
    })

    it("emits no event and no touch on auth failure", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        await callGET(`?date=${DAY_KEY}`)

        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
    })

    it("emits no event and no touch on business/view failure (DAY_NOT_FOUND)", async () => {
        mocks.getDaySuggestion.mockRejectedValue(
            new ServiceError(404, "DAY_NOT_FOUND", "برنامهای برای این روز ثبت نشده"),
        )

        const res = await callGET(`?date=${DAY_KEY}`)

        expect(res.status).toBe(404)
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
    })

    it("keeps the 200 response unchanged when touch fails (fail-open), event still recorded", async () => {
        mocks.getDaySuggestion.mockResolvedValue(SUGGESTION)
        mocks.touchAuthenticatedActivity.mockRejectedValue(new Error("analytics db down"))

        const res = await callGET(`?date=${DAY_KEY}`)

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: SUGGESTION })
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
    })

    it("keeps the 200 response unchanged when event persistence fails (fail-open)", async () => {
        mocks.getDaySuggestion.mockResolvedValue(SUGGESTION)
        mocks.recordProductEvent.mockRejectedValue(new Error("event insert failed"))

        const res = await callGET(`?date=${DAY_KEY}`)

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: SUGGESTION })
    })
})
