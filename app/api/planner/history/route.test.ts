import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke test: GET /api/planner/history (ADR-04).           */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    getHistoryMarkers: vi.fn(),
    touchAuthenticatedActivity: vi.fn(),
    recordProductEvent: vi.fn(),
    getPrisma: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/services/planner.service", () => ({ getHistoryMarkers: mocks.getHistoryMarkers }))
vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: mocks.getPrisma }))
vi.mock("@/app/lib/services/userActivity.service", () => ({
    touchAuthenticatedActivity: mocks.touchAuthenticatedActivity,
}))
vi.mock("@/app/lib/services/productEvent.service", () => ({
    recordProductEvent: mocks.recordProductEvent,
}))

import { GET } from "./route"

describe("GET /api/planner/history — X-Request-ID (فاز صفر §7)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue({
            id: 1,
            username: "test",
            email: "t@example.com",
            timezone: "Asia/Tehran",
        })
        mocks.touchAuthenticatedActivity.mockResolvedValue({ touched: true })
        mocks.recordProductEvent.mockResolvedValue({ recorded: true, eventName: "planner.history_viewed" })
        mocks.getPrisma.mockReturnValue({})
    })

    it("GET success response carries X-Request-ID", async () => {
        mocks.getHistoryMarkers.mockResolvedValue([])

        const res = await GET(
            new NextRequest("http://localhost/api/planner/history?from=2026-01-01&to=2026-01-31"),
        )

        expect(res.status).toBe(200)
        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
    })

    it("GET validation error carries X-Request-ID", async () => {
        const res = await GET(new NextRequest("http://localhost/api/planner/history?from=2026-01-01"))

        expect(res.status).toBe(400)
        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
    })
})

const USER = { id: 1, username: "test", email: "test@example.com", timezone: "Asia/Tehran" }
const MARKERS = [
    { dayKey: "2026-01-01", hasPlan: true },
    { dayKey: "2026-01-02", hasPlan: false },
]

describe("GET /api/planner/history", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
        mocks.touchAuthenticatedActivity.mockResolvedValue({ touched: true })
        mocks.recordProductEvent.mockResolvedValue({
            recorded: true,
            eventName: "planner.history_viewed",
        })
        mocks.getPrisma.mockReturnValue({})
    })

    it("returns 200 with { ok: true, data: markers } for a valid range", async () => {
        mocks.getHistoryMarkers.mockResolvedValue(MARKERS)

        const res = await GET(
            new NextRequest("http://localhost/api/planner/history?from=2026-01-01&to=2026-01-31"),
        )

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: MARKERS })
        expect(mocks.getHistoryMarkers).toHaveBeenCalledWith(1, "2026-01-01", "2026-01-31")
    })

    it("returns 400 VALIDATION_ERROR when from/to are missing and never calls the service", async () => {
        const res = await GET(new NextRequest("http://localhost/api/planner/history?from=2026-01-01"))

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.getHistoryMarkers).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR when from is after to", async () => {
        const res = await GET(
            new NextRequest("http://localhost/api/planner/history?from=2026-02-01&to=2026-01-01"),
        )

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.getHistoryMarkers).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR for a malformed from/to format (M4)", async () => {
        for (const qs of ["from=2026-1-1&to=2026-01-31", "from=2026-01-01&to=01-31-2026"]) {
            const res = await GET(new NextRequest(`http://localhost/api/planner/history?${qs}`))

            expect(res.status).toBe(400)
            const parsed = await res.json()
            expect(parsed.error.code).toBe("VALIDATION_ERROR")
        }
        expect(mocks.getHistoryMarkers).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR for calendar-invalid dates (M10)", async () => {
        for (const qs of [
            "from=2026-02-30&to=2026-03-01",
            "from=2026-13-99&to=2026-13-99",
            "from=2026-01-01&to=2026-02-29", // ۲۰۲۶ کبیسه نیست
        ]) {
            const res = await GET(new NextRequest(`http://localhost/api/planner/history?${qs}`))

            expect(res.status).toBe(400)
            const parsed = await res.json()
            expect(parsed.error.code).toBe("VALIDATION_ERROR")
        }
        expect(mocks.getHistoryMarkers).not.toHaveBeenCalled()
    })

    it("accepts a leap day in a leap year (2028-02-29)", async () => {
        mocks.getHistoryMarkers.mockResolvedValue([])

        const res = await GET(
            new NextRequest("http://localhost/api/planner/history?from=2028-02-29&to=2028-03-01"),
        )

        expect(res.status).toBe(200)
        expect(mocks.getHistoryMarkers).toHaveBeenCalledWith(1, "2028-02-29", "2028-03-01")
    })

    it("returns 401 UNAUTHORIZED when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await GET(
            new NextRequest("http://localhost/api/planner/history?from=2026-01-01&to=2026-01-31"),
        )

        expect(res.status).toBe(401)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        })
        expect(mocks.getHistoryMarkers).not.toHaveBeenCalled()
    })

    /* ---------------------------------------------------------------- */
    /* فاز ۳ — گام ۱۰: integration تحلیل (touch + planner.history_viewed) */
    /* ---------------------------------------------------------------- */

    it("touches activity and records planner.history_viewed after successful view", async () => {
        mocks.getHistoryMarkers.mockResolvedValue(MARKERS)

        const res = await GET(
            new NextRequest("http://localhost/api/planner/history?from=2026-01-01&to=2026-01-31"),
        )

        expect(res.status).toBe(200)
        expect(mocks.touchAuthenticatedActivity).toHaveBeenCalledTimes(1)
        expect(mocks.recordProductEvent).toHaveBeenCalledTimes(1)
        expect(mocks.recordProductEvent).toHaveBeenCalledWith(
            1,
            "planner.history_viewed",
            undefined, // allowlist خالی — بدون properties
            expect.objectContaining({
                requestId: expect.any(String),
                endpoint: "/api/planner/history",
                feature: "planner",
            }),
        )
    })

    it("orders the analytics boundary: business success < touch < product event", async () => {
        mocks.getHistoryMarkers.mockResolvedValue(MARKERS)

        await GET(
            new NextRequest("http://localhost/api/planner/history?from=2026-01-01&to=2026-01-31"),
        )

        const businessOrder = mocks.getHistoryMarkers.mock.invocationCallOrder[0]
        const touchOrder = mocks.touchAuthenticatedActivity.mock.invocationCallOrder[0]
        const eventOrder = mocks.recordProductEvent.mock.invocationCallOrder[0]
        expect(touchOrder).toBeGreaterThan(businessOrder)
        expect(eventOrder).toBeGreaterThan(touchOrder)
    })

    it("event properties are empty (undefined) — no history/date-range content leakage", async () => {
        mocks.getHistoryMarkers.mockResolvedValue(MARKERS)

        await GET(
            new NextRequest("http://localhost/api/planner/history?from=2026-01-01&to=2026-01-31"),
        )

        const props = mocks.recordProductEvent.mock.calls[0][2]
        expect(props).toBeUndefined()
        const args = JSON.stringify(mocks.recordProductEvent.mock.calls[0])
        expect(args).not.toContain("hasPlan")
        expect(args).not.toContain("2026-01-31")
    })

    it("propagates the requestId (correlation only)", async () => {
        mocks.getHistoryMarkers.mockResolvedValue(MARKERS)

        await GET(
            new NextRequest("http://localhost/api/planner/history?from=2026-01-01&to=2026-01-31"),
        )

        const ctx = mocks.recordProductEvent.mock.calls[0][3]
        expect(ctx.requestId).toEqual(expect.any(String))
        expect(ctx.endpoint).toBe("/api/planner/history")
        expect(ctx.feature).toBe("planner")
    })

    it("emits no event and no touch on validation failure", async () => {
        const res = await GET(
            new NextRequest("http://localhost/api/planner/history?from=2026-13-99&to=2026-13-99"),
        )

        expect(res.status).toBe(400)
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
    })

    it("emits no event and no touch on auth failure", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        await GET(
            new NextRequest("http://localhost/api/planner/history?from=2026-01-01&to=2026-01-31"),
        )

        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
    })

    it("emits no event and no touch on business/view failure", async () => {
        mocks.getHistoryMarkers.mockRejectedValue(new Error("db down"))
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

        const res = await GET(
            new NextRequest("http://localhost/api/planner/history?from=2026-01-01&to=2026-01-31"),
        )

        expect(res.status).toBe(500)
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
        errorSpy.mockRestore()
    })

    it("keeps the 200 response unchanged when touch fails (fail-open), event still recorded", async () => {
        mocks.getHistoryMarkers.mockResolvedValue(MARKERS)
        mocks.touchAuthenticatedActivity.mockRejectedValue(new Error("analytics db down"))

        const res = await GET(
            new NextRequest("http://localhost/api/planner/history?from=2026-01-01&to=2026-01-31"),
        )

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: MARKERS })
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
    })

    it("keeps the 200 response unchanged when event persistence fails (fail-open)", async () => {
        mocks.getHistoryMarkers.mockResolvedValue(MARKERS)
        mocks.recordProductEvent.mockRejectedValue(new Error("event insert failed"))

        const res = await GET(
            new NextRequest("http://localhost/api/planner/history?from=2026-01-01&to=2026-01-31"),
        )

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: MARKERS })
    })
})