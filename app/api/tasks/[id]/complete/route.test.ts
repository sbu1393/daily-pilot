import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke test: PATCH /api/tasks/[id]/complete (ADR-04).     */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    completeTask: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/services/tasks.service", () => ({ completeTask: mocks.completeTask }))

import { PATCH } from "./route"
import { TaskAlreadyDoneError } from "@/app/lib/services/errors"

const USER = { id: 1, username: "test", email: "test@example.com", timezone: "Asia/Tehran" }
const TASK = { id: 5, text: "گزارش", dayKey: "2026-01-01", status: "DONE" }
const RESULT = { savedMinutes: 20, overspentMinutes: 0 }
const SUMMARIES = { "2026-01-01": { availableMinutes: 120, spentMinutes: 40 } }

const callPATCH = (body: unknown, id = "5") =>
    PATCH(new NextRequest(`http://localhost/api/tasks/${id}/complete`, {
        method: "PATCH",
        body: JSON.stringify(body),
    }), { params: Promise.resolve({ id }) })

describe("PATCH /api/tasks/[id]/complete", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
    })

    it("returns 200 with { ok: true, data: { task, result, summaries } }", async () => {
        mocks.completeTask.mockResolvedValue({ task: TASK, result: RESULT, summaries: SUMMARIES })

        const res = await callPATCH({ durationMinutes: 40 })

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
            ok: true,
            data: { task: TASK, result: RESULT, summaries: SUMMARIES },
        })
        expect(mocks.completeTask).toHaveBeenCalledWith(1, "Asia/Tehran", 5, 40)
    })

    it("propagates ServiceError TASK_ALREADY_DONE as 400", async () => {
        mocks.completeTask.mockRejectedValue(new TaskAlreadyDoneError())

        const res = await callPATCH({ durationMinutes: 40 })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("TASK_ALREADY_DONE")
    })

    it("returns 400 VALIDATION_ERROR for invalid durationMinutes and never calls the service", async () => {
        const res = await callPATCH({ durationMinutes: 0 }) // < 1 دقیقه

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.completeTask).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR for an invalid task id and never calls the service", async () => {
        const res = await callPATCH({ durationMinutes: 40 }, "abc")

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.completeTask).not.toHaveBeenCalled()
    })

    it("returns 401 UNAUTHORIZED when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await callPATCH({ durationMinutes: 40 })

        expect(res.status).toBe(401)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        })
        expect(mocks.completeTask).not.toHaveBeenCalled()
    })
})