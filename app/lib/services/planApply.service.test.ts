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

const USER_ID = 7
const DAY = "2026-09-27"

type FakeTask = {
    id: number
    userId: number
    dayKey: string
    status: "TODO" | "IN_PROGRESS" | "DONE"
    estimatedTime: number | null
    score: number | null
    priority: "HIGH" | "MEDIUM" | "LOW" | null
}

/* ------------------------------------------------------------------ */
/* In-memory prisma harness with faithful transaction rollback         */
/* ------------------------------------------------------------------ */

function createHarness(initialVersion: number, initialTasks: FakeTask[]) {
    let version = initialVersion
    const tasks = new Map<number, FakeTask>(initialTasks.map((t) => [t.id, { ...t }]))

    const tx = {
        dailyPlan: {
            updateMany: vi.fn(async (args: { where: { planVersion?: number } }) => {
                if (args.where.planVersion !== version) return { count: 0 }
                version += 1
                return { count: 1 }
            }),
        },
        task: {
            updateMany: vi.fn(
                async (args: { where: { id: number; userId: number; dayKey: string; status: string }; data: Partial<FakeTask> }) => {
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
    }

    const prisma = {
        dailyPlan: {
            findUnique: vi.fn(async () => ({ planVersion: version, rebalancedVersion: version })),
        },
        task: {
            findMany: vi.fn(async (args: { where: { id: { in: number[] }; userId: number } }) => {
                const ids = args.where.id.in
                return ids
                    .map((id) => tasks.get(id))
                    .filter((t): t is FakeTask => !!t && t.userId === args.where.userId)
                    .map((t) => ({ id: t.id, dayKey: t.dayKey, status: t.status }))
            }),
        },
        $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
            const versionSnapshot = version
            const taskSnapshots = new Map([...tasks].map(([id, t]) => [id, { ...t }]))
            try {
                return await cb(tx)
            } catch (error) {
                version = versionSnapshot
                tasks.clear()
                for (const [id, t] of taskSnapshots) tasks.set(id, t)
                throw error
            }
        }),
    }

    return {
        prisma,
        tx,
        getVersion: () => version,
        getTask: (id: number) => tasks.get(id),
        allTasks: () => tasks,
        setVersion: (v: number) => {
            version = v
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
    proposal: proposal(),
    ...overrides,
})

function setup(version: number, tasks: FakeTask[]) {
    harness = createHarness(version, tasks)
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
