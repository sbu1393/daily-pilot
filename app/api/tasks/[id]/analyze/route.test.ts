import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke test: PATCH /api/tasks/[id]/analyze (ADR-04).      */
/* C3 — AI analysis: reanalyzeTask mocked (no real AI calls).          */
/*Malformed JSON → 400 (P2 convention), 404 ownership propagation.     */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    isRateLimited: vi.fn(),
    reanalyzeTask: vi.fn(),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/rateLimit", () => ({ isRateLimited: mocks.isRateLimited }))
vi.mock("@/app/lib/services/tasks.service", () => ({ reanalyzeTask: mocks.reanalyzeTask }))

import { PATCH } from "./route"
import { TaskNotAnalyzeableError, TaskNotFoundError } from "@/app/lib/services/errors"

const USER = { id: 1, username: "test", email: "test@example.com", timezone: "Asia/Tehran" }
const TASK = { id: 5, text: "گزارش", dayKey: "2026-01-01", status: "TODO" }

const callPATCH = (body: unknown, id = "5") =>
    PATCH(new NextRequest(`http://localhost/api/tasks/${id}/analyze`, {
        method: "PATCH",
        body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }), { params: Promise.resolve({ id }) })

describe("PATCH /api/tasks/[id]/analyze", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
        mocks.isRateLimited.mockReturnValue(false)
    })

    it("returns 200 with { ok: true, data: { task, aiSource } } and no summary key (A6)", async () => {
        mocks.reanalyzeTask.mockResolvedValue({ task: TASK, aiSource: "1xai" })

        const res = await callPATCH({})

        expect(res.status).toBe(200)
        const parsed = await res.json()
        expect(parsed).toEqual({ ok: true, data: { task: TASK, aiSource: "1xai" } })
        expect(parsed.data).not.toHaveProperty("summary")
        // بدون text → متن فعلی تسک دوباره تحلیل میشود
        expect(mocks.reanalyzeTask).toHaveBeenCalledWith(1, "Asia/Tehran", 5, undefined)
        expect(mocks.isRateLimited).toHaveBeenCalledWith("analyze:user:1", 5, 15 * 60 * 1000)
    })

    it("returns 429 RATE_LIMITED and never calls reanalyzeTask when the user limit is exhausted", async () => {
        mocks.isRateLimited.mockReturnValue(true)

        const res = await callPATCH({})

        expect(res.status).toBe(429)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: {
                code: "RATE_LIMITED",
                message: "تعداد درخواست‌های هوش مصنوعی زیاد شده؛ کمی بعد دوباره تلاش کن",
            },
        })
        expect(mocks.isRateLimited).toHaveBeenCalledWith("analyze:user:1", 5, 15 * 60 * 1000)
        expect(mocks.reanalyzeTask).not.toHaveBeenCalled()
    })

    it("forwards the explicit text override when provided", async () => {
        mocks.reanalyzeTask.mockResolvedValue({ task: TASK, aiSource: "mock" })

        const res = await callPATCH({ text: "گزارش فروش هفتگی" })

        expect(res.status).toBe(200)
        expect(mocks.reanalyzeTask).toHaveBeenCalledWith(1, "Asia/Tehran", 5, "گزارش فروش هفتگی")
    })

    it("propagates ServiceError TASK_NOT_ANALYZEABLE (DONE) as 400", async () => {
        mocks.reanalyzeTask.mockRejectedValue(new TaskNotAnalyzeableError("DONE"))

        const res = await callPATCH({})

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("TASK_NOT_ANALYZEABLE")
        expect(parsed.error.message).toEqual(expect.any(String))
    })

    it("propagates ServiceError TASK_NOT_FOUND as 404 for a missing or foreign task (ownership)", async () => {
        mocks.reanalyzeTask.mockRejectedValue(new TaskNotFoundError())

        const res = await callPATCH({})

        expect(res.status).toBe(404)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("TASK_NOT_FOUND")
    })

    it("returns 400 VALIDATION_ERROR for an invalid body (text too short)", async () => {
        const res = await callPATCH({ text: "ab" })

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.reanalyzeTask).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR for malformed JSON and never calls the service", async () => {
        const res = await callPATCH("not json at all")

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.reanalyzeTask).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR for an absent JSON body (strict ADR-04 convention)", async () => {
        const res = await callPATCH(undefined)

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.reanalyzeTask).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR for an invalid task id and never calls the service", async () => {
        const res = await callPATCH({}, "0")

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.reanalyzeTask).not.toHaveBeenCalled()
    })

    it("returns 401 UNAUTHORIZED when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await callPATCH({})

        expect(res.status).toBe(401)
        await expect(res.json()).resolves.toEqual({
            ok: false,
            error: { code: "UNAUTHORIZED", message: "Unauthorized" },
        })
        expect(mocks.reanalyzeTask).not.toHaveBeenCalled()
    })
})
