import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke test: PATCH /api/tasks/[id]/complete (ADR-04).     */
/* C2 — Time Tracking: spentMinutes (int ≥ 0), malformed JSON → 400,   */
/* ownership 404 propagation, TaskEvent/planVersion via service mock.  */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    completeTask: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/services/tasks.service", () => ({ completeTask: mocks.completeTask }))

import { PATCH } from "./route"
import { TaskAlreadyDoneError, TaskNotFoundError } from "@/app/lib/services/errors"

const USER = { id: 1, username: "test", email: "test@example.com", timezone: "Asia/Tehran" }
const TASK = { id: 5, title: "گزارش", dayKey: "2026-01-01", status: "DONE", spentMinutes: 40 }
const RESULT = { savedMinutes: 20, overspentMinutes: 0 }
const SUMMARIES = { "2026-01-01": { availableMinutes: 120, spentMinutes: 40 } }

const callPATCH = (body: unknown, id = "5") =>
    PATCH(new NextRequest(`http://localhost/api/tasks/${id}/complete`, {
        method: "PATCH",
        body: typeof body === "string" ? body : JSON.stringify(body),
    }), { params: Promise.resolve({ id }) })

describe("PATCH /api/tasks/[id]/complete", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
    })

    it("returns 200 with { ok: true, data: { task, result, summaries } }", async () => {
        mocks.completeTask.mockResolvedValue({ task: TASK, result: RESULT, summaries: SUMMARIES })

        const res = await callPATCH({ spentMinutes: 40 })

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
            ok: true,
            data: { task: TASK, result: RESULT, summaries: SUMMARIES },
        })
        expect(mocks.completeTask).toHaveBeenCalledWith(1, "Asia/Tehran", 5, { spentMinutes: 40 })
    })

    it.each([0, 45])("persists the given spentMinutes=%i (service verifies DONE/completedOn/TaskEvent)", async (spent) => {
        mocks.completeTask.mockResolvedValue({ task: { ...TASK, spentMinutes: spent }, result: RESULT, summaries: {} })

        const res = await callPATCH({ spentMinutes: spent })

        expect(res.status).toBe(200)
        expect(mocks.completeTask).toHaveBeenCalledWith(1, "Asia/Tehran", 5, { spentMinutes: spent })
    })

    it("propagates ServiceError TASK_ALREADY_DONE as 400", async () => {
        mocks.completeTask.mockRejectedValue(new TaskAlreadyDoneError())

        const res = await callPATCH({ spentMinutes: 40 })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("TASK_ALREADY_DONE")
    })

    it("propagates ServiceError TASK_NOT_FOUND as 404 (ownership/missing task)", async () => {
        mocks.completeTask.mockRejectedValue(new TaskNotFoundError())

        const res = await callPATCH({ spentMinutes: 40 })

        expect(res.status).toBe(404)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("TASK_NOT_FOUND")
    })

    it("returns 400 VALIDATION_ERROR for malformed JSON and never calls the service", async () => {
        const res = await callPATCH("not json at all")

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.completeTask).not.toHaveBeenCalled()
    })

    it.each([[-5], [17.5], ["40"], [true], [null]])("returns 400 VALIDATION_ERROR for invalid spentMinutes (%s) and never calls the service", async (spent) => {
        const res = await callPATCH({ spentMinutes: spent })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.completeTask).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR for a missing spentMinutes field and never calls the service", async () => {
        const res = await callPATCH({})

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.completeTask).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR for an invalid task id and never calls the service", async () => {
        const res = await callPATCH({ spentMinutes: 40 }, "abc")

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.completeTask).not.toHaveBeenCalled()
    })

    it("returns 401 UNAUTHORIZED when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await callPATCH({ spentMinutes: 40 })

        expect(res.status).toBe(401)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        })
        expect(mocks.completeTask).not.toHaveBeenCalled()
    })

    it("returns 500 INTERNAL_ERROR without details for unmapped service failures", async () => {
        mocks.completeTask.mockRejectedValue(new Error("db down"))

        const res = await callPATCH({ spentMinutes: 40 })

        expect(res.status).toBe(500)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("INTERNAL_ERROR")
        expect(parsed.error.message).not.toContain("db down")
    })
})
