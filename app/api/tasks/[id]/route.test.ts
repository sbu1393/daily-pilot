import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke tests: PATCH + DELETE /api/tasks/[id] (ADR-04).    */
/* updateTask/deleteTask mocked: no DB, no rebalance engine.           */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/services/tasks.service", () => ({
    updateTask: mocks.updateTask,
    deleteTask: mocks.deleteTask,
}))

import { DELETE, PATCH } from "./route"
import { TaskNotFoundError } from "@/app/lib/services/errors"

const USER = { id: 1, username: "test", email: "test@example.com", timezone: "Asia/Tehran" }
const TASK = { id: 5, text: "گزارش", dayKey: "2026-01-01", category: "Work" }
const SUMMARY = { dayKey: "2026-01-01", availableMinutes: 120, spentMinutes: 40 }

const callPATCH = (body: unknown, id = "5") =>
    PATCH(new NextRequest(`http://localhost/api/tasks/${id}`, {
        method: "PATCH",
        body: body === undefined ? undefined : JSON.stringify(body),
    }), { params: Promise.resolve({ id }) })

const callDELETE = (id = "5") =>
    DELETE(new NextRequest(`http://localhost/api/tasks/${id}`, { method: "DELETE" }), {
        params: Promise.resolve({ id }),
    })

describe("PATCH /api/tasks/[id]", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
    })

    it("returns 200 with { ok: true, data: task, message } and forwards the edit input", async () => {
        mocks.updateTask.mockResolvedValue({ task: TASK })

        const res = await callPATCH({ text: "عنوان جدید" })

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
            ok: true,
            data: TASK,
            message: expect.any(String),
        })
        expect(mocks.updateTask).toHaveBeenCalledWith(1, "Asia/Tehran", 5, { text: "عنوان جدید" })
    })

    it("returns 400 VALIDATION_ERROR for an empty body (refine: no change) and never calls the service", async () => {
        const res = await callPATCH(undefined)

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.updateTask).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR for a malformed dayKey in the body", async () => {
        const res = await callPATCH({ dayKey: "2026-1-1" })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.updateTask).not.toHaveBeenCalled()
    })

    it("propagates ServiceError TASK_NOT_FOUND as 404", async () => {
        mocks.updateTask.mockRejectedValue(new TaskNotFoundError())

        const res = await callPATCH({ text: "عنوان جدید" })

        expect(res.status).toBe(404)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("TASK_NOT_FOUND")
    })

    it("returns 401 UNAUTHORIZED when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await callPATCH({ text: "عنوان جدید" })

        expect(res.status).toBe(401)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        })
        expect(mocks.updateTask).not.toHaveBeenCalled()
    })
})

describe("DELETE /api/tasks/[id]", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
    })

    it("returns 200 with { ok: true, data: { id, summary }, message }", async () => {
        mocks.deleteTask.mockResolvedValue({ id: 5, summary: SUMMARY })

        const res = await callDELETE()

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
            ok: true,
            data: { id: 5, summary: SUMMARY },
            message: "تسک حذف شد",
        })
        expect(mocks.deleteTask).toHaveBeenCalledWith(1, 5)
    })

    it("returns 400 VALIDATION_ERROR for an invalid id and never calls the service", async () => {
        const res = await callDELETE("abc")

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.deleteTask).not.toHaveBeenCalled()
    })

    it("propagates ServiceError TASK_NOT_FOUND as 404", async () => {
        mocks.deleteTask.mockRejectedValue(new TaskNotFoundError())

        const res = await callDELETE()

        expect(res.status).toBe(404)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("TASK_NOT_FOUND")
    })

    it("returns 401 UNAUTHORIZED when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await callDELETE()

        expect(res.status).toBe(401)
        expect(mocks.deleteTask).not.toHaveBeenCalled()
    })
})