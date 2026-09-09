import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke test: GET /api/planner/history (ADR-04).           */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    getHistoryMarkers: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/services/planner.service", () => ({ getHistoryMarkers: mocks.getHistoryMarkers }))

import { GET } from "./route"

const USER = { id: 1, username: "test", email: "test@example.com", timezone: "Asia/Tehran" }
const MARKERS = [
    { dayKey: "2026-01-01", hasPlan: true },
    { dayKey: "2026-01-02", hasPlan: false },
]

describe("GET /api/planner/history", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
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
})