import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke test: POST /api/tasks/rollover (ADR-04).           */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    rolloverTasks: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/services/tasks.service", () => ({ rolloverTasks: mocks.rolloverTasks }))

import { POST } from "./route"
import { NoRolloverCandidatesError } from "@/app/lib/services/errors"

const USER = { id: 1, username: "test", email: "test@example.com", timezone: "Asia/Tehran" }
const MOVED = 2
const SUMMARIES = { "2026-01-01": { availableMinutes: 120, spentMinutes: 60 } }

const callPOST = (body: unknown) =>
    POST(new NextRequest("http://localhost/api/tasks/rollover", {
        method: "POST",
        body: JSON.stringify(body),
    }))

describe("POST /api/tasks/rollover", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
    })

    it("returns 200 with { ok: true, data: { moved, summaries } }", async () => {
        mocks.rolloverTasks.mockResolvedValue({ moved: MOVED, summaries: SUMMARIES })

        const res = await callPOST({ taskIds: [1, 2] })

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: { moved: MOVED, summaries: SUMMARIES } })
        expect(mocks.rolloverTasks).toHaveBeenCalledWith(1, "Asia/Tehran", [1, 2])
    })

    it("returns 400 VALIDATION_ERROR for an empty taskIds array and never calls the service", async () => {
        const res = await callPOST({ taskIds: [] })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.rolloverTasks).not.toHaveBeenCalled()
    })

    it("propagates ServiceError NO_ROLLOVER_CANDIDATES as 404", async () => {
        mocks.rolloverTasks.mockRejectedValue(new NoRolloverCandidatesError())

        const res = await callPOST({ taskIds: [1] })

        expect(res.status).toBe(404)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("NO_ROLLOVER_CANDIDATES")
    })

    it("returns 401 UNAUTHORIZED when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await callPOST({ taskIds: [1] })

        expect(res.status).toBe(401)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        })
        expect(mocks.rolloverTasks).not.toHaveBeenCalled()
    })
})