import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke tests: POST/GET /api/tasks (ADR-04 controller).    */
/* getCurrentUser + tasks.service + canonicalDay mocked: no DB.        */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    createTask: vi.fn(),
    getDayTasks: vi.fn(),
    getCanonicalToday: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/services/tasks.service", () => ({
    createTask: mocks.createTask,
    getDayTasks: mocks.getDayTasks,
}))
vi.mock("@/app/lib/canonicalDay", () => ({ getCanonicalToday: mocks.getCanonicalToday }))

import { GET, POST } from "./route"
import { MissingDayKeyError } from "@/app/lib/services/errors"

const USER = { id: 1, username: "test", email: "test@example.com", timezone: "Asia/Tehran" }
const DAY_KEY = "2026-01-01"
const TASK = { id: 10, text: "خرید نان", dayKey: DAY_KEY }

describe("POST /api/tasks", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
    })

    it("returns 201 with the ADR-04 envelope { ok: true, data: { task } }", async () => {
        mocks.createTask.mockResolvedValue({ task: TASK })

        const res = await POST(
            new NextRequest("http://localhost/api/tasks", {
                method: "POST",
                body: JSON.stringify({ text: TASK.text, dayKey: DAY_KEY }),
            }),
        )

        expect(res.status).toBe(201)
        await expect(res.json()).resolves.toEqual({ ok: true, data: { task: TASK } })
        expect(mocks.createTask).toHaveBeenCalledWith(1, "Asia/Tehran", {
            text: TASK.text,
            dayKey: DAY_KEY,
        })
    })

    it("returns 400 VALIDATION_ERROR for an invalid body and never calls the service", async () => {
        const res = await POST(
            new NextRequest("http://localhost/api/tasks", {
                method: "POST",
                body: JSON.stringify({ text: "ab" }), // <3 chars + missing dayKey
            }),
        )

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(parsed.error.errors).toBeDefined()
        expect(mocks.createTask).not.toHaveBeenCalled()
    })

    it("propagates a ServiceError (MISSING_DAY_KEY) with its status and code", async () => {
        mocks.createTask.mockRejectedValue(new MissingDayKeyError())

        const res = await POST(
            new NextRequest("http://localhost/api/tasks", {
                method: "POST",
                body: JSON.stringify({ text: "خرید نان", dayKey: DAY_KEY }),
            }),
        )

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed).toEqual({
            ok: false,
            error: { code: "MISSING_DAY_KEY", message: expect.any(String) },
        })
    })

    it("returns 401 UNAUTHORIZED when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await POST(
            new NextRequest("http://localhost/api/tasks", {
                method: "POST",
                body: JSON.stringify({ text: "خرید نان", dayKey: DAY_KEY }),
            }),
        )

        expect(res.status).toBe(401)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        })
        expect(mocks.createTask).not.toHaveBeenCalled()
    })
})

describe("GET /api/tasks", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
        mocks.getCanonicalToday.mockReturnValue(DAY_KEY)
    })

    it("returns 200 with { ok: true, data: { tasks, summary } } for an explicit dayKey", async () => {
        const summary = { dayKey: DAY_KEY, availableMinutes: 120, spentMinutes: 30 }
        mocks.getDayTasks.mockResolvedValue({ tasks: [TASK], summary })

        const res = await GET(new NextRequest(`http://localhost/api/tasks?dayKey=${DAY_KEY}`))

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: { tasks: [TASK], summary } })
        expect(mocks.getDayTasks).toHaveBeenCalledWith(1, DAY_KEY)
    })

    it("defaults to getCanonicalToday(user.timezone) when dayKey is omitted", async () => {
        mocks.getDayTasks.mockResolvedValue({ tasks: [], summary: null })

        const res = await GET(new NextRequest("http://localhost/api/tasks"))

        expect(mocks.getCanonicalToday).toHaveBeenCalledWith("Asia/Tehran")
        expect(mocks.getDayTasks).toHaveBeenCalledWith(1, DAY_KEY)
        expect(res.status).toBe(200)
    })

    it("returns 400 VALIDATION_ERROR for a malformed dayKey and never calls the service", async () => {
        const res = await GET(new NextRequest("http://localhost/api/tasks?dayKey=2026-1-1"))

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.getDayTasks).not.toHaveBeenCalled()
    })

    it("returns 401 UNAUTHORIZED when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await GET(new NextRequest(`http://localhost/api/tasks?dayKey=${DAY_KEY}`))

        expect(res.status).toBe(401)
        expect(mocks.getDayTasks).not.toHaveBeenCalled()
    })
})