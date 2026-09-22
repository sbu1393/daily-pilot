import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke test: GET /api/tasks/reminders (ADR-04).           */
/* getCurrentUser + tasks.service mocked: no DB.                      */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    getDueReminders: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/services/tasks.service", () => ({ getDueReminders: mocks.getDueReminders }))

import { GET } from "./route"

const USER = { id: 1, username: "test", email: "test@example.com", timezone: "Asia/Tehran" }
const DUE = [
    { id: 7, title: "تماس با مشتری", reminderAt: "2026-01-01T11:00:00.000Z", status: "TODO" },
]

describe("GET /api/tasks/reminders", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
    })

    it("returns 200 with { ok: true, data: tasks } scoped to the current user", async () => {
        mocks.getDueReminders.mockResolvedValue(DUE)

        const res = await GET(new NextRequest("http://localhost/api/tasks/reminders"))

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: DUE })
        expect(mocks.getDueReminders).toHaveBeenCalledWith(1)
    })

    it("returns 401 UNAUTHORIZED when not authenticated and never calls the service", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await GET(new NextRequest("http://localhost/api/tasks/reminders"))

        expect(res.status).toBe(401)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        })
        expect(mocks.getDueReminders).not.toHaveBeenCalled()
    })
})
