import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* Per-task reminder — service layer smoke tests (Prisma mocked).      */
/* Covers: getDueReminders query/grace + updateTask reminder mutation. */
/* ------------------------------------------------------------------ */

const { prismaMock, getPrismaMock } = vi.hoisted(() => {
    const prismaMock = {
        task: {
            create: vi.fn(),
            findFirst: vi.fn(),
            update: vi.fn(),
            updateMany: vi.fn(),
            delete: vi.fn(),
            findMany: vi.fn(),
        },
        dailyPlan: { updateMany: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
        taskEvent: { create: vi.fn() },
        $transaction: vi.fn(async (arg: unknown) => {
            if (typeof arg === "function") return (arg as (tx: unknown) => unknown)(prismaMock)
            if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[])
            return arg
        }),
    }
    return { prismaMock, getPrismaMock: vi.fn(() => prismaMock) }
})

vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: getPrismaMock }))
vi.mock("@/app/lib/ai/analyzeTask", () => ({ analyzeTask: vi.fn() }))
vi.mock("@/app/lib/planner/rebalance", () => ({
    markDayStale: vi.fn(),
    ensureDayRebalanced: vi.fn(),
}))

import { getDueReminders, updateTask } from "./tasks.service"

const TZ = "Asia/Tehran"

describe("getDueReminders", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        prismaMock.task.findMany.mockResolvedValue([])
    })

    it("queries only open tasks for this user whose reminder is due within the grace window", async () => {
        const now = new Date("2026-01-01T12:00:00.000Z")

        await getDueReminders(1, now, 5)

        expect(prismaMock.task.findMany).toHaveBeenCalledWith({
            where: {
                userId: 1,
                status: { not: "DONE" },
                reminderAt: {
                    not: null,
                    lte: now,
                    gte: new Date("2026-01-01T11:55:00.000Z"),
                },
            },
            orderBy: { reminderAt: "asc" },
            take: 50,
        })
    })

    it("returns the service result unchanged (thin read, no rebalance side effects)", async () => {
        const rows = [{ id: 1 }, { id: 2 }]
        prismaMock.task.findMany.mockResolvedValue(rows)

        const out = await getDueReminders(1)

        expect(out).toBe(rows)
    })
})

describe("updateTask — reminder mutation", () => {
    const baseTask = {
        id: 5,
        userId: 1,
        title: "تماس با مشتری",
        dayKey: "2026-01-01",
        status: "TODO",
        category: null,
        priority: null,
        score: null,
        reason: null,
        estimatedTime: null,
        allocatedMinutes: null,
        scheduledDate: new Date("2026-01-01T00:00:00.000Z"),
        reminderAt: null as Date | null,
    }

    beforeEach(() => {
        vi.clearAllMocks()
        prismaMock.task.findFirst.mockResolvedValue(baseTask)
        prismaMock.task.update.mockImplementation(async (args: unknown) => {
            const { data } = args as { data: Record<string, unknown> }
            return { ...baseTask, ...data }
        })
    })

    it("sets a new reminder: writes reminderAt, reports changedFields=[reminder], no EDITED, no plan bump", async () => {
        const reminderAt = new Date("2026-01-01T11:00:00.000Z")

        const result = await updateTask(1, TZ, 5, { reminderAt })

        const updateArgs = prismaMock.task.update.mock.calls[0][0]
        expect(updateArgs.data.reminderAt).toEqual(reminderAt)
        expect(result.changed).toBe(true)
        expect(result.changedFields).toEqual(["reminder"])
        // یادآوری فراداده است: نه رویداد EDITED و نه bump برنامه
        expect(prismaMock.taskEvent.create).not.toHaveBeenCalled()
        expect(prismaMock.dailyPlan.updateMany).not.toHaveBeenCalled()
    })

    it("clears the reminder with null (disable) and reports the change", async () => {
        prismaMock.task.findFirst.mockResolvedValue({
            ...baseTask,
            reminderAt: new Date("2026-01-01T11:00:00.000Z"),
        })

        const result = await updateTask(1, TZ, 5, { reminderAt: null })

        const updateArgs = prismaMock.task.update.mock.calls[0][0]
        expect(updateArgs.data.reminderAt).toBeNull()
        expect(result.changed).toBe(true)
        expect(result.changedFields).toEqual(["reminder"])
    })

    it("treats an identical reminder as a no-op (no write, no event)", async () => {
        const reminderAt = new Date("2026-01-01T11:00:00.000Z")
        prismaMock.task.findFirst.mockResolvedValue({ ...baseTask, reminderAt })

        const result = await updateTask(1, TZ, 5, { reminderAt })

        expect(result.changed).toBe(false)
        expect(result.changedFields).toEqual([])
        expect(prismaMock.task.update).not.toHaveBeenCalled()
    })
})
