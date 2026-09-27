import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* Phase 3 — planApply.service                                        */
/*                                                                    */
/* prisma + lazy-rebalance read path are faked; the atomic version    */
/* guard and the rollback semantics are simulated in-memory so the    */
/* stale/concurrency/atomicity invariants can be asserted without a   */
/* real database.                                                     */
/* ------------------------------------------------------------------ */

const mocks = vi.hoisted(() => ({
    getDayTasks: vi.fn(),
}))

vi.mock("@/app/lib/services/tasks.service", () => ({ getDayTasks: mocks.getDayTasks }))

import { applyPlan } from "./planApply.service"
import { PlanStaleError } from "./errors"
import type { PlanProposal } from "@/app/lib/planner/planProposal"
import { canonicalKeyToLocalMidnight, shiftCanonicalKey } from "@/app/lib/canonicalDay"

const USER_ID = 7
const DAY = "2026-09-27"
const TOMORROW = shiftCanonicalKey(DAY, 1)
const TIMEZONE = "Asia/Tehran"

type FakeTask = {
    id: number
    userId: number
    dayKey: string
    status: "TODO" | "IN_PROGRESS" | "DONE"
    estimatedTime: number | null
    score: number | null
    priority: "HIGH" | "MEDIUM" | "LOW" | null
    /** فیلدهای rollover — فقط در تست‌های انتقال مقدار می‌گیرند */
    scheduledDate?: Date
    previousScheduledDate?: Date | null
    allocatedMinutes?: number | null
}

type FakeEvent = { taskId: number; type: string; payload: unknown }

/* ------------------------------------------------------------------ */
/* In-memory prisma harness with faithful transaction rollback         */
/* ------------------------------------------------------------------ */

function createHarness(
    initialVersion: number,
    initialTasks: FakeTask[],
    extraDayVersions: Record<string, number> = {},
    sourceDay: string = DAY,
) {
    // نسخهٔ هر روز جدا نگه داشته می‌شود تا bump روز مقصد از bump روز مبدأ قابل تفکیک باشد
    const versions = new Map<string, number>([
        [sourceDay, initialVersion],
        ...Object.entries(extraDayVersions),
    ])
    const tasks = new Map<number, FakeTask>(initialTasks.map((t) => [t.id, { ...t }]))
    const events: FakeEvent[] = []

    const sourceVersion = () => versions.get(sourceDay) ?? 0

    const tx = {
        dailyPlan: {
            updateMany: vi.fn(
                async (args: { where: { userId: number; dayKey: string; planVersion?: number } }) => {
                    const current = versions.get(args.where.dayKey)
                    // گاردِ شرطی نسخه (Step 1) — تنها mutationای که به planVersion شرط می‌دهند
                    if (args.where.planVersion !== undefined) {
                        if (current !== args.where.planVersion) return { count: 0 }
                        versions.set(args.where.dayKey, current + 1)
                        return { count: 1 }
                    }
                    // bump ساده — نبودِ رکورد DailyPlan یعنی no-op (همان رفتار rollover)
                    if (current === undefined) return { count: 0 }
                    versions.set(args.where.dayKey, current + 1)
                    return { count: 1 }
                },
            ),
        },
        task: {
            updateMany: vi.fn(
                async (args: {
                    where: { id: number; userId: number; dayKey: string; status: string }
                    data: Partial<FakeTask>
                }) => {
                    const task = tasks.get(args.where.id)
                    if (
                        !task ||
                        task.userId !== args.where.userId ||
                        task.dayKey !== args.where.dayKey ||
                        task.status !== args.where.status
                    ) {
                        return { count: 0 }
                    }
                    Object.assign(task, args.data)
                    return { count: 1 }
                },
            ),
        },
        taskEvent: {
            create: vi.fn(async (args: { data: FakeEvent }) => {
                events.push(args.data)
                return args.data
            }),
        },
    }

    const prisma = {
        dailyPlan: {
            findUnique: vi.fn(async () => ({
                planVersion: sourceVersion(),
                rebalancedVersion: sourceVersion(),
            })),
        },
        task: {
            findMany: vi.fn(async (args: { where: { id: { in: number[] }; userId: number } }) => {
                const ids = args.where.id.in
                return ids
                    .map((id) => tasks.get(id))
                    .filter((t): t is FakeTask => !!t && t.userId === args.where.userId)
                    .map((t) => ({
                        id: t.id,
                        dayKey: t.dayKey,
                        status: t.status,
                        scheduledDate: t.scheduledDate,
                    }))
            }),
        },
        $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
            // snapshot کامل — rollback باید نسخه‌ها، تسک‌ها و رویدادها را با هم برگرداند
            const versionSnapshot = new Map(versions)
            const taskSnapshots = new Map([...tasks].map(([id, t]) => [id, { ...t }]))
            const eventSnapshot = [...events]
            try {
                return await cb(tx)
            } catch (error) {
                versions.clear()
                for (const [key, value] of versionSnapshot) versions.set(key, value)
                tasks.clear()
                for (const [id, t] of taskSnapshots) tasks.set(id, t)
                events.length = 0
                events.push(...eventSnapshot)
                throw error
            }
        }),
    }

    return {
        prisma,
        tx,
        events,
        getVersion: () => sourceVersion(),
        getDayVersion: (dayKey: string) => versions.get(dayKey),
        getTask: (id: number) => tasks.get(id),
        allTasks: () => tasks,
        setVersion: (v: number) => {
            versions.set(sourceDay, v)
        },
    }
}

let harness = createHarness(5, [])

vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: () => harness.prisma }))

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const task = (overrides: Partial<FakeTask> = {}): FakeTask => ({
    id: 1,
    userId: USER_ID,
    dayKey: DAY,
    status: "TODO",
    estimatedTime: 10,
    score: 10,
    priority: "LOW",
    ...overrides,
})

const proposal = (overrides: Partial<PlanProposal> = {}): PlanProposal => ({
    basis: {
        dayKey: DAY,
        planVersion: 5,
        rebalancedVersion: 5,
        availableMinutes: 120,
        taskCount: 2,
        state: "fresh",
    },
    planned: [
        {
            taskId: 1,
            estimatedMinutes: 40,
            suggestedMinutes: 40,
            order: 1,
            aiOrder: 1,
            reason: "نیاز به انجام در ابتدای روز دارد",
            priority: "HIGH",
            score: 80,
            weight: 100,
            partial: false,
        },
        {
            taskId: 2,
            estimatedMinutes: 30,
            suggestedMinutes: 30,
            order: 2,
            aiOrder: 2,
            reason: "اولویت پایین‌تر، در انتهای روز انجام می‌شود",
            priority: "MEDIUM",
            score: 50,
            weight: 60,
            partial: false,
        },
    ],
    unfitted: [],
    plannedMinutes: 70,
    remainingMinutes: 50,
    aiUnscheduledTaskIds: [],
    source: "1xai",
    ...overrides,
})

const unfittedItem = (
    taskId: number,
    overrides: Partial<PlanProposal["unfitted"][number]> = {},
): PlanProposal["unfitted"][number] => ({
    taskId,
    estimatedMinutes: 30,
    weight: 50,
    aiOrder: taskId,
    // دلیل informational — سرویس Apply آن را نمی‌خواند و در DB نمی‌نویسد
    reason: "در ظرفیت امروز جا نمی‌شود",
    priority: "MEDIUM",
    score: 50,
    ...overrides,
})

const input = (overrides: Partial<Parameters<typeof applyPlan>[1]> = {}) => ({
    dayKey: DAY,
    expectedPlanVersion: 5,
    timezone: TIMEZONE,
    proposal: proposal(),
    ...overrides,
})

/** تسکِ برنامه‌ریزی‌شده با تاریخ canonical — برای سناریوهای انتقال */
const schedulableTask = (overrides: Partial<FakeTask> = {}): FakeTask =>
    task({
        scheduledDate: canonicalKeyToLocalMidnight(DAY, TIMEZONE),
        allocatedMinutes: 20,
        previousScheduledDate: null,
        ...overrides,
    })

function setup(
    version: number,
    tasks: FakeTask[],
    extraDayVersions: Record<string, number> = {},
    sourceDay: string = DAY,
) {
    harness = createHarness(version, tasks, extraDayVersions, sourceDay)
    mocks.getDayTasks.mockReset()
    mocks.getDayTasks.mockImplementation(async () => ({
        tasks: [...harness.allTasks().values()],
        summary: {
            dayKey: DAY,
            availableMinutes: 120,
            committedMinutes: 70,
            poolMinutes: 50,
        },
    }))
}

describe("applyPlan — happy path", () => {
    beforeEach(() => setup(5, [task({ id: 1 }), task({ id: 2 })]))

    it("applies AI metadata, consumes the expected version and returns the final day state", async () => {
        const result = await applyPlan(USER_ID, input())

        expect(result.applied).toBe(true)
        expect(result.dayKey).toBe(DAY)
        expect(result.planVersion).toBe(6)
        expect(result.rebalancedVersion).toBe(6)
        expect(result.availableMinutes).toBe(120)
        expect(result.plannedMinutes).toBe(70)
        expect(result.remainingMinutes).toBe(50)
        expect(harness.getVersion()).toBe(6)

        const t1 = harness.getTask(1)!
        expect(t1.estimatedTime).toBe(40)
        expect(t1.score).toBe(80)
        expect(t1.priority).toBe("HIGH")

        // allocation is NOT written by apply — it comes from the existing lazy rebalance read
        expect("allocatedMinutes" in t1).toBe(false)
        expect(mocks.getDayTasks).toHaveBeenCalledWith(USER_ID, DAY)
    })

    it("Test A — applies metadata to both planned and unfitted TODO tasks", async () => {
        setup(5, [task({ id: 1 }), task({ id: 2 }), task({ id: 3 })])

        await applyPlan(
            USER_ID,
            input({
                proposal: proposal({
                    unfitted: [unfittedItem(3, { estimatedMinutes: 50, score: 33, priority: "MEDIUM", aiOrder: 3 })],
                }),
            }),
        )

        expect(harness.tx.task.updateMany).toHaveBeenCalledTimes(3)
        const updatedIds = harness.tx.task.updateMany.mock.calls.map((c) => c[0].where.id).sort()
        expect(updatedIds).toEqual([1, 2, 3])
    })

    it("Test B — persists the unfitted item's score/priority onto the task", async () => {
        setup(5, [
            task({ id: 1 }),
            task({ id: 2 }),
            task({ id: 3, estimatedTime: 10, score: 1, priority: "LOW" }),
        ])

        await applyPlan(
            USER_ID,
            input({
                proposal: proposal({
                    unfitted: [unfittedItem(3, { estimatedMinutes: 75, score: 66, priority: "HIGH", aiOrder: 3 })],
                }),
            }),
        )

        const t3 = harness.getTask(3)!
        expect(t3.estimatedTime).toBe(75)
        expect(t3.score).toBe(66)
        expect(t3.priority).toBe("HIGH")
    })

    it("skips metadata writes for IN_PROGRESS tasks (protected planner semantics) but still succeeds", async () => {
        setup(5, [task({ id: 1, status: "IN_PROGRESS" }), task({ id: 2 })])

        const result = await applyPlan(USER_ID, input())

        expect(result.applied).toBe(true)
        expect(harness.getTask(1)!.estimatedTime).toBe(10) // unchanged
        expect(harness.getTask(2)!.estimatedTime).toBe(30)
        expect(harness.tx.task.updateMany).toHaveBeenCalledTimes(1)
        expect(harness.tx.task.updateMany.mock.calls[0][0].where.id).toBe(2)
    })
})

describe("applyPlan — stale protection (§۴/§۱۲)", () => {
    it("rejects with PLAN_STALE and zero mutation when planVersion moved after generation", async () => {
        setup(6, [task({ id: 1 }), task({ id: 2 })]) // day changed since proposal.basis.planVersion = 5

        await expect(applyPlan(USER_ID, input())).rejects.toBeInstanceOf(PlanStaleError)

        expect(harness.getVersion()).toBe(6)
        expect(harness.getTask(1)!.estimatedTime).toBe(10)
        expect(harness.prisma.$transaction).not.toHaveBeenCalled()
        expect(harness.tx.task.updateMany).not.toHaveBeenCalled()
    })

    it("rejects when the request expectedPlanVersion disagrees with the proposal basis (no I/O)", async () => {
        setup(5, [task({ id: 1 }), task({ id: 2 })])

        await expect(
            applyPlan(USER_ID, input({ expectedPlanVersion: 4 })),
        ).rejects.toBeInstanceOf(PlanStaleError)

        expect(harness.prisma.dailyPlan.findUnique).not.toHaveBeenCalled()
    })

    it("rejects a proposal belonging to another day (no I/O)", async () => {
        setup(5, [task({ id: 1 }), task({ id: 2 })])

        await expect(
            applyPlan(USER_ID, input({ proposal: proposal({ basis: { ...proposal().basis, dayKey: "2026-01-01" } }) })),
        ).rejects.toBeInstanceOf(PlanStaleError)

        expect(harness.prisma.dailyPlan.findUnique).not.toHaveBeenCalled()
    })

    it("rejects when there is no DailyPlan for the day (basis no longer holds)", async () => {
        setup(0, [task({ id: 1 }), task({ id: 2 })])

        await expect(applyPlan(USER_ID, input())).rejects.toBeInstanceOf(PlanStaleError)
    })

    it("rejects a task added after generation (unknown id in the proposal)", async () => {
        setup(5, [task({ id: 1 }), task({ id: 2 })])

        await expect(
            applyPlan(
                USER_ID,
                input({
                    proposal: proposal({
                        planned: [
                            ...proposal().planned,
                            {
                                taskId: 99,
                                estimatedMinutes: 20,
                                suggestedMinutes: 20,
                                order: 3,
                                aiOrder: 3,
                                reason: "کار تازه اضافه‌شده",
                                priority: "LOW",
                                score: 10,
                                weight: 20,
                                partial: false,
                            },
                        ],
                    }),
                }),
            ),
        ).rejects.toBeInstanceOf(PlanStaleError)

        expect(harness.getVersion()).toBe(5)
        expect(harness.prisma.$transaction).not.toHaveBeenCalled()
    })

    it("rejects a task that belongs to a foreign user / foreign day", async () => {
        setup(5, [
            task({ id: 1, userId: 999 }), // foreign
            task({ id: 2, dayKey: "2026-01-02" }), // moved to another day
        ])

        await expect(applyPlan(USER_ID, input())).rejects.toBeInstanceOf(PlanStaleError)
        expect(harness.getVersion()).toBe(5)
    })

    it("rejects when a planned task was completed after generation", async () => {
        setup(5, [task({ id: 1, status: "DONE" }), task({ id: 2 })])

        await expect(applyPlan(USER_ID, input())).rejects.toBeInstanceOf(PlanStaleError)
        expect(harness.prisma.$transaction).not.toHaveBeenCalled()
    })

    it("rejects a deleted task after generation", async () => {
        setup(5, [task({ id: 2 })]) // task 1 deleted

        await expect(applyPlan(USER_ID, input())).rejects.toBeInstanceOf(PlanStaleError)
    })
})

describe("applyPlan — unfitted protection semantics", () => {
    it("Test C — does not overwrite an IN_PROGRESS unfitted task, but still succeeds", async () => {
        setup(5, [
            task({ id: 1 }),
            task({ id: 2 }),
            task({ id: 3, status: "IN_PROGRESS", estimatedTime: 10, score: 1, priority: "LOW" }),
        ])

        const result = await applyPlan(
            USER_ID,
            input({
                proposal: proposal({
                    unfitted: [unfittedItem(3, { estimatedMinutes: 75, score: 66, priority: "HIGH" })],
                }),
            }),
        )

        expect(result.applied).toBe(true)
        const t3 = harness.getTask(3)!
        expect(t3.estimatedTime).toBe(10) // untouched
        expect(t3.score).toBe(1)
        expect(t3.priority).toBe("LOW")
        expect(harness.tx.task.updateMany).toHaveBeenCalledTimes(2) // planned only
    })

    it("Test D — rejects (PLAN_STALE) and never overwrites a DONE unfitted task", async () => {
        setup(5, [
            task({ id: 1 }),
            task({ id: 2 }),
            task({ id: 3, status: "DONE", estimatedTime: 10, score: 1, priority: "LOW" }),
        ])

        await expect(
            applyPlan(
                USER_ID,
                input({
                    proposal: proposal({
                        unfitted: [unfittedItem(3, { estimatedMinutes: 75, score: 66, priority: "HIGH" })],
                    }),
                }),
            ),
        ).rejects.toBeInstanceOf(PlanStaleError)

        const t3 = harness.getTask(3)!
        expect(t3.status).toBe("DONE")
        expect(t3.estimatedTime).toBe(10)
        expect(harness.prisma.$transaction).not.toHaveBeenCalled()
    })
})

describe("applyPlan — atomicity", () => {
    it("rolls the whole transaction back (version + tasks) if a task write fails mid-transaction", async () => {
        setup(5, [task({ id: 1 }), task({ id: 2 })])
        // first task update reports a concurrent change (count 0) → whole txn must roll back
        harness.tx.task.updateMany.mockResolvedValueOnce({ count: 0 })

        await expect(applyPlan(USER_ID, input())).rejects.toBeInstanceOf(PlanStaleError)

        expect(harness.getVersion()).toBe(5) // version bump rolled back
        expect(harness.getTask(1)!.estimatedTime).toBe(10) // no partial metadata write
        expect(harness.getTask(2)!.estimatedTime).toBe(10)
    })

    it("exactly one of two concurrent applies on the same proposal/version succeeds", async () => {
        setup(5, [task({ id: 1 }), task({ id: 2 })])

        const results = await Promise.allSettled([
            applyPlan(USER_ID, input()),
            applyPlan(USER_ID, input()),
        ])

        const fulfilled = results.filter((r) => r.status === "fulfilled")
        const rejected = results.filter((r) => r.status === "rejected")
        expect(fulfilled).toHaveLength(1)
        expect(rejected).toHaveLength(1)
        expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(PlanStaleError)

        // version advanced exactly once → no double apply
        expect(harness.getVersion()).toBe(6)
    })
})

/* ------------------------------------------------------------------ */
/* Phase 4.4 — Apply + «انتقال موارد خارج از ظرفیت به فردا»            */
/* ------------------------------------------------------------------ */
/* یک گزینهٔ اختیاری روی Apply: کارهایی که در ظرفیت روز جا نشدند، در همان  */
/* تراکنش Apply به روز بعدِ خودِ proposal منتقل شوند. بدون این گزینه رفتار  */
/* Apply دقیقاً همان رفتار قبلی می‌ماند.                                   */
/* ------------------------------------------------------------------ */

const withUnfitted = (items: PlanProposal["unfitted"], overrides: Partial<PlanProposal> = {}) =>
    proposal({ ...overrides, unfitted: items })

const moveInput = (
    unfitted: PlanProposal["unfitted"],
    overrides: Partial<Parameters<typeof applyPlan>[1]> = {},
) =>
    input({
        proposal: withUnfitted(unfitted),
        moveUnfittedToTomorrow: true,
        ...overrides,
    })

describe("applyPlan — moveUnfittedToTomorrow", () => {
    const originalDate = canonicalKeyToLocalMidnight(DAY, TIMEZONE)
    const earlierDate = canonicalKeyToLocalMidnight(shiftCanonicalKey(DAY, -3), TIMEZONE)

    beforeEach(() =>
        setup(
            5,
            [
                schedulableTask({ id: 1 }),
                schedulableTask({ id: 2 }),
                schedulableTask({ id: 3, scheduledDate: originalDate, previousScheduledDate: earlierDate, allocatedMinutes: 20 }),
            ],
            { [TOMORROW]: 2 },
        ),
    )

    it("1) moves the unfitted task's dayKey to the day after the proposal's own day", async () => {
        await applyPlan(USER_ID, moveInput([unfittedItem(3)]))

        expect(harness.getTask(3)!.dayKey).toBe(TOMORROW)
    })

    it("2) recomputes scheduledDate as local midnight of the destination day", async () => {
        await applyPlan(USER_ID, moveInput([unfittedItem(3)]))

        expect(harness.getTask(3)!.scheduledDate).toEqual(canonicalKeyToLocalMidnight(TOMORROW, TIMEZONE))
    })

    it("3) keeps the old scheduledDate in previousScheduledDate", async () => {
        await applyPlan(USER_ID, moveInput([unfittedItem(3)]))

        expect(harness.getTask(3)!.previousScheduledDate).toEqual(originalDate)
    })

    it("4) clears allocatedMinutes so the destination day re-allocates from scratch", async () => {
        await applyPlan(USER_ID, moveInput([unfittedItem(3)]))

        expect(harness.getTask(3)!.allocatedMinutes).toBeNull()
    })

    it("5) records a ROLLED_OVER event per moved task with the from/to payload", async () => {
        await applyPlan(USER_ID, moveInput([unfittedItem(3)]))

        expect(harness.events).toEqual([
            { taskId: 3, type: "ROLLED_OVER", payload: { fromDayKey: DAY, toDayKey: TOMORROW } },
        ])
    })

    it("6) bumps the destination day's planVersion", async () => {
        await applyPlan(USER_ID, moveInput([unfittedItem(3)]))

        expect(harness.getDayVersion(TOMORROW)).toBe(3)
    })

    it("7) bumps the source day's planVersion exactly once (guard only, never twice)", async () => {
        await applyPlan(USER_ID, moveInput([unfittedItem(3)]))

        expect(harness.getVersion()).toBe(6)
        const sourceBumps = harness.tx.dailyPlan.updateMany.mock.calls.filter(
            (c) => c[0].where.dayKey === DAY,
        )
        expect(sourceBumps).toHaveLength(1)
    })

    it("8) still applies the AI metadata to both planned and unfitted tasks in the same transaction", async () => {
        await applyPlan(USER_ID, moveInput([unfittedItem(3, { estimatedMinutes: 75, score: 66, priority: "HIGH" })]))

        const t3 = harness.getTask(3)!
        expect(t3.estimatedTime).toBe(75)
        expect(t3.score).toBe(66)
        expect(t3.priority).toBe("HIGH")
        // planned ها هم دست‌نخورده از نظر روز می‌مانند
        expect(harness.getTask(1)!.dayKey).toBe(DAY)
        expect(harness.getTask(2)!.dayKey).toBe(DAY)
    })

    it("9) reports the moved task ids", async () => {
        const result = await applyPlan(USER_ID, moveInput([unfittedItem(3)]))

        expect(result.movedTaskIds).toEqual([3])
    })

    it("10) reports the destination day key", async () => {
        const result = await applyPlan(USER_ID, moveInput([unfittedItem(3)]))

        expect(result.destinationDayKey).toBe(TOMORROW)
    })

    it("11) without the flag nothing moves and the result reports an empty move", async () => {
        const result = await applyPlan(USER_ID, input({ proposal: withUnfitted([unfittedItem(3)]) }))

        expect(harness.getTask(3)!.dayKey).toBe(DAY)
        expect(harness.getTask(3)!.allocatedMinutes).toBe(20)
        expect(harness.events).toEqual([])
        expect(harness.getDayVersion(TOMORROW)).toBe(2)
        expect(result.movedTaskIds).toEqual([])
        expect(result.destinationDayKey).toBeUndefined()
    })

    it("12) rolls the whole transaction back — version, metadata, move, event and destination bump", async () => {
        // شبیه‌سازی «تغییر هم‌زمان» دقیقاً روی نوشتنِ انتقال: هر نوشتنی که
        // dayKey عوض کند count=0 می‌دهد. نوشتن metadataها سالم می‌مانند تا
        // rollback واقعاً چیزی برای برگرداندن داشته باشد.
        harness.tx.task.updateMany.mockImplementation(
            async (args: {
                where: { id: number; userId: number; dayKey: string; status: string }
                data: Partial<FakeTask>
            }) => {
                const task = harness.getTask(args.where.id)
                if (
                    !task ||
                    task.userId !== args.where.userId ||
                    task.dayKey !== args.where.dayKey ||
                    task.status !== args.where.status
                ) {
                    return { count: 0 }
                }
                if (args.data.dayKey !== undefined) return { count: 0 }
                Object.assign(task, args.data)
                return { count: 1 }
            },
        )

        await expect(applyPlan(USER_ID, moveInput([unfittedItem(3)]))).rejects.toBeInstanceOf(PlanStaleError)

        expect(harness.getVersion()).toBe(5) // bump مبدأ برگشت
        expect(harness.getDayVersion(TOMORROW)).toBe(2) // bump مقصد برگشت
        expect(harness.getTask(3)!.dayKey).toBe(DAY) // انتقال برگشت
        expect(harness.getTask(3)!.scheduledDate).toEqual(originalDate)
        expect(harness.getTask(3)!.previousScheduledDate).toEqual(earlierDate)
        expect(harness.getTask(3)!.allocatedMinutes).toBe(20)
        expect(harness.getTask(3)!.estimatedTime).toBe(10) // metadata هم برگشت
        expect(harness.events).toEqual([])
    })

    it("13) a past-day proposal still targets dayKey+1, never today+1", async () => {
        const pastDay = "2026-01-15"
        const pastTomorrow = "2026-01-16"
        setup(
            5,
            [
                schedulableTask({ id: 1, dayKey: pastDay }),
                schedulableTask({ id: 2, dayKey: pastDay }),
                schedulableTask({ id: 3, dayKey: pastDay, scheduledDate: canonicalKeyToLocalMidnight(pastDay, TIMEZONE) }),
            ],
            { [pastTomorrow]: 0 },
            pastDay,
        )

        const result = await applyPlan(
            USER_ID,
            input({
                dayKey: pastDay,
                proposal: withUnfitted([unfittedItem(3)], {
                    basis: { ...proposal().basis, dayKey: pastDay },
                }),
                moveUnfittedToTomorrow: true,
            }),
        )

        expect(result.destinationDayKey).toBe(pastTomorrow)
        expect(harness.getTask(3)!.dayKey).toBe(pastTomorrow)
        expect(harness.getDayVersion(pastTomorrow)).toBe(1)
    })

    it("14) still moves the task when the destination has no DailyPlan row (bump is a no-op)", async () => {
        setup(5, [schedulableTask({ id: 1 }), schedulableTask({ id: 2 }), schedulableTask({ id: 3 })])

        expect(harness.getDayVersion(TOMORROW)).toBeUndefined()

        const result = await applyPlan(USER_ID, moveInput([unfittedItem(3)]))

        expect(harness.getTask(3)!.dayKey).toBe(TOMORROW)
        expect(harness.getDayVersion(TOMORROW)).toBeUndefined()
        expect(harness.getVersion()).toBe(6)
        expect(result.movedTaskIds).toEqual([3])
    })

    it("15) moves every unfitted task at once, in proposal order", async () => {
        setup(
            5,
            [
                schedulableTask({ id: 1 }),
                schedulableTask({ id: 2 }),
                schedulableTask({ id: 3 }),
                schedulableTask({ id: 4 }),
            ],
            { [TOMORROW]: 0 },
        )

        const result = await applyPlan(
            USER_ID,
            moveInput([unfittedItem(3), unfittedItem(4)]),
        )

        expect(result.movedTaskIds).toEqual([3, 4])
        expect(harness.getTask(3)!.dayKey).toBe(TOMORROW)
        expect(harness.getTask(4)!.dayKey).toBe(TOMORROW)
        expect(harness.events).toHaveLength(2)
    })

    it("crosses a month boundary through the canonical helper (2026-12-31 → 2027-01-01)", async () => {
        const newYearsEve = "2026-12-31"
        const newYearsDay = "2027-01-01"
        setup(
            5,
            [
                schedulableTask({ id: 1, dayKey: newYearsEve }),
                schedulableTask({ id: 2, dayKey: newYearsEve }),
                schedulableTask({ id: 3, dayKey: newYearsEve }),
            ],
            { [newYearsDay]: 4 },
            newYearsEve,
        )

        const result = await applyPlan(
            USER_ID,
            input({
                dayKey: newYearsEve,
                proposal: withUnfitted([unfittedItem(3)], {
                    basis: { ...proposal().basis, dayKey: newYearsEve },
                }),
                moveUnfittedToTomorrow: true,
            }),
        )

        expect(result.destinationDayKey).toBe(newYearsDay)
        expect(harness.getTask(3)!.dayKey).toBe(newYearsDay)
    })
})

describe("applyPlan — moveUnfittedToTomorrow: protected semantics", () => {
    beforeEach(() => setup(5, [schedulableTask({ id: 1 }), schedulableTask({ id: 2 })]))

    it("never moves an IN_PROGRESS task (protected planner allocation)", async () => {
        setup(5, [
            schedulableTask({ id: 1 }),
            schedulableTask({ id: 2 }),
            schedulableTask({ id: 3, status: "IN_PROGRESS", allocatedMinutes: 45 }),
        ])

        const result = await applyPlan(USER_ID, moveInput([unfittedItem(3)]))

        expect(harness.getTask(3)!.dayKey).toBe(DAY)
        expect(harness.getTask(3)!.allocatedMinutes).toBe(45)
        expect(harness.events).toEqual([])
        expect(result.movedTaskIds).toEqual([])
        expect(result.destinationDayKey).toBeUndefined()
    })

    it("rejects (PLAN_STALE) and moves nothing when an unfitted task was completed meanwhile", async () => {
        setup(5, [
            schedulableTask({ id: 1 }),
            schedulableTask({ id: 2 }),
            schedulableTask({ id: 3, status: "DONE" }),
        ])

        await expect(applyPlan(USER_ID, moveInput([unfittedItem(3)]))).rejects.toBeInstanceOf(PlanStaleError)

        expect(harness.prisma.$transaction).not.toHaveBeenCalled()
        expect(harness.getTask(3)!.dayKey).toBe(DAY)
    })

    it("never moves a task owned by another user", async () => {
        setup(5, [
            schedulableTask({ id: 1 }),
            schedulableTask({ id: 2 }),
            schedulableTask({ id: 3, userId: 999 }),
        ])

        await expect(applyPlan(USER_ID, moveInput([unfittedItem(3)]))).rejects.toBeInstanceOf(PlanStaleError)

        expect(harness.getTask(3)!.dayKey).toBe(DAY)
        expect(harness.events).toEqual([])
    })

    it("leaves a partial (planned) task in place — partial is never unfitted", async () => {
        const result = await applyPlan(USER_ID, moveInput([]))

        expect(result.movedTaskIds).toEqual([])
        expect(harness.getTask(1)!.dayKey).toBe(DAY)
        expect(harness.getTask(2)!.dayKey).toBe(DAY)
        expect(harness.events).toEqual([])
    })

    it("rejects a stale plan with zero mutation even when the move is requested", async () => {
        setup(6, [schedulableTask({ id: 1 }), schedulableTask({ id: 2 }), schedulableTask({ id: 3 })])

        await expect(applyPlan(USER_ID, moveInput([unfittedItem(3)]))).rejects.toBeInstanceOf(PlanStaleError)

        expect(harness.prisma.$transaction).not.toHaveBeenCalled()
        expect(harness.getTask(3)!.dayKey).toBe(DAY)
        expect(harness.events).toEqual([])
    })

    it("lets exactly one of two concurrent applies that both request the move win", async () => {
        setup(
            5,
            [schedulableTask({ id: 1 }), schedulableTask({ id: 2 }), schedulableTask({ id: 3 })],
            { [TOMORROW]: 0 },
        )

        const results = await Promise.allSettled([
            applyPlan(USER_ID, moveInput([unfittedItem(3)])),
            applyPlan(USER_ID, moveInput([unfittedItem(3)])),
        ])

        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
        expect(results.filter((r) => r.status === "rejected")).toHaveLength(1)
        expect(harness.getVersion()).toBe(6)
        // انتقال دقیقاً یک‌بار انجام شده و روز مقصد هم دقیقاً یک‌بار bump شده
        expect(harness.getDayVersion(TOMORROW)).toBe(1)
        expect(harness.events).toHaveLength(1)
    })
})
