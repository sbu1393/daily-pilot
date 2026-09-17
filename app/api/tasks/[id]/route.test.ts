import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke tests: GET + PATCH + DELETE /api/tasks/[id].       */
/* C1: GET (خواندن تک) اضافه شد؛ PATCH فیلدهای title/status/            */
/*     scheduledDate/category را می‌پذیرد.                              */
/* getTask/updateTask/deleteTask mocked: no DB, no rebalance engine.   */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    getTask: vi.fn(),
    updateTask: vi.fn(),
    deleteTask: vi.fn(),
    touchAuthenticatedActivity: vi.fn(),
    recordProductEvent: vi.fn(),
    getPrisma: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/services/tasks.service", () => ({
    getTask: mocks.getTask,
    updateTask: mocks.updateTask,
    deleteTask: mocks.deleteTask,
}))
vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: mocks.getPrisma }))
vi.mock("@/app/lib/services/userActivity.service", () => ({
    touchAuthenticatedActivity: mocks.touchAuthenticatedActivity,
}))
vi.mock("@/app/lib/services/productEvent.service", () => ({
    recordProductEvent: mocks.recordProductEvent,
}))

import { DELETE, GET, PATCH } from "./route"
import { TaskNotFoundError } from "@/app/lib/services/errors"

const USER = { id: 1, username: "test", email: "test@example.com", timezone: "Asia/Tehran" }
const TASK = { id: 5, title: "گزارش", dayKey: "2026-01-01", category: "Work" }
const SUMMARY = { dayKey: "2026-01-01", availableMinutes: 120, spentMinutes: 40 }

const callGET = (id = "5") =>
    GET(new NextRequest(`http://localhost/api/tasks/${id}`), {
        params: Promise.resolve({ id }),
    })

const callPATCH = (body: unknown, id = "5") =>
    PATCH(new NextRequest(`http://localhost/api/tasks/${id}`, {
        method: "PATCH",
        body: body === undefined ? undefined : JSON.stringify(body),
    }), { params: Promise.resolve({ id }) })

const callDELETE = (id = "5") =>
    DELETE(new NextRequest(`http://localhost/api/tasks/${id}`, { method: "DELETE" }), {
        params: Promise.resolve({ id }),
    })

describe("GET /api/tasks/[id]", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
    })

    it("returns 200 with { ok: true, data: task } and forwards userId + taskId", async () => {
        mocks.getTask.mockResolvedValue(TASK)

        const res = await callGET()

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: TASK })
        expect(mocks.getTask).toHaveBeenCalledWith(1, 5)
    })

    it("returns 400 VALIDATION_ERROR for an invalid id and never calls the service", async () => {
        const res = await callGET("abc")

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.getTask).not.toHaveBeenCalled()
    })

    it("propagates ServiceError TASK_NOT_FOUND as 404 (ownership failure included)", async () => {
        mocks.getTask.mockRejectedValue(new TaskNotFoundError())

        const res = await callGET()

        expect(res.status).toBe(404)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("TASK_NOT_FOUND")
    })

    it("returns 401 UNAUTHORIZED when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await callGET()

        expect(res.status).toBe(401)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        })
        expect(mocks.getTask).not.toHaveBeenCalled()
    })
})

describe("PATCH /api/tasks/[id]", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
        mocks.touchAuthenticatedActivity.mockResolvedValue({ touched: true })
        mocks.recordProductEvent.mockResolvedValue({ recorded: true, eventName: "task.updated" })
        mocks.getPrisma.mockReturnValue({})
    })

    it("returns 200 with { ok: true, data: task, message } and forwards the edit input", async () => {
        mocks.updateTask.mockResolvedValue({ task: TASK })

        const res = await callPATCH({ title: "عنوان جدید" })

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
            ok: true,
            data: TASK,
            message: expect.any(String),
        })
        expect(mocks.updateTask).toHaveBeenCalledWith(1, "Asia/Tehran", 5, { title: "عنوان جدید" })
    })

    it("forwards status and category edits to the service", async () => {
        mocks.updateTask.mockResolvedValue({ task: TASK })

        const res = await callPATCH({ status: "IN_PROGRESS", category: "Health" })

        expect(res.status).toBe(200)
        expect(mocks.updateTask).toHaveBeenCalledWith(1, "Asia/Tehran", 5, {
            status: "IN_PROGRESS",
            category: "Health",
        })
    })

    it("returns 400 VALIDATION_ERROR for an empty body (refine: no change) and never calls the service", async () => {
        const res = await callPATCH(undefined)

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.updateTask).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR for a malformed scheduledDate in the body", async () => {
        const res = await callPATCH({ scheduledDate: "2026-1-1" })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.updateTask).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR for malformed JSON (not 500) and never calls the service", async () => {
        const res = await PATCH(
            new NextRequest("http://localhost/api/tasks/5", {
                method: "PATCH",
                body: "this is not json",
            }),
            { params: Promise.resolve({ id: "5" }) },
        )

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.updateTask).not.toHaveBeenCalled()
    })

    it("propagates ServiceError TASK_NOT_FOUND as 404", async () => {
        mocks.updateTask.mockRejectedValue(new TaskNotFoundError())

        const res = await callPATCH({ title: "عنوان جدید" })

        expect(res.status).toBe(404)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("TASK_NOT_FOUND")
    })

    it("returns 401 UNAUTHORIZED when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await callPATCH({ title: "عنوان جدید" })

        expect(res.status).toBe(401)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        })
        expect(mocks.updateTask).not.toHaveBeenCalled()
    })

    /* فاز ۳ — گام ۸: integration تحلیل (touch + task.updated، فقط برای changed). */

    it("touches activity and records task.updated for a title-only mutation (changed=true)", async () => {
        mocks.updateTask.mockResolvedValue({ task: { ...TASK, title: "عنوان جدید" }, changed: true, changedFields: ["title"] })

        const res = await callPATCH({ title: "عنوان جدید" })

        expect(res.status).toBe(200)
        expect(mocks.touchAuthenticatedActivity).toHaveBeenCalledTimes(1)
        expect(mocks.recordProductEvent).toHaveBeenCalledTimes(1)
        expect(mocks.recordProductEvent).toHaveBeenCalledWith(
            1,
            "task.updated",
            { taskId: 5, changedFields: ["title"] },
            expect.objectContaining({ requestId: expect.any(String), feature: "tasks" }),
        )
    })

    it("records task.updated for a category-only mutation with changedFields=[category]", async () => {
        mocks.updateTask.mockResolvedValue({ task: { ...TASK, category: "Health" }, changed: true, changedFields: ["category"] })

        const res = await callPATCH({ category: "Health" })

        expect(res.status).toBe(200)
        expect(mocks.recordProductEvent).toHaveBeenCalledWith(
            1,
            "task.updated",
            { taskId: 5, changedFields: ["category"] },
            expect.anything(),
        )
    })

    it("records task.updated for a status-only mutation with changedFields=[status]", async () => {
        mocks.updateTask.mockResolvedValue({ task: { ...TASK, status: "IN_PROGRESS" }, changed: true, changedFields: ["status"] })

        const res = await callPATCH({ status: "IN_PROGRESS" })

        expect(res.status).toBe(200)
        expect(mocks.recordProductEvent).toHaveBeenCalledWith(
            1,
            "task.updated",
            { taskId: 5, changedFields: ["status"] },
            expect.anything(),
        )
    })

    it("records task.updated for a day-only mutation with changedFields=[day]", async () => {
        mocks.updateTask.mockResolvedValue({ task: { ...TASK, dayKey: "2026-01-02" }, changed: true, changedFields: ["day"] })

        const res = await callPATCH({ scheduledDate: "2026-01-02" })

        expect(res.status).toBe(200)
        expect(mocks.recordProductEvent).toHaveBeenCalledWith(
            1,
            "task.updated",
            { taskId: 5, changedFields: ["day"] },
            expect.anything(),
        )
    })

    it("emits no event and no touch for a true no-op (changed=false)", async () => {
        mocks.updateTask.mockResolvedValue({ task: TASK, changed: false, changedFields: [] })

        const res = await callPATCH({ title: "گزارش" }) // same as current

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({
            ok: true,
            data: TASK,
            message: expect.any(String),
        })
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
    })

    it("emits no event and no touch when the update fails (TASK_NOT_FOUND)", async () => {
        mocks.updateTask.mockRejectedValue(new TaskNotFoundError())

        const res = await callPATCH({ title: "عنوان جدید" })

        expect(res.status).toBe(404)
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
    })

    it("event properties contain only taskId and field names — task content never reaches analytics", async () => {
        mocks.updateTask.mockResolvedValue({
            task: { ...TASK, title: "خرید نان و لبنیات با جزئیات حساس", dayKey: "2026-01-02" },
            changed: true,
            changedFields: ["title", "day"],
        })

        const res = await callPATCH({ title: "خرید نان و لبنیات با جزئیات حساس", scheduledDate: "2026-01-02" })

        expect(res.status).toBe(200)
        expect(mocks.recordProductEvent).toHaveBeenCalledTimes(1)
        const args = JSON.stringify(mocks.recordProductEvent.mock.calls[0])
        expect(args).not.toContain("خرید نان")
        expect(args).not.toContain("جزئیات حساس")
        const props = mocks.recordProductEvent.mock.calls[0][2]
        expect(Object.keys(props).sort()).toEqual(["changedFields", "taskId"])
        expect(props.changedFields).toEqual(["title", "day"]) // فقط نام فیلدها، نه مقادیر
    })

    it("propagates the requestId to the analytics context (correlation only, non-unique)", async () => {
        mocks.updateTask.mockResolvedValue({ task: TASK, changed: true, changedFields: ["title"] })

        await callPATCH({ title: "عنوان جدید" })

        expect(mocks.recordProductEvent).toHaveBeenCalledWith(
            1,
            "task.updated",
            expect.anything(),
            expect.objectContaining({ requestId: expect.any(String) }),
        )
        // requestId فقط correlation — هیچ dedup محور نیست
        const ctx = mocks.recordProductEvent.mock.calls[0][3]
        expect(ctx.endpoint).toBe("/api/tasks/[id]")
        expect(ctx.feature).toBe("tasks")
    })

    it("keeps the 200 update response unchanged when analytics fails (fail-open)", async () => {
        mocks.updateTask.mockResolvedValue({ task: { ...TASK, title: "عنوان جدید" }, changed: true, changedFields: ["title"] })
        mocks.touchAuthenticatedActivity.mockRejectedValue(new Error("analytics db down"))

        const res = await callPATCH({ title: "عنوان جدید" })

        expect(res.status).toBe(200)
        const parsed = await res.json()
        expect(parsed.ok).toBe(true)
        expect(parsed.data.title).toBe("عنوان جدید")
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
    })

    it("keeps the 200 response when recordProductEvent itself fails (fail-open)", async () => {
        mocks.updateTask.mockResolvedValue({ task: { ...TASK, title: "عنوان جدید" }, changed: true, changedFields: ["title"] })
        mocks.recordProductEvent.mockRejectedValue(new Error("event insert failed"))

        const res = await callPATCH({ title: "عنوان جدید" })

        expect(res.status).toBe(200)
        const parsed = await res.json()
        expect(parsed.ok).toBe(true)
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

    /* فاز ۳ — گام ۷: integration analysis (touch + task.deleted) */

    it("touches activity and records task.deleted with taskId only after successful delete", async () => {
        mocks.deleteTask.mockResolvedValue({ id: 5, summary: SUMMARY })

        const res = await callDELETE()

        expect(res.status).toBe(200)
        expect(mocks.touchAuthenticatedActivity).toHaveBeenCalledTimes(1)
        expect(mocks.recordProductEvent).toHaveBeenCalledTimes(1)
        expect(mocks.recordProductEvent).toHaveBeenCalledWith(
            1,
            "task.deleted",
            { taskId: 5 }, // فقط allowlist — هیچ title/category
            expect.objectContaining({ requestId: expect.any(String), feature: "tasks" }),
        )
        const args = JSON.stringify(mocks.recordProductEvent.mock.calls[0])
        expect(args).not.toContain("گزارش")
    })

    it("emits no event and no touch when the delete fails (TASK_NOT_FOUND)", async () => {
        mocks.deleteTask.mockRejectedValue(new TaskNotFoundError())

        const res = await callDELETE()

        expect(res.status).toBe(404)
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
        expect(mocks.touchAuthenticatedActivity).not.toHaveBeenCalled()
    })

    it("keeps the 200 delete response unchanged when analytics fails (fail-open)", async () => {
        mocks.deleteTask.mockResolvedValue({ id: 5, summary: SUMMARY })
        mocks.touchAuthenticatedActivity.mockRejectedValue(new Error("analytics db down"))

        const res = await callDELETE()

        expect(res.status).toBe(200)
        const parsed = await res.json()
        expect(parsed.ok).toBe(true)
        expect(parsed.data.id).toBe(5)
        expect(mocks.recordProductEvent).not.toHaveBeenCalled()
    })
})