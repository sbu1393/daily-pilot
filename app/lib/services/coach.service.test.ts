import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* Step 2A - coach.service unit tests.                                 */
/*                                                                    */
/* The real Coach engine runs here (no engine mock). Only Prisma and   */
/* the external boundary are mocked. The mock is fixture-aware so the   */
/* same data can also drive the real planner.getDaySummary for the      */
/* budget-parity test.                                                 */
/* ------------------------------------------------------------------ */

const { prismaMock } = vi.hoisted(() => {
    const writeSpies = () => ({
        create: vi.fn(),
        createMany: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        upsert: vi.fn(),
        delete: vi.fn(),
        deleteMany: vi.fn(),
    })

    return {
        prismaMock: {
            dailyPlan: {
                findUnique: vi.fn(),
                findMany: vi.fn(),
                ...writeSpies(),
            },
            task: {
                findMany: vi.fn(),
                ...writeSpies(),
            },
            user: {
                findUnique: vi.fn(),
                ...writeSpies(),
            },
            $transaction: vi.fn(),
        },
    }
})

vi.mock("@/app/lib/getPrisma", () => ({ getPrisma: () => prismaMock }))

import { getDaySummary } from "@/app/lib/planner/summary"
import { ServiceError } from "@/app/lib/services/errors"
import {
    getDailyCoachReport,
    getWeeklyCoachReport,
    resolveCoachTimezone,
} from "./coach.service"

/* ============================== fixtures ============================== */

const USER_ID = 7
const OTHER_USER_ID = 99

const DAY_KEY = "2026-03-05"
const TODAY_KEY = DAY_KEY

const WEEK_START = "2026-10-31" // Saturday
const WEEK_TODAY = "2026-11-03" // Tuesday
const WEEK_DAY_KEYS = [
    "2026-10-31",
    "2026-11-01",
    "2026-11-02",
    "2026-11-03",
    "2026-11-04",
    "2026-11-05",
    "2026-11-06",
]

type TaskStatusLiteral = "TODO" | "IN_PROGRESS" | "DONE"

type TaskRow = {
    userId: number
    dayKey: string
    completedOn: string | null
    status: TaskStatusLiteral
    allocatedMinutes: number | null
    spentMinutes: number | null
}

type PlanRow = {
    userId: number
    dayKey: string
    availableMinutes: number
}

function makeTask(overrides: Partial<TaskRow> = {}): TaskRow {
    return {
        userId: USER_ID,
        dayKey: DAY_KEY,
        completedOn: null,
        status: "TODO",
        allocatedMinutes: null,
        spentMinutes: null,
        ...overrides,
    }
}

function makePlan(overrides: Partial<PlanRow> = {}): PlanRow {
    return {
        userId: USER_ID,
        dayKey: DAY_KEY,
        availableMinutes: 480,
        ...overrides,
    }
}

/**
 * Daily fixture used by U1/U6/U13/U14/U19:
 * - 2 open tasks (committed 300)
 * - 3 DONE tasks, all three with spentMinutes (timed = 3)
 *   spent 205, saved 15, overspent 10
 */
const DAILY_PLANS: PlanRow[] = [makePlan({ dayKey: DAY_KEY, availableMinutes: 480 })]

const DAILY_TASKS: TaskRow[] = [
    makeTask({ dayKey: DAY_KEY, status: "TODO", allocatedMinutes: 120 }),
    makeTask({ dayKey: DAY_KEY, status: "IN_PROGRESS", allocatedMinutes: 180 }),
    makeTask({
        dayKey: "2026-03-02",
        completedOn: DAY_KEY,
        status: "DONE",
        allocatedMinutes: 60,
        spentMinutes: 45,
    }),
    makeTask({
        dayKey: "2026-03-04",
        completedOn: DAY_KEY,
        status: "DONE",
        allocatedMinutes: 30,
        spentMinutes: 40,
    }),
    makeTask({
        dayKey: DAY_KEY,
        completedOn: DAY_KEY,
        status: "DONE",
        allocatedMinutes: 120,
        spentMinutes: 120,
    }),
]

/**
 * Weekly fixture:
 * covered = 10-31, 11-01, 11-02, 11-03 (todayKey 11-03)
 * future   = 11-04 (plan + open) and 11-05 (DONE + spent)
 */
const WEEK_PLANS: PlanRow[] = [
    makePlan({ dayKey: "2026-10-31", availableMinutes: 480 }),
    makePlan({ dayKey: "2026-11-01", availableMinutes: 300 }),
    makePlan({ dayKey: "2026-11-03", availableMinutes: 240 }),
    makePlan({ dayKey: "2026-11-04", availableMinutes: 600 }), // future
]

const WEEK_TASKS: TaskRow[] = [
    // DONE counted on completedOn even though dayKey is outside the week.
    makeTask({
        dayKey: "2026-10-25",
        completedOn: "2026-10-31",
        status: "DONE",
        allocatedMinutes: 60,
        spentMinutes: 50,
    }),
    makeTask({
        dayKey: "2026-10-31",
        completedOn: "2026-10-31",
        status: "DONE",
        allocatedMinutes: 30,
        spentMinutes: 30,
    }),
    makeTask({ dayKey: "2026-10-31", status: "TODO", allocatedMinutes: 45 }),

    makeTask({
        dayKey: "2026-11-01",
        completedOn: "2026-11-01",
        status: "DONE",
        allocatedMinutes: 20,
        spentMinutes: 30,
    }),
    makeTask({ dayKey: "2026-11-01", status: "IN_PROGRESS", allocatedMinutes: 60 }),

    makeTask({
        dayKey: "2026-11-02",
        completedOn: "2026-11-02",
        status: "DONE",
        allocatedMinutes: null,
        spentMinutes: null,
    }),

    makeTask({
        dayKey: "2026-11-03",
        completedOn: "2026-11-03",
        status: "DONE",
        allocatedMinutes: 90,
        spentMinutes: 80,
    }),
    makeTask({
        dayKey: "2026-11-03",
        completedOn: "2026-11-03",
        status: "DONE",
        allocatedMinutes: 10,
        spentMinutes: 10,
    }),
    makeTask({
        dayKey: "2026-11-03",
        completedOn: "2026-11-03",
        status: "DONE",
        allocatedMinutes: 50,
        spentMinutes: null,
    }),
    makeTask({ dayKey: "2026-11-03", status: "TODO", allocatedMinutes: 30 }),

    makeTask({ dayKey: "2026-11-04", status: "TODO", allocatedMinutes: 120 }),
    makeTask({
        dayKey: "2026-11-05",
        completedOn: "2026-11-05",
        status: "DONE",
        allocatedMinutes: 40,
        spentMinutes: 30,
    }),
]

/* ============================ mock helpers ============================ */

function matchesKey(value: string | null, expected: unknown): boolean {
    if (expected !== null && typeof expected === "object" && "in" in expected) {
        const list = (expected as { in?: unknown }).in
        return Array.isArray(list) && value !== null && list.includes(value)
    }
    return value === expected
}

function matchesTask(task: TaskRow, where: any): boolean {
    if (where.userId !== undefined && task.userId !== where.userId) return false

    if (where.status === "DONE") {
        return task.status === "DONE" && matchesKey(task.completedOn, where.completedOn)
    }

    if (
        where.status !== undefined &&
        where.status !== null &&
        typeof where.status === "object" &&
        where.status.not !== undefined
    ) {
        return task.status !== where.status.not && matchesKey(task.dayKey, where.dayKey)
    }

    return true
}

function filterTasks(rows: TaskRow[], where: any): TaskRow[] {
    if (Array.isArray(where.OR)) {
        return rows.filter(
            (row) =>
                row.userId === where.userId &&
                where.OR.some((clause: any) => matchesTask(row, clause)),
        )
    }
    return rows.filter((row) => matchesTask(row, where))
}

function installFixture(plans: PlanRow[], tasks: TaskRow[]): void {
    prismaMock.dailyPlan.findUnique.mockImplementation((args: any) => {
        const { userId, dayKey } = args.where.userId_dayKey
        const found = plans.find((plan) => plan.userId === userId && plan.dayKey === dayKey)
        return Promise.resolve(found ? { availableMinutes: found.availableMinutes } : null)
    })

    prismaMock.dailyPlan.findMany.mockImplementation((args: any) => {
        const keys: string[] = args.where.dayKey.in
        return Promise.resolve(
            plans
                .filter(
                    (plan) => plan.userId === args.where.userId && keys.includes(plan.dayKey),
                )
                .map((plan) => ({
                    dayKey: plan.dayKey,
                    availableMinutes: plan.availableMinutes,
                })),
        )
    })

    prismaMock.task.findMany.mockImplementation((args: any) =>
        Promise.resolve(filterTasks(tasks, args.where)),
    )
}

function resetPrisma(): void {
    vi.resetAllMocks()
    prismaMock.dailyPlan.findUnique.mockResolvedValue(null)
    prismaMock.dailyPlan.findMany.mockResolvedValue([])
    prismaMock.task.findMany.mockResolvedValue([])
}

const WRITE_METHODS = [
    "create",
    "createMany",
    "update",
    "updateMany",
    "upsert",
    "delete",
    "deleteMany",
] as const

function expectNoCoachWrites(): void {
    for (const method of WRITE_METHODS) {
        expect(prismaMock.dailyPlan[method]).not.toHaveBeenCalled()
        expect(prismaMock.task[method]).not.toHaveBeenCalled()
        expect(prismaMock.user[method]).not.toHaveBeenCalled()
    }
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
}

/* ============================ resolve timezone ============================ */

describe("resolveCoachTimezone", () => {
    it("U17 - accepts strict IANA zones (Asia/Tehran, UTC, America/New_York)", () => {
        expect(resolveCoachTimezone("Asia/Tehran")).toBe("Asia/Tehran")
        expect(resolveCoachTimezone("UTC")).toBe("UTC")
        expect(resolveCoachTimezone("America/New_York")).toBe("America/New_York")
        // Surrounding whitespace is normalised; the zone itself is unchanged.
        expect(resolveCoachTimezone("  Asia/Tehran  ")).toBe("Asia/Tehran")
    })

    it("U16 - rejects invalid, empty and non-string values with USER_TIMEZONE_INVALID", () => {
        const invalidValues: unknown[] = [
            undefined,
            null,
            42,
            {},
            [],
            "",
            "   ",
            "Mars/Olympus",
            "Not/A_Zone",
            "+05:00",
            "A".repeat(65),
        ]

        for (const value of invalidValues) {
            let captured: unknown = null
            try {
                resolveCoachTimezone(value)
            } catch (error) {
                captured = error
            }

            expect(captured).toBeInstanceOf(ServiceError)
            const serviceError = captured as ServiceError
            expect(serviceError.status).toBe(500)
            expect(serviceError.code).toBe("USER_TIMEZONE_INVALID")

            if (typeof value === "string" && value.trim().length > 0) {
                expect(serviceError.message).not.toContain(value)
            }
        }
    })
})

/* ============================== daily report ============================== */

describe("getDailyCoachReport", () => {
    beforeEach(resetPrisma)

    it("U1 - builds exact DayFacts; 3 done + 2 open never yields DAILY_ALL_DONE", async () => {
        installFixture(DAILY_PLANS, DAILY_TASKS)

        const report = await getDailyCoachReport({
            userId: USER_ID,
            dayKey: DAY_KEY,
            todayKey: TODAY_KEY,
        })

        expect(report.kind).toBe("daily")
        expect(report.dayKey).toBe(DAY_KEY)
        expect(report.state).toBe("OK")
        expect(report.facts).toEqual({
            doneTasks: 3,
            openTasks: 2,
            totalTasks: 5,
            timedDoneTasks: 3,
            completionPct: 60,
            spentMinutes: 205,
            savedMinutes: 15,
            overspentMinutes: 10,
            budget: { availableMinutes: 480, committedMinutes: 300 },
            poolMinutes: 0,
            overCommittedMinutes: 25,
        })
        expect(report.insights.map((insight) => insight.id)).toEqual([
            "DAILY_OVER_COMMITTED",
            "DAILY_NO_POOL",
            "DAILY_SAVED",
            "DAILY_OVERSPENT",
        ])
        expect(report.insights.map((insight) => insight.id)).not.toContain("DAILY_ALL_DONE")
        expect(report.dataQuality).toEqual({
            approximate: false,
            partialTimeCoverage: false,
            reasons: [],
        })
    })

    it("U2 - NO_PLAN with no plan and no tasks; budget fields stay null", async () => {
        installFixture([], [])

        const report = await getDailyCoachReport({
            userId: USER_ID,
            dayKey: DAY_KEY,
            todayKey: TODAY_KEY,
        })

        expect(report.state).toBe("NO_PLAN")
        expect(report.facts.totalTasks).toBe(0)
        expect(report.facts.completionPct).toBeNull()
        expect(report.facts.budget).toBeNull()
        expect(report.facts.poolMinutes).toBeNull()
        expect(report.facts.overCommittedMinutes).toBeNull()
        expect(report.insights).toEqual([])
        expect(report.dataQuality).toEqual({
            approximate: false,
            partialTimeCoverage: false,
            reasons: [],
        })
    })

    it("U3 - NO_TASKS when a plan exists but there are no tasks", async () => {
        installFixture([makePlan({ dayKey: DAY_KEY, availableMinutes: 240 })], [])

        const report = await getDailyCoachReport({
            userId: USER_ID,
            dayKey: DAY_KEY,
            todayKey: TODAY_KEY,
        })

        expect(report.state).toBe("NO_TASKS")
        expect(report.facts.budget).toEqual({ availableMinutes: 240, committedMinutes: 0 })
        expect(report.facts.poolMinutes).toBe(240)
        expect(report.facts.overCommittedMinutes).toBe(0)
        expect(report.insights).toEqual([])
    })

    it("U4 - a DONE day without a plan is OK and may emit DAILY_ALL_DONE", async () => {
        installFixture(
            [],
            [
                makeTask({
                    dayKey: "2026-03-01",
                    completedOn: DAY_KEY,
                    status: "DONE",
                    allocatedMinutes: null,
                    spentMinutes: null,
                }),
            ],
        )

        const report = await getDailyCoachReport({
            userId: USER_ID,
            dayKey: DAY_KEY,
            todayKey: TODAY_KEY,
        })

        expect(report.state).toBe("OK")
        expect(report.facts.doneTasks).toBe(1)
        expect(report.facts.openTasks).toBe(0)
        expect(report.facts.totalTasks).toBe(1)
        expect(report.facts.timedDoneTasks).toBe(0)
        expect(report.facts.budget).toBeNull()
        expect(report.insights).toEqual([
            { id: "DAILY_ALL_DONE", params: { totalTasks: 1 } },
        ])
        expect(report.dataQuality).toEqual({
            approximate: false,
            partialTimeCoverage: true,
            reasons: ["PARTIAL_TIME_COVERAGE"],
        })
    })

    it("U5 - DONE without spentMinutes counts as done but not as timed", async () => {
        installFixture(
            [makePlan({ dayKey: DAY_KEY, availableMinutes: 400 })],
            [
                makeTask({
                    dayKey: DAY_KEY,
                    completedOn: DAY_KEY,
                    status: "DONE",
                    allocatedMinutes: 100,
                    spentMinutes: 70,
                }),
                makeTask({
                    dayKey: DAY_KEY,
                    completedOn: DAY_KEY,
                    status: "DONE",
                    allocatedMinutes: 50,
                    spentMinutes: 60,
                }),
                makeTask({
                    dayKey: DAY_KEY,
                    completedOn: DAY_KEY,
                    status: "DONE",
                    allocatedMinutes: 80,
                    spentMinutes: null,
                }),
            ],
        )

        const report = await getDailyCoachReport({
            userId: USER_ID,
            dayKey: DAY_KEY,
            todayKey: TODAY_KEY,
        })

        expect(report.facts.doneTasks).toBe(3)
        expect(report.facts.openTasks).toBe(0)
        expect(report.facts.timedDoneTasks).toBe(2)
        expect(report.facts.spentMinutes).toBe(130)
        expect(report.facts.savedMinutes).toBe(30)
        expect(report.facts.overspentMinutes).toBe(10)
        expect(report.dataQuality.partialTimeCoverage).toBe(true)
    })

    it("U6 - daily report performs exactly two reads", async () => {
        installFixture(DAILY_PLANS, DAILY_TASKS)

        await getDailyCoachReport({
            userId: USER_ID,
            dayKey: DAY_KEY,
            todayKey: TODAY_KEY,
        })

        expect(prismaMock.dailyPlan.findUnique).toHaveBeenCalledTimes(1)
        expect(prismaMock.task.findMany).toHaveBeenCalledTimes(1)
        expect(prismaMock.dailyPlan.findMany).not.toHaveBeenCalled()
    })

    it("U13 - every where clause is scoped to the session userId and selects no PII", async () => {
        installFixture(DAILY_PLANS, DAILY_TASKS)

        await getDailyCoachReport({
            userId: USER_ID,
            dayKey: DAY_KEY,
            todayKey: TODAY_KEY,
        })

        const planArgs = prismaMock.dailyPlan.findUnique.mock.calls[0][0]
        expect(planArgs.where).toEqual({
            userId_dayKey: { userId: USER_ID, dayKey: DAY_KEY },
        })
        expect(Object.keys(planArgs.select).sort()).toEqual(["availableMinutes"])

        const taskArgs = prismaMock.task.findMany.mock.calls[0][0]
        expect(taskArgs.where.userId).toBe(USER_ID)
        expect(Object.keys(taskArgs.select).sort()).toEqual([
            "allocatedMinutes",
            "completedOn",
            "dayKey",
            "spentMinutes",
            "status",
        ])
    })

    it("U14 - daily report never writes", async () => {
        installFixture(DAILY_PLANS, DAILY_TASKS)

        await getDailyCoachReport({
            userId: USER_ID,
            dayKey: DAY_KEY,
            todayKey: TODAY_KEY,
        })

        expectNoCoachWrites()
    })

    it("U15 - Prisma errors propagate instead of being swallowed", async () => {
        prismaMock.dailyPlan.findUnique.mockRejectedValue(
            new Error("P1001: database unreachable"),
        )

        await expect(
            getDailyCoachReport({
                userId: USER_ID,
                dayKey: DAY_KEY,
                todayKey: TODAY_KEY,
            }),
        ).rejects.toThrow("P1001: database unreachable")
    })

    it("U18 - negative stored minutes are not clamped; the engine RangeError surfaces", async () => {
        installFixture(
            [makePlan({ dayKey: DAY_KEY, availableMinutes: 100 })],
            [
                makeTask({
                    dayKey: DAY_KEY,
                    status: "TODO",
                    allocatedMinutes: -1,
                }),
            ],
        )

        await expect(
            getDailyCoachReport({
                userId: USER_ID,
                dayKey: DAY_KEY,
                todayKey: TODAY_KEY,
            }),
        ).rejects.toThrow(/INVALID:allocatedMinutes/)
    })

    it("U18b - negative spentMinutes also surfaces as a RangeError", async () => {
        installFixture(
            [makePlan({ dayKey: DAY_KEY, availableMinutes: 100 })],
            [
                makeTask({
                    dayKey: DAY_KEY,
                    completedOn: DAY_KEY,
                    status: "DONE",
                    allocatedMinutes: 10,
                    spentMinutes: -5,
                }),
            ],
        )

        await expect(
            getDailyCoachReport({
                userId: USER_ID,
                dayKey: DAY_KEY,
                todayKey: TODAY_KEY,
            }),
        ).rejects.toThrow(/INVALID:spentMinutes/)
    })

    it("U19 - budget and time formulas match the real planner getDaySummary", async () => {
        installFixture(DAILY_PLANS, DAILY_TASKS)

        const report = await getDailyCoachReport({
            userId: USER_ID,
            dayKey: DAY_KEY,
            todayKey: TODAY_KEY,
        })
        const summary = await getDaySummary(USER_ID, DAY_KEY)

        expect(report.facts.doneTasks).toBe(summary.doneTasks)
        expect(report.facts.openTasks).toBe(summary.openTasks)
        expect(report.facts.totalTasks).toBe(summary.totalTasks)
        expect(report.facts.spentMinutes).toBe(summary.spentMinutes)
        expect(report.facts.savedMinutes).toBe(summary.savedMinutes)
        expect(report.facts.overspentMinutes).toBe(summary.overspentMinutes)
        expect(report.facts.budget).toEqual({
            availableMinutes: summary.availableMinutes,
            committedMinutes: summary.committedMinutes,
        })
        expect(report.facts.poolMinutes).toBe(summary.poolMinutes)
        expect(report.facts.overCommittedMinutes).toBe(summary.overCommittedMinutes)
    })

    it("rejects invalid and future day keys before any query", async () => {
        for (const dayKey of ["2026-02-30", "2026-13-01", "05-03-2026"]) {
            await expect(
                getDailyCoachReport({ userId: USER_ID, dayKey, todayKey: TODAY_KEY }),
            ).rejects.toThrow(RangeError)
        }

        await expect(
            getDailyCoachReport({
                userId: USER_ID,
                dayKey: "2026-03-06",
                todayKey: TODAY_KEY,
            }),
        ).rejects.toThrow(/INVALID:futureDay/)

        expect(prismaMock.dailyPlan.findUnique).not.toHaveBeenCalled()
        expect(prismaMock.task.findMany).not.toHaveBeenCalled()
    })

    it("never leaks another user's rows when the fixture belongs to someone else", async () => {
        installFixture(
            [makePlan({ userId: OTHER_USER_ID, dayKey: DAY_KEY, availableMinutes: 480 })],
            [
                makeTask({
                    userId: OTHER_USER_ID,
                    dayKey: DAY_KEY,
                    status: "TODO",
                    allocatedMinutes: 120,
                }),
            ],
        )

        const report = await getDailyCoachReport({
            userId: USER_ID,
            dayKey: DAY_KEY,
            todayKey: TODAY_KEY,
        })

        expect(report.state).toBe("NO_PLAN")
        expect(report.facts.doneTasks).toBe(0)
        expect(report.facts.openTasks).toBe(0)
    })
})

/* ============================== weekly report ============================== */

describe("getWeeklyCoachReport", () => {
    beforeEach(resetPrisma)

    it("U7/U9/U10/U11/U12 - aggregates covered days only and keeps all seven days", async () => {
        installFixture(WEEK_PLANS, WEEK_TASKS)

        const report = await getWeeklyCoachReport({
            userId: USER_ID,
            weekStart: WEEK_START,
            todayKey: WEEK_TODAY,
        })

        expect(report.kind).toBe("weekly")
        expect(report.weekStart).toBe(WEEK_START)
        expect(report.weekEnd).toBe("2026-11-06")
        expect(report.coveredThrough).toBe(WEEK_TODAY)
        expect(report.state).toBe("OK")
        expect(report.days.map((day) => day.dayKey)).toEqual(WEEK_DAY_KEYS)

        expect(report.facts).toEqual({
            doneTotal: 7,
            openTotal: 3,
            totalTasks: 10,
            timedDoneTasks: 5,
            completionPct: 70,
            spentTotal: 200,
            savedTotal: 20,
            overspentTotal: 10,
            coveredDayCount: 4,
            plannedDays: 3,
            activeDays: 4,
            peakDayKey: "2026-11-03",
            peakDayDoneTasks: 3,
        })

        // U9 - DONE counted on completedOn, not on its (outside-week) dayKey.
        expect(report.days[0]).toEqual({
            dayKey: "2026-10-31",
            hasPlan: true,
            doneTasks: 2,
            openTasks: 1,
            isCovered: true,
        })
        // U10 - open task counted on its dayKey.
        expect(report.days[1]).toEqual({
            dayKey: "2026-11-01",
            hasPlan: true,
            doneTasks: 1,
            openTasks: 1,
            isCovered: true,
        })
        expect(report.days[2]).toEqual({
            dayKey: "2026-11-02",
            hasPlan: false,
            doneTasks: 1,
            openTasks: 0,
            isCovered: true,
        })
        expect(report.days[3]).toEqual({
            dayKey: "2026-11-03",
            hasPlan: true,
            doneTasks: 3,
            openTasks: 1,
            isCovered: true,
        })

        // U8 - future days stay in days[] but are never covered.
        expect(report.days[4]).toEqual({
            dayKey: "2026-11-04",
            hasPlan: true,
            doneTasks: 0,
            openTasks: 1,
            isCovered: false,
        })
        expect(report.days[5]).toEqual({
            dayKey: "2026-11-05",
            hasPlan: false,
            doneTasks: 1,
            openTasks: 0,
            isCovered: false,
        })
        expect(report.days[6]).toEqual({
            dayKey: "2026-11-06",
            hasPlan: false,
            doneTasks: 0,
            openTasks: 0,
            isCovered: false,
        })

        expect(report.insights.map((insight) => insight.id)).toEqual([
            "WEEK_PEAK_DAY",
            "WEEK_COMPLETION",
            "WEEK_SAVED",
        ])
        expect(report.dataQuality).toEqual({
            approximate: true,
            partialTimeCoverage: true,
            reasons: ["PAST_DAY_ROLLOVER", "PARTIAL_TIME_COVERAGE"],
        })
    })

    it("U8 - future data alone yields NO_DATA and never touches totals", async () => {
        installFixture(
            [makePlan({ dayKey: "2026-11-04", availableMinutes: 120 })],
            [
                makeTask({ dayKey: "2026-11-04", status: "TODO", allocatedMinutes: 60 }),
                makeTask({
                    dayKey: "2026-11-04",
                    completedOn: "2026-11-04",
                    status: "DONE",
                    allocatedMinutes: 30,
                    spentMinutes: 20,
                }),
            ],
        )

        const report = await getWeeklyCoachReport({
            userId: USER_ID,
            weekStart: WEEK_START,
            todayKey: WEEK_TODAY,
        })

        expect(report.state).toBe("NO_DATA")
        expect(report.facts.doneTotal).toBe(0)
        expect(report.facts.openTotal).toBe(0)
        expect(report.facts.totalTasks).toBe(0)
        expect(report.facts.timedDoneTasks).toBe(0)
        expect(report.facts.spentTotal).toBe(0)
        expect(report.facts.completionPct).toBeNull()
        expect(report.facts.coveredDayCount).toBe(4)
        expect(report.facts.plannedDays).toBe(0)
        expect(report.insights).toEqual([])
        expect(report.days[4]).toEqual({
            dayKey: "2026-11-04",
            hasPlan: true,
            doneTasks: 1,
            openTasks: 1,
            isCovered: false,
        })
        expect(report.dataQuality).toEqual({
            approximate: true,
            partialTimeCoverage: false,
            reasons: ["PAST_DAY_ROLLOVER"],
        })
    })

    it("U11 - future DONE minutes are excluded from timedDoneTasks", async () => {
        installFixture(
            [],
            [
                makeTask({
                    dayKey: "2026-11-03",
                    completedOn: "2026-11-03",
                    status: "DONE",
                    allocatedMinutes: 20,
                    spentMinutes: 10,
                }),
                makeTask({
                    dayKey: "2026-11-05",
                    completedOn: "2026-11-05",
                    status: "DONE",
                    allocatedMinutes: 40,
                    spentMinutes: 20,
                }),
            ],
        )

        const report = await getWeeklyCoachReport({
            userId: USER_ID,
            weekStart: WEEK_START,
            todayKey: WEEK_TODAY,
        })

        expect(report.state).toBe("OK")
        expect(report.facts.doneTotal).toBe(1)
        expect(report.facts.timedDoneTasks).toBe(1)
        expect(report.dataQuality.partialTimeCoverage).toBe(false)
    })

    it("U6 - weekly report performs exactly two reads (no N+1)", async () => {
        installFixture(WEEK_PLANS, WEEK_TASKS)

        await getWeeklyCoachReport({
            userId: USER_ID,
            weekStart: WEEK_START,
            todayKey: WEEK_TODAY,
        })

        expect(prismaMock.dailyPlan.findMany).toHaveBeenCalledTimes(1)
        expect(prismaMock.task.findMany).toHaveBeenCalledTimes(1)
        expect(prismaMock.dailyPlan.findUnique).not.toHaveBeenCalled()
    })

    it("U13 - weekly where clauses are scoped to the session userId", async () => {
        installFixture(WEEK_PLANS, WEEK_TASKS)

        await getWeeklyCoachReport({
            userId: USER_ID,
            weekStart: WEEK_START,
            todayKey: WEEK_TODAY,
        })

        const planArgs = prismaMock.dailyPlan.findMany.mock.calls[0][0]
        expect(planArgs.where).toEqual({
            userId: USER_ID,
            dayKey: { in: WEEK_DAY_KEYS },
        })

        const taskArgs = prismaMock.task.findMany.mock.calls[0][0]
        expect(taskArgs.where.userId).toBe(USER_ID)
        expect(Object.keys(taskArgs.select).sort()).toEqual([
            "allocatedMinutes",
            "completedOn",
            "dayKey",
            "spentMinutes",
            "status",
        ])
    })

    it("U14 - weekly report never writes", async () => {
        installFixture(WEEK_PLANS, WEEK_TASKS)

        await getWeeklyCoachReport({
            userId: USER_ID,
            weekStart: WEEK_START,
            todayKey: WEEK_TODAY,
        })

        expectNoCoachWrites()
    })

    it("U15 - weekly Prisma errors propagate", async () => {
        prismaMock.task.findMany.mockRejectedValue(new Error("P2024: pool timeout"))

        await expect(
            getWeeklyCoachReport({
                userId: USER_ID,
                weekStart: WEEK_START,
                todayKey: WEEK_TODAY,
            }),
        ).rejects.toThrow("P2024: pool timeout")
    })

    it("rejects a non-Saturday weekStart before any query", async () => {
        await expect(
            getWeeklyCoachReport({
                userId: USER_ID,
                weekStart: "2026-11-01",
                todayKey: WEEK_TODAY,
            }),
        ).rejects.toThrow(/INVALID:weekStart/)

        expect(prismaMock.dailyPlan.findMany).not.toHaveBeenCalled()
        expect(prismaMock.task.findMany).not.toHaveBeenCalled()
    })

    it("rejects a future week before any query", async () => {
        await expect(
            getWeeklyCoachReport({
                userId: USER_ID,
                weekStart: "2026-11-07",
                todayKey: WEEK_TODAY,
            }),
        ).rejects.toThrow(/INVALID:futureWeek/)

        expect(prismaMock.dailyPlan.findMany).not.toHaveBeenCalled()
        expect(prismaMock.task.findMany).not.toHaveBeenCalled()
    })

    it("never includes another user's rows", async () => {
        installFixture(
            [
                makePlan({
                    userId: OTHER_USER_ID,
                    dayKey: "2026-11-03",
                    availableMinutes: 300,
                }),
            ],
            [
                makeTask({
                    userId: OTHER_USER_ID,
                    dayKey: "2026-11-03",
                    completedOn: "2026-11-03",
                    status: "DONE",
                    allocatedMinutes: 60,
                    spentMinutes: 50,
                }),
            ],
        )

        const report = await getWeeklyCoachReport({
            userId: USER_ID,
            weekStart: WEEK_START,
            todayKey: WEEK_TODAY,
        })

        expect(report.state).toBe("NO_DATA")
        expect(report.facts.doneTotal).toBe(0)
        expect(report.facts.plannedDays).toBe(0)
    })
})

/* ==================== F5 - per-row minute validation ==================== */
/* A corrupt row must fail before aggregation. Otherwise a negative value */
/* can be cancelled by a positive one and the report silently lies.       */

describe("F5 - per-row minute validation", () => {
    beforeEach(resetPrisma)

    function daily(plans: PlanRow[], tasks: TaskRow[]) {
        installFixture(plans, tasks)
        return getDailyCoachReport({
            userId: USER_ID,
            dayKey: DAY_KEY,
            todayKey: TODAY_KEY,
        })
    }

    function weekly(plans: PlanRow[], tasks: TaskRow[]) {
        installFixture(plans, tasks)
        return getWeeklyCoachReport({
            userId: USER_ID,
            weekStart: WEEK_START,
            todayKey: WEEK_TODAY,
        })
    }

    /* ------------------------------ spentMinutes ------------------------------ */

    it("rejects a single DONE row with spentMinutes=-1", async () => {
        await expect(
            daily(
                [makePlan()],
                [
                    makeTask({
                        completedOn: DAY_KEY,
                        status: "DONE",
                        allocatedMinutes: 10,
                        spentMinutes: -1,
                    }),
                ],
            ),
        ).rejects.toThrow(/INVALID:spentMinutes/)
    })

    it("rejects spentMinutes=-100 even when another row would cancel it to +50", async () => {
        // Without per-row validation the day total is 50 and the corruption is invisible.
        await expect(
            daily(
                [makePlan()],
                [
                    makeTask({
                        completedOn: DAY_KEY,
                        status: "DONE",
                        allocatedMinutes: 100,
                        spentMinutes: -100,
                    }),
                    makeTask({
                        completedOn: DAY_KEY,
                        status: "DONE",
                        allocatedMinutes: 100,
                        spentMinutes: 150,
                    }),
                ],
            ),
        ).rejects.toThrow(/INVALID:spentMinutes/)
    })

    it("rejects negative spentMinutes that would inflate savedMinutes", async () => {
        // savedForTask would become max(0, 50 - (-100)) = 150 without row validation.
        await expect(
            daily(
                [makePlan()],
                [
                    makeTask({
                        completedOn: DAY_KEY,
                        status: "DONE",
                        allocatedMinutes: 50,
                        spentMinutes: -100,
                    }),
                ],
            ),
        ).rejects.toThrow(/INVALID:spentMinutes/)
    })

    it("accepts spentMinutes=0", async () => {
        const report = await daily(
            [makePlan()],
            [
                makeTask({
                    completedOn: DAY_KEY,
                    status: "DONE",
                    allocatedMinutes: 10,
                    spentMinutes: 0,
                }),
            ],
        )

        expect(report.facts.spentMinutes).toBe(0)
        expect(report.facts.timedDoneTasks).toBe(1)
        expect(report.facts.savedMinutes).toBe(10)
        expect(report.facts.overspentMinutes).toBe(0)
    })

    it("keeps positive and null spentMinutes behaviour unchanged", async () => {
        const report = await daily(
            [makePlan()],
            [
                makeTask({
                    completedOn: DAY_KEY,
                    status: "DONE",
                    allocatedMinutes: 30,
                    spentMinutes: 40,
                }),
                makeTask({
                    completedOn: DAY_KEY,
                    status: "DONE",
                    allocatedMinutes: 50,
                    spentMinutes: null,
                }),
            ],
        )

        // null is neither timed nor spent; the positive row keeps its exact math.
        expect(report.facts.spentMinutes).toBe(40)
        expect(report.facts.timedDoneTasks).toBe(1)
        expect(report.facts.savedMinutes).toBe(0)
        expect(report.facts.overspentMinutes).toBe(10)
    })

    it("rejects fractional and unsafe spentMinutes", async () => {
        for (const value of [1.5, 2 ** 53]) {
            await expect(
                daily(
                    [],
                    [
                        makeTask({
                            completedOn: DAY_KEY,
                            status: "DONE",
                            allocatedMinutes: 10,
                            spentMinutes: value,
                        }),
                    ],
                ),
            ).rejects.toThrow(/INVALID:spentMinutes/)
        }
    })

    /* ---------------------------- allocatedMinutes ---------------------------- */

    it("rejects negative allocatedMinutes on an open task before summing", async () => {
        await expect(
            daily(
                [makePlan()],
                [
                    makeTask({ status: "TODO", allocatedMinutes: -5 }),
                    makeTask({ status: "TODO", allocatedMinutes: 10 }),
                ],
            ),
        ).rejects.toThrow(/INVALID:allocatedMinutes/)
    })

    it("rejects negative allocatedMinutes on a DONE task (would inflate overspentMinutes)", async () => {
        await expect(
            daily(
                [makePlan()],
                [
                    makeTask({
                        completedOn: DAY_KEY,
                        status: "DONE",
                        allocatedMinutes: -50,
                        spentMinutes: 10,
                    }),
                ],
            ),
        ).rejects.toThrow(/INVALID:allocatedMinutes/)
    })

    it("rejects fractional and unsafe allocatedMinutes", async () => {
        for (const value of [0.5, -(2 ** 53)]) {
            await expect(
                daily([makePlan()], [makeTask({ status: "TODO", allocatedMinutes: value })]),
            ).rejects.toThrow(/INVALID:allocatedMinutes/)
        }
    })

    it("accepts zero, positive and null allocatedMinutes", async () => {
        const report = await daily(
            [makePlan({ availableMinutes: 100 })],
            [
                makeTask({ status: "TODO", allocatedMinutes: 0 }),
                makeTask({ status: "TODO", allocatedMinutes: 30 }),
                makeTask({ status: "TODO", allocatedMinutes: null }),
            ],
        )

        expect(report.facts.budget).toEqual({
            availableMinutes: 100,
            committedMinutes: 30,
        })
    })

    /* --------------------------- availableMinutes --------------------------- */

    it("rejects a negative DailyPlan.availableMinutes", async () => {
        await expect(
            daily([makePlan({ availableMinutes: -1 })], []),
        ).rejects.toThrow(/INVALID:availableMinutes/)
    })

    it("rejects fractional and unsafe availableMinutes", async () => {
        for (const value of [1.5, 2 ** 53]) {
            await expect(
                daily([makePlan({ availableMinutes: value })], []),
            ).rejects.toThrow(/INVALID:availableMinutes/)
        }
    })

    it("accepts zero and positive availableMinutes", async () => {
        const zero = await daily([makePlan({ availableMinutes: 0 })], [])
        expect(zero.state).toBe("NO_TASKS")
        expect(zero.facts.budget).toEqual({ availableMinutes: 0, committedMinutes: 0 })

        const positive = await daily([makePlan({ availableMinutes: 240 })], [])
        expect(positive.facts.budget).toEqual({
            availableMinutes: 240,
            committedMinutes: 0,
        })
    })

    it("keeps the no-plan behaviour (hasPlan=false, null budget)", async () => {
        const report = await daily([], [])

        expect(report.state).toBe("NO_PLAN")
        expect(report.facts.budget).toBeNull()
        expect(report.facts.poolMinutes).toBeNull()
        expect(report.facts.overCommittedMinutes).toBeNull()
    })

    /* -------------------------------- weekly -------------------------------- */

    it("weekly rejects a masked negative spentMinutes on a covered day", async () => {
        await expect(
            weekly(
                [],
                [
                    makeTask({
                        dayKey: "2026-11-01",
                        completedOn: "2026-11-01",
                        status: "DONE",
                        allocatedMinutes: 100,
                        spentMinutes: -100,
                    }),
                    makeTask({
                        dayKey: "2026-11-01",
                        completedOn: "2026-11-01",
                        status: "DONE",
                        allocatedMinutes: 100,
                        spentMinutes: 150,
                    }),
                ],
            ),
        ).rejects.toThrow(/INVALID:spentMinutes/)
    })

    it("weekly rejects a negative plan value", async () => {
        await expect(
            weekly([makePlan({ dayKey: "2026-11-02", availableMinutes: -100 })], []),
        ).rejects.toThrow(/INVALID:availableMinutes/)
    })

    it("weekly rejects a negative allocatedMinutes on an open task", async () => {
        await expect(
            weekly(
                [],
                [
                    makeTask({
                        dayKey: "2026-11-02",
                        status: "TODO",
                        allocatedMinutes: -5,
                    }),
                ],
            ),
        ).rejects.toThrow(/INVALID:allocatedMinutes/)
    })

    it("row validation keeps exactly two reads and never writes", async () => {
        await expect(
            daily([makePlan()], [makeTask({ status: "TODO", allocatedMinutes: -5 })]),
        ).rejects.toThrow(RangeError)

        expect(prismaMock.dailyPlan.findUnique).toHaveBeenCalledTimes(1)
        expect(prismaMock.task.findMany).toHaveBeenCalledTimes(1)
        expectNoCoachWrites()
    })
})
