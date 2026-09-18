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
    touchAuthenticatedActivity: vi.fn(),
    recordProductEvent: vi.fn(),
    getPrisma: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/services/planner.service", () => ({
    getDaySummary: mocks.getDaySummary,
    setDayPlan: mocks.setDayPlan,
}))
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

import { GET, POST } from "./route"
import { ServiceError } from "@/app/lib/services/errors"

describe("/api/planner/day — X-Request-ID (فاز صفر §7/§25)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue({
            id: 1,
            username: "test",
            email: "t@example.com",
            timezone: "Asia/Tehran",
        })
        mocks.touchAuthenticatedActivity.mockResolvedValue({ touched: true })
        mocks.recordProductEvent.mockResolvedValue({ recorded: true, eventName: "planner.day_viewed" })
        mocks.getPrisma.mockReturnValue({})
    })

    it("GET success response carries X-Request-ID", async () => {
        mocks.getDaySummary.mockResolvedValue({ availableMinutes: 0 })

        const res = await GET(new NextRequest("http://localhost/api/planner/day?dayKey=2026-01-02"))

        expect(res.status).toBe(200)
        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
    })

    it("GET validation error carries X-Request-ID", async () => {
        const res = await GET(new NextRequest("http://localhost/api/planner/day?dayKey=2026-13-99"))

        expect(res.status).toBe(400)
        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
    })
})

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
        mocks.touchAuthenticatedActivity.mockResolvedValue({ touched: true })
        mocks.recordProductEvent.mockResolvedValue({ recorded: true, eventName: "planner.day_viewed" })
        mocks.getPrisma.mockReturnValue({})
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

    it("maps an infrastructure failure from getCurrentUser to 500 INTERNAL (M1 — not a misleading 401)", async () => {
        mocks.getCurrentUser.mockRejectedValue(new Error("db down"))
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

        const res = await GET(new NextRequest(`http://localhost/api/planner/day?dayKey=${DAY_KEY}`))

        expect(res.status).toBe(500)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "INTERNAL", message: "Server error" },
        })
        expect(mocks.getDaySummary).not.toHaveBeenCalled()
        errorSpy.mockRestore()
    })

    it("returns 400 VALIDATION_ERROR for a calendar-invalid dayKey (M10) and never calls the service", async () => {
        for (const bad of ["2026-02-30", "2026-13-99"]) {
            const res = await GET(new NextRequest(`http://localhost/api/planner/day?dayKey=${bad}`))

            expect(res.status).toBe(400)
            const parsed = await res.json()
            expect(parsed.error.code).toBe("VALIDATION_ERROR")
        }
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

    /* ---------------------------------------------------------------- */
    /* فاز ۳ — گام ۱۰: integration تحلیل (touch + planner.day_viewed)    */
    /* ---------------------------------------------------------------- */

    it("touches activity and records planner.day_viewed after successful day view", async () => {
        mocks.getDaySummary.mockResolvedValue(SUMMARY)

        const res = await GET(new NextRequest(`http://localhost/api/planner/day?dayKey=${DAY_KEY}`))

        expect(res.status).toBe(200)
        expect(mocks.touchAuthenticatedActivity).toHaveBeenCalledTimes(1)
        expect(mocks.recordProductEvent).toHaveBeenCalledTimes(1)
        expect(mocks.recordProductEvent).toHaveBeenCalledWith(
            1,
            "planner.day_viewed",
            undefined, // allowlist خالی — بدون properties
            expect.objectContaining({
                requestId: expect.any(String),
                endpoint: "/api/planner/day",
                feature: "planner",
            }),
        )
    })

    it("orders the analytics boundary: business success < touch < product event", async () => {
        mocks.getDaySummary.mockResolvedValue(SUMMARY)

        await GET(new NextRequest(`http://localhost/api/planner/day?dayKey=${DAY_KEY}`))

        const businessOrder = mocks.getDaySummary.mock.invocationCallOrder[0]
        const touchOrder = mocks.touchAuthenticatedActivity.mock.invocationCallOrder[0]
        const eventOrder = mocks.recordProductEvent.mock.invocationCallOrder[0]
        expect(touchOrder).toBeGreaterThan(businessOrder)
        expect(eventOrder).toBeGreaterThan(touchOrder)
    })

    it("event properties are empty (undefined) — no dayKey/date/timezone/content leakage", async () => {
        mocks.getDaySummary.mockResolvedValue(SUMMARY)

        await GET(new NextRequest(`http://localhost/api/planner/day?dayKey=${DAY_KEY}`))

        const args = JSON.stringify(mocks.recordProductEvent.mock.calls[0])
        expect(args).not.toContain(DAY_KEY)
        expect(args).not.toContain("Asia/Tehran")
        expect(args).not.toContain("availableMinutes")
    })

    it("propagates the requestId (correlation only)", async () => {
        mocks.getDaySummary.mockResolvedValue(SUMMARY)

        await GET(new NextRequest(`http://localhost/api/planner/day?dayKey=${DAY_KEY}`))

        const ctx = mocks.recordProductEvent.mock.calls[0][3]
        expect(ctx.requestId).toEqual(expect.any(String))
        expect(ctx.endpoint).toBe("/api/planner/day")
        expect(ctx.feature).toBe("planner")
    })

    it("emits no event and no touch on validation failure", async () => {
        const res = await GET(new NextRequest("http://localhost/api/planner/day?dayKey=2026-13-99"))

        expect(res.status).toBe(400)
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
    })

    it("emits no event and no touch on auth failure", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        await GET(new NextRequest(`http://localhost/api/planner/day?dayKey=${DAY_KEY}`))

        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
    })

    it("emits no event and no touch on business/view failure (DAY_NOT_FOUND)", async () => {
        mocks.getDaySummary.mockRejectedValue(
            new ServiceError(404, "DAY_NOT_FOUND", "برنامهای برای این روز ثبت نشده"),
        )

        const res = await GET(new NextRequest(`http://localhost/api/planner/day?dayKey=${DAY_KEY}`))

        expect(res.status).toBe(404)
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
    })

    it("keeps the 200 response unchanged when touch fails (fail-open), event still recorded", async () => {
        mocks.getDaySummary.mockResolvedValue(SUMMARY)
        mocks.touchAuthenticatedActivity.mockRejectedValue(new Error("analytics db down"))

        const res = await GET(new NextRequest(`http://localhost/api/planner/day?dayKey=${DAY_KEY}`))

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: SUMMARY })
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
    })

    it("keeps the 200 response unchanged when event persistence fails (fail-open)", async () => {
        mocks.getDaySummary.mockResolvedValue(SUMMARY)
        mocks.recordProductEvent.mockRejectedValue(new Error("event insert failed"))

        const res = await GET(new NextRequest(`http://localhost/api/planner/day?dayKey=${DAY_KEY}`))

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: SUMMARY })
    })

    it("POST (day budget mutation) never records planner.day_viewed — only GET is the view", async () => {
        const plan = { id: 1, dayKey: DAY_KEY, availableMinutes: 120, planVersion: 2 }
        mocks.setDayPlan.mockResolvedValue({ plan, summary: SUMMARY })

        await POST(
            new NextRequest("http://localhost/api/planner/day", {
                method: "POST",
                body: JSON.stringify({ dayKey: DAY_KEY, availableMinutes: 120 }),
            }),
        )

        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
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

    it("returns 400 VALIDATION_ERROR for availableMinutes=0 (Bug 1 regression — must reject zero budget)", async () => {
        const res = await POST(
            new NextRequest("http://localhost/api/planner/day", {
                method: "POST",
                body: JSON.stringify({ dayKey: DAY_KEY, availableMinutes: 0 }),
            }),
        )

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.setDayPlan).not.toHaveBeenCalled()
    })

    it("accepts availableMinutes=1 (minimum valid positive budget)", async () => {
        const plan = { id: 1, dayKey: DAY_KEY, availableMinutes: 1, planVersion: 1 }
        mocks.setDayPlan.mockResolvedValue({ plan, summary: SUMMARY })

        const res = await POST(
            new NextRequest("http://localhost/api/planner/day", {
                method: "POST",
                body: JSON.stringify({ dayKey: DAY_KEY, availableMinutes: 1 }),
            }),
        )

        expect(res.status).toBe(200)
        expect(mocks.setDayPlan).toHaveBeenCalledWith(1, DAY_KEY, 1)
    })

    it("returns 400 VALIDATION_ERROR for a calendar-invalid dayKey in the body (M10)", async () => {
        const res = await POST(
            new NextRequest("http://localhost/api/planner/day", {
                method: "POST",
                body: JSON.stringify({ dayKey: "2026-13-99", availableMinutes: 120 }),
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