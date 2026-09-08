import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* B1-lite — smoke tests لایه سرویس (tasks.service.ts)                 */
/* Prisma و analyzeTask هر دو mock هستند: بدون DB زنده، بدون AI واقعی. */
/* A3: mutationها planVersion را bump می‌کنند.                          */
/* A2: TaskEventها در همان transaction ثبت می‌شوند.                    */
/* A1: ویرایش Content vs Planning-only.                               */
/* ------------------------------------------------------------------ */

const { analyzeTaskMock } = vi.hoisted(() => ({ analyzeTaskMock: vi.fn() }))
const { markDayStaleMock } = vi.hoisted(() => ({ markDayStaleMock: vi.fn() }))
const { prismaMock, getPrismaMock } = vi.hoisted(() => {
    const prismaMock = {
        task: {
            create: vi.fn(),
            findFirst: vi.fn(),
            update: vi.fn(),
            delete: vi.fn(),
            findMany: vi.fn(),
        },
        dailyPlan: {
            updateMany: vi.fn(),
            update: vi.fn(),
            findUnique: vi.fn(),
            upsert: vi.fn(),
        },
        taskEvent: {
            create: vi.fn(),
        },
        $transaction: vi.fn(async (arg: unknown) => {
            // فرم تعاملی: tx = همان prismaMock (بنابراین فراخوانی‌ها ثبت می‌شوند)
            if (typeof arg === "function") return (arg as (tx: unknown) => unknown)(prismaMock)
            // فرم آرایه‌ای: نتیجه‌ی همه‌ی پرامیس‌ها (مثل Prisma واقعی)
            if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[])
            return arg
        }),
    }
    return { prismaMock, getPrismaMock: vi.fn(() => prismaMock) }
})

vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: getPrismaMock }))
vi.mock("@/app/lib/ai/analyzeTask", () => ({ analyzeTask: analyzeTaskMock }))
vi.mock("@/app/lib/planner/rebalance", () => ({
    markDayStale: markDayStaleMock,
    ensureDayRebalanced: vi.fn(),
}))

import { createTask, reanalyzeTask, updateTask } from "./tasks.service"
import { getCanonicalToday, shiftCanonicalKey } from "@/app/lib/canonicalDay"

const TIMEZONE = "Asia/Tehran"

describe("createTask", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it("creates a task with AI fields null, bumps planVersion, records CREATED, and returns { task }", async () => {
        const text = "گزارش مشتری"
        const dayKey = "2026-03-05"
        const createdTask = {
            id: 11,
            userId: 1,
            text,
            dayKey,
            scheduledDate: new Date(),
            status: "TODO",
            priority: null,
            score: null,
            reason: null,
            category: null,
            estimatedTime: null,
        }
        prismaMock.task.create.mockResolvedValue(createdTask)

        const result = await createTask(1, TIMEZONE, { text, dayKey })

        const createArgs = prismaMock.task.create.mock.calls[0][0]
        expect(createArgs.data).toMatchObject({
            text,
            dayKey,
            userId: 1,
            scheduledDate: expect.any(Date),
        })
        // هیچ فیلد AI نباید در create نوشته شود (قانون 3.5)
        expect(createArgs.data).not.toHaveProperty("priority")
        expect(createArgs.data).not.toHaveProperty("score")
        expect(createArgs.data).not.toHaveProperty("reason")
        expect(createArgs.data).not.toHaveProperty("category")
        expect(createArgs.data).not.toHaveProperty("estimatedTime")

        // A3: bump اتمیک planVersion در همان transaction ساخت (§6.3.2)
        expect(prismaMock.dailyPlan.updateMany).toHaveBeenCalledWith({
            where: { userId: 1, dayKey },
            data: { planVersion: { increment: 1 } },
        })
        // A2: رویداد CREATED با taskId واقعی (§6.3.6)
        expect(prismaMock.taskEvent.create).toHaveBeenCalledWith({
            data: { taskId: 11, type: "CREATED" },
        })

        // قرارداد پاسخ: فقط { task }
        expect(result).toEqual({ task: createdTask })
    })
})

describe("reanalyzeTask", () => {
    const today = getCanonicalToday(TIMEZONE)
    const analysis = {
        priority: "HIGH",
        score: 90,
        reason: "دلیل جدید",
        category: "Urgent",
        estimatedMinutes: 120,
    }

    beforeEach(() => {
        vi.clearAllMocks()
        analyzeTaskMock.mockResolvedValue({ source: "1xai", analysis })
    })

    it("keeps the user's category, overwrites other AI fields, bumps planVersion, and records ANALYZED", async () => {
        const task = {
            id: 1,
            userId: 1,
            text: "خرید",
            dayKey: today,
            status: "TODO",
            category: "Work", // دسته‌بندی صریح کاربر
            priority: "MEDIUM",
            score: 40,
            reason: "قدیمی",
            estimatedTime: 30,
        }
        prismaMock.task.findFirst.mockResolvedValue(task)
        prismaMock.task.update.mockImplementation(async (args: unknown) => {
            const { data } = args as { data: Record<string, unknown> }
            return { ...task, ...data }
        })

        const result = await reanalyzeTask(1, TIMEZONE, 1)

        const updateArgs = prismaMock.task.update.mock.calls[0][0]
        // قانون 7.5: category کاربر بازنویسی نمی‌شود
        expect(updateArgs.data.category).toBe("Work")
        // بقیه فیلدهای AI از تحلیل جدید می‌آیند
        expect(updateArgs.data.priority).toBe("HIGH")
        expect(updateArgs.data.score).toBe(90)
        expect(updateArgs.data.reason).toBe("دلیل جدید")
        expect(updateArgs.data.estimatedTime).toBe(120)

        // A3: bump اتمیک در همان transaction (7.7)
        expect(prismaMock.dailyPlan.updateMany).toHaveBeenCalledWith({
            where: { userId: 1, dayKey: today },
            data: { planVersion: { increment: 1 } },
        })
        // A2: رویداد ANALYZED (§6.3.6 / 7.12 gap 3)
        expect(prismaMock.taskEvent.create).toHaveBeenCalledWith({
            data: { taskId: 1, type: "ANALYZED" },
        })

        expect(result.aiSource).toBe("1xai")
        expect(result.task.category).toBe("Work")
        // A3: بازتوزیع در زمان mutation اجرا نمی‌شود
        expect(result.summary).toBeNull()
    })

    it("writes the category from analysis when the task category is null", async () => {
        const task = {
            id: 2,
            userId: 1,
            text: "ورزش",
            dayKey: today,
            status: "TODO",
            category: null,
            priority: null,
            score: null,
            reason: null,
            estimatedTime: null,
        }
        prismaMock.task.findFirst.mockResolvedValue(task)
        prismaMock.task.update.mockImplementation(async (args: unknown) => {
            const { data } = args as { data: Record<string, unknown> }
            return { ...task, ...data }
        })

        const result = await reanalyzeTask(1, TIMEZONE, 2)

        const updateArgs = prismaMock.task.update.mock.calls[0][0]
        expect(updateArgs.data.category).toBe("Urgent") // از تحلیل
        expect(result.task.category).toBe("Urgent")
    })
})

describe("updateTask (A1 — Content vs Planning-only)", () => {
    const today = getCanonicalToday(TIMEZONE)
    const task = {
        id: 5,
        userId: 1,
        text: "قدیمی",
        dayKey: today,
        status: "TODO",
        category: "Work",
        priority: "HIGH",
        score: 80,
        reason: "دلیل قبلی",
        estimatedTime: 60,
        allocatedMinutes: 30,
        scheduledDate: new Date(),
    }

    const mergedUpdate = async (args: unknown) => {
        const { data } = args as { data: Record<string, unknown> }
        return { ...task, ...data }
    }

    beforeEach(() => {
        vi.clearAllMocks()
        prismaMock.task.findFirst.mockResolvedValue(task)
        prismaMock.task.update.mockImplementation(mergedUpdate)
    })

    it("content mutation (text): nulls the AI group, preserves category/allocatedMinutes, records EDITED, bumps the day", async () => {
        const result = await updateTask(1, TIMEZONE, 5, { text: "عنوان جدید" })

        const updateArgs = prismaMock.task.update.mock.calls[0][0]
        expect(updateArgs.data.text).toBe("عنوان جدید")
        // §6.3.5: فقط گروه AI null می‌شود
        expect(updateArgs.data.score).toBeNull()
        expect(updateArgs.data.priority).toBeNull()
        expect(updateArgs.data.estimatedTime).toBeNull()
        expect(updateArgs.data.reason).toBeNull()
        // category و allocatedMinutes untouched (§7.6)
        expect(updateArgs.data).not.toHaveProperty("category")
        expect(updateArgs.data).not.toHaveProperty("allocatedMinutes")

        // bump روز + رویداد EDITED در همان transaction
        expect(prismaMock.dailyPlan.updateMany).toHaveBeenCalledWith({
            where: { userId: 1, dayKey: today },
            data: { planVersion: { increment: 1 } },
        })
        expect(prismaMock.taskEvent.create).toHaveBeenCalledWith({
            data: { taskId: 5, type: "EDITED" },
        })

        expect(result.task.text).toBe("عنوان جدید")
        expect(result.task.category).toBe("Work") // حفظ شده
        expect(result.task.allocatedMinutes).toBe(30) // حفظ شده
    })

    it("planning-only mutation (dayKey): keeps AI fields, bumps old+new days, records no EDITED", async () => {
        const next = shiftCanonicalKey(today, 1)
        const result = await updateTask(1, TIMEZONE, 5, { dayKey: next })

        const updateArgs = prismaMock.task.update.mock.calls[0][0]
        expect(updateArgs.data.dayKey).toBe(next)
        expect(updateArgs.data.scheduledDate).toBeInstanceOf(Date)
        // فیلدهای AI untouched — هیچ‌کدام در data نیستند
        expect(updateArgs.data).not.toHaveProperty("score")
        expect(updateArgs.data).not.toHaveProperty("priority")
        expect(updateArgs.data).not.toHaveProperty("estimatedTime")
        expect(updateArgs.data).not.toHaveProperty("reason")

        // هر دو روز stale می‌شوند
        expect(prismaMock.dailyPlan.updateMany).toHaveBeenCalledWith({
            where: { userId: 1, dayKey: today },
            data: { planVersion: { increment: 1 } },
        })
        expect(prismaMock.dailyPlan.updateMany).toHaveBeenCalledWith({
            where: { userId: 1, dayKey: next },
            data: { planVersion: { increment: 1 } },
        })
        // §6.3.6: EDITED فقط در Content Mutation
        expect(prismaMock.taskEvent.create).not.toHaveBeenCalled()

        expect(result.task.dayKey).toBe(next)
    })

    it("category-only edit: sets category, no EDITED, no bump", async () => {
        const result = await updateTask(1, TIMEZONE, 5, { category: "Health" })

        const updateArgs = prismaMock.task.update.mock.calls[0][0]
        expect(updateArgs.data.category).toBe("Health")
        expect(updateArgs.data).not.toHaveProperty("score")

        expect(prismaMock.taskEvent.create).not.toHaveBeenCalled()
        expect(prismaMock.dailyPlan.updateMany).not.toHaveBeenCalled()

        expect(result.task.category).toBe("Health")
    })

    it("no-op edit (same values): no update, no event, no bump", async () => {
        const result = await updateTask(1, TIMEZONE, 5, { text: "قدیمی" })

        expect(prismaMock.task.update).not.toHaveBeenCalled()
        expect(prismaMock.taskEvent.create).not.toHaveBeenCalled()
        expect(prismaMock.dailyPlan.updateMany).not.toHaveBeenCalled()
        expect(result.task).toBe(task)
    })

    it("throws TaskNotFoundError for another user's task", async () => {
        prismaMock.task.findFirst.mockResolvedValue(null)

        await expect(updateTask(1, TIMEZONE, 999, { text: "عنوان جدید" })).rejects.toThrow(
            /پیدا نشد|Task not found/i,
        )
    })
})