import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/* ------------------------------------------------------------------ */
/* B1 — Route smoke tests: POST/GET /api/tasks (ADR-04 controller).    */
/* C1: بدنه‌ی ساخت = title + scheduledDate؛ dayKey سمت سرور ساخته می‌شود. */
/* getCurrentUser + tasks.service + canonicalDay mocked: no DB.        */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getCurrentUser: vi.fn(),
    createTask: vi.fn(),
    getDayTasks: vi.fn(),
    getCanonicalToday: vi.fn(),
    buildAdvisor: vi.fn(),
    // پیاده‌سازی واقعی — در فکتوری ماژول موک گرفته می‌شود
    realBuildAdvisor: null as null |
        ((
            tasks: import("@/app/lib/planner/advisor").AdvisorTaskInput[],
            opts: { displayName: string; availableMinutes: number | null },
        ) => import("@/app/lib/planner/advisor").AdvisorResult),
}))

vi.mock("@/app/lib/getCurrentUser", () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock("@/app/lib/services/tasks.service", () => ({
    createTask: mocks.createTask,
    getDayTasks: mocks.getDayTasks,
}))
vi.mock("@/app/lib/canonicalDay", () => ({ getCanonicalToday: mocks.getCanonicalToday }))
// Advisor: واقعی به‌صورت پیش‌فرض (pass-through) — فقط تست خطا mock را override می‌کند
vi.mock("@/app/lib/planner/advisor", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/app/lib/planner/advisor")>()
    mocks.realBuildAdvisor = actual.buildAdvisor
    return { ...actual, buildAdvisor: mocks.buildAdvisor }
})

import { GET, POST } from "./route"
import { ServiceError } from "@/app/lib/services/errors"

const USER = { id: 1, username: "test", email: "test@example.com", timezone: "Asia/Tehran" }
const DAY_KEY = "2026-01-01"
const SCHEDULED_DATE = "2026-01-01T00:00:00.000Z"
const TASK = { id: 10, title: "خرید نان", dayKey: DAY_KEY }
describe("POST /api/tasks", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
    })

    it("returns 201 with the ADR-04 envelope { ok: true, data: { task } } and forwards title + scheduledDate", async () => {
        mocks.createTask.mockResolvedValue({ task: TASK })

        const res = await POST(
            new NextRequest("http://localhost/api/tasks", {
                method: "POST",
                body: JSON.stringify({ title: TASK.title, scheduledDate: SCHEDULED_DATE }),
            }),
        )

        expect(res.status).toBe(201)
        await expect(res.json()).resolves.toEqual({ ok: true, data: { task: TASK } })
        // dayKey از Client پذیرفته نمی‌شود (§6.2.2.1) — فقط title + scheduledDate به سرویس می‌رود
        expect(mocks.createTask).toHaveBeenCalledWith(1, "Asia/Tehran", {
            title: TASK.title,
            scheduledDate: new Date(SCHEDULED_DATE),
        })
    })

    it("returns 400 VALIDATION_ERROR for an invalid body and never calls the service", async () => {
        const res = await POST(
            new NextRequest("http://localhost/api/tasks", {
                method: "POST",
                body: JSON.stringify({ title: "" }), // title خالی + missing scheduledDate
            }),
        )

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(parsed.error.errors).toBeDefined()
        expect(mocks.createTask).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR for an invalid scheduledDate and never calls the service", async () => {
        const res = await POST(
            new NextRequest("http://localhost/api/tasks", {
                method: "POST",
                body: JSON.stringify({ title: "خرید نان", scheduledDate: "not-a-date" }),
            }),
        )

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.createTask).not.toHaveBeenCalled()
    })

    it("returns 400 VALIDATION_ERROR for malformed JSON (not 500) and never calls the service", async () => {
        const res = await POST(
            new NextRequest("http://localhost/api/tasks", {
                method: "POST",
                body: "this is not json",
            }),
        )

        expect(res.status).toBe(400)
        const parsed = await res.json()
        expect(parsed.ok).toBe(false)
        expect(parsed.error.code).toBe("VALIDATION_ERROR")
        expect(mocks.createTask).not.toHaveBeenCalled()
    })

    it("propagates a ServiceError with its status and code", async () => {
        mocks.createTask.mockRejectedValue(new ServiceError(409, "PLAN_CONFLICT", "test"))

        const res = await POST(
            new NextRequest("http://localhost/api/tasks", {
                method: "POST",
                body: JSON.stringify({ title: "خرید نان", scheduledDate: SCHEDULED_DATE }),
            }),
        )

        expect(res.status).toBe(409)
        const parsed = await res.json()
        expect(parsed).toEqual({
            ok: false,
            error: { code: "PLAN_CONFLICT", message: expect.any(String) },
        })
    })

    it("returns 401 UNAUTHORIZED when not authenticated", async () => {
        mocks.getCurrentUser.mockResolvedValue(null)

        const res = await POST(
            new NextRequest("http://localhost/api/tasks", {
                method: "POST",
                body: JSON.stringify({ title: "خرید نان", scheduledDate: SCHEDULED_DATE }),
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
    // ترتیب سرویس عمداً با ترتیبِ advisor فرق دارد تا حفظِ ترتیب اصلی اثبات شود
    const GET_TASKS = [
        { id: 30, title: "کار سی", status: "DONE", priority: "HIGH", score: 90, estimatedTime: 60, allocatedMinutes: 45 },
        { id: 10, title: "کار ده", status: "TODO", priority: "MEDIUM", score: 50, estimatedTime: 30, allocatedMinutes: 20 },
        { id: 20, title: "کار بیست", status: "IN_PROGRESS", priority: "LOW", score: 40, estimatedTime: 45, allocatedMinutes: null },
    ]
    const GET_SUMMARY = { dayKey: DAY_KEY, openBudgetMinutes: 90 }

    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getCurrentUser.mockResolvedValue(USER)
        mocks.getCanonicalToday.mockReturnValue(DAY_KEY)
        // پیش‌فرض: advisor واقعی (pass-through) — هر تست در صورت نیاز override می‌کند
        mocks.buildAdvisor.mockReset()
        mocks.buildAdvisor.mockImplementation(
            (
                tasks: import("@/app/lib/planner/advisor").AdvisorTaskInput[],
                opts: { displayName: string; availableMinutes: number | null },
            ) => mocks.realBuildAdvisor?.(tasks, opts),
        )
    })

    it("returns 200 with { ok: true, data: { tasks, summary, advisor } } keeping the original task order", async () => {
        mocks.getDayTasks.mockResolvedValue({ tasks: GET_TASKS, summary: GET_SUMMARY })

        const res = await GET(new NextRequest(`http://localhost/api/tasks?dayKey=${DAY_KEY}`))

        expect(res.status).toBe(200)
        const parsed = await res.json()

        // ترتیب آرایه‌ی tasks دست‌نخورده می‌ماند (سرویس: 30,10,20 — advisor: 20,10,30)
        expect(parsed.data.tasks.map((t: { id: number }) => t.id)).toEqual([30, 10, 20])
        expect(parsed.data.tasks).toEqual(GET_TASKS)
        expect(parsed.data.summary).toEqual(GET_SUMMARY)

        // advisor همان داده‌ها را با ترتیبِ خودش تحویل می‌دهد (قفل قرارداد Part 2)
        expect(parsed.data.advisor).toEqual({
            orderedTaskIds: [20, 10, 30],
            nextTaskId: 20,
            items: [
                { taskId: 20, rank: 1, estimatedMinutes: 45, focusMinutes: 45, pauseAfterMinutes: 75, reason: "در حال انجام — اول ادامه‌اش بده" },
                { taskId: 10, rank: 2, estimatedMinutes: 30, focusMinutes: 30, pauseAfterMinutes: 60, reason: "اولویت متوسط" },
                { taskId: 30, rank: 3, estimatedMinutes: 60, focusMinutes: 60, pauseAfterMinutes: 90, reason: "انجام شده" },
            ],
            totalEstimatedMinutes: 135,
            overflowTaskIds: [],
            message: "test جان، پیشنهاد من اینه که با تسک «کار بیست» شروع کنی.",
        })
        expect(mocks.buildAdvisor).toHaveBeenCalledWith(GET_TASKS, {
            displayName: "test",
            availableMinutes: 90,
        })
    })

    it("uses the trimmed firstName as displayName and falls back to username", async () => {
        mocks.getCurrentUser.mockResolvedValue({ ...USER, firstName: "  علی  " })
        mocks.getDayTasks.mockResolvedValue({
            tasks: [{ id: 1, title: "کار یک", status: "TODO", priority: null, score: null, estimatedTime: null, allocatedMinutes: null }],
            summary: GET_SUMMARY,
        })

        const res = await GET(new NextRequest(`http://localhost/api/tasks?dayKey=${DAY_KEY}`))
        const parsed = await res.json()

        expect(parsed.data.advisor.message).toContain("علی جان")
        expect(mocks.buildAdvisor).toHaveBeenCalledWith(
            expect.any(Array),
            { displayName: "علی", availableMinutes: 90 },
        )
    })

    it("still returns 200 with advisor: null when buildAdvisor throws (route never 500s)", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
        mocks.getDayTasks.mockResolvedValue({ tasks: GET_TASKS, summary: GET_SUMMARY })
        mocks.buildAdvisor.mockImplementation(() => {
            throw new Error("boom")
        })

        const res = await GET(new NextRequest(`http://localhost/api/tasks?dayKey=${DAY_KEY}`))

        expect(res.status).toBe(200)
        const parsed = await res.json()
        expect(parsed.ok).toBe(true)
        expect(parsed.data.advisor).toBe(null)
        // tasks و summary سالم‌اند — فقط advisor حذف شده
        expect(parsed.data.tasks).toEqual(GET_TASKS)
        expect(parsed.data.summary).toEqual(GET_SUMMARY)
        expect(errorSpy).toHaveBeenCalledWith("ADVISOR CALCULATION ERROR:", expect.any(Error))
        errorSpy.mockRestore()
    })

    it("defaults to getCanonicalToday(user.timezone) when dayKey is omitted", async () => {
        mocks.getDayTasks.mockResolvedValue({ tasks: [], summary: { dayKey: DAY_KEY, openBudgetMinutes: 0 } })

        const res = await GET(new NextRequest("http://localhost/api/tasks"))

        expect(mocks.getCanonicalToday).toHaveBeenCalledWith("Asia/Tehran")
        expect(mocks.getDayTasks).toHaveBeenCalledWith(1, DAY_KEY)
        expect(res.status).toBe(200)
        const parsed = await res.json()
        // لیست خالی → advisor با ساختار کامل اما بدون پیشنهاد
        expect(parsed.data.advisor.orderedTaskIds).toEqual([])
        expect(parsed.data.advisor.nextTaskId).toBe(null)
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