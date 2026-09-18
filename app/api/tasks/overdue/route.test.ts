import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke test: GET /api/tasks/overdue (ADR-04).             */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    getOverdueTasks: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/services/tasks.service", () => ({ getOverdueTasks: mocks.getOverdueTasks }))

import { GET } from "./route"

describe("GET /api/tasks/overdue — X-Request-ID (فاز صفر §7)", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
    })

    it("success response carries X-Request-ID", async () => {
        mocks.getOverdueTasks.mockResolvedValue([])

        const res = await GET(new NextRequest("http://localhost/api/tasks/overdue"))

        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
    })

    it("401 response carries X-Request-ID", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await GET(new NextRequest("http://localhost/api/tasks/overdue"))

        expect(res.status).toBe(401)
        expect(res.headers.get("X-Request-ID")).toEqual(expect.any(String))
    })
})

const USER = { id: 1, username: "test", email: "test@example.com", timezone: "Asia/Tehran" }
const OVERDUE = [
    { id: 3, text: "تسک دیروز", dayKey: "2025-12-31", status: "TODO" },
    { id: 4, text: "تسک پریروز", dayKey: "2025-12-30", status: "TODO" },
]

describe("GET /api/tasks/overdue", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
    })

    it("returns 200 with { ok: true, data: tasks }", async () => {
        mocks.getOverdueTasks.mockResolvedValue(OVERDUE)

        const res = await GET(new NextRequest("http://localhost/api/tasks/overdue"))

        expect(res.status).toBe(200)
        await expect(res.json()).resolves.toEqual({ ok: true, data: OVERDUE })
        expect(mocks.getOverdueTasks).toHaveBeenCalledWith(1, "Asia/Tehran")
    })

    it("returns 401 UNAUTHORIZED when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await GET(new NextRequest("http://localhost/api/tasks/overdue"))

        expect(res.status).toBe(401)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        })
        expect(mocks.getOverdueTasks).not.toHaveBeenCalled()
    })
})