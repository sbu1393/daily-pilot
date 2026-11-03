import { describe, expect, it } from "vitest"
import type { DayFacts, Insight } from "./types"
import { buildDailyReport } from "./dailyReport"

const MAX = Number.MAX_SAFE_INTEGER
const TODAY = "2026-11-03"
const YESTERDAY = "2026-11-02"
const TOMORROW = "2026-11-04"

function fact(dayKey: string, overrides: Partial<DayFacts> = {}): DayFacts {
    return {
        dayKey,
        hasPlan: true,
        availableMinutes: 480,
        committedMinutes: 300,
        poolMinutes: 180,
        overCommittedMinutes: 0,
        doneTasks: 0,
        openTasks: 0,
        spentMinutes: 0,
        savedMinutes: 0,
        overspentMinutes: 0,
        ...overrides,
    }
}

function ids(insights: readonly Insight[]): string[] {
    return insights.map((insight) => insight.id)
}

/** Walk every nested value and assert numbers are safe; percentages stay in 0..100. */
function assertSafeNumbers(value: unknown, path: string, isPercent = false): void {
    if (typeof value === "number") {
        expect(Number.isFinite(value), `${path} finite`).toBe(true)
        expect(Number.isSafeInteger(value), `${path} safe integer`).toBe(true)
        if (isPercent) {
            expect(value, `${path} range`).toBeGreaterThanOrEqual(0)
            expect(value, `${path} range`).toBeLessThanOrEqual(100)
        }
        return
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => assertSafeNumbers(item, `${path}[${index}]`))
        return
    }
    if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
            assertSafeNumbers(child, `${path}.${key}`, key === "completionPct")
        }
    }
}

describe("buildDailyReport - states", () => {
    it("returns NO_PLAN for an empty day without a plan", () => {
        const report = buildDailyReport({
            todayKey: TODAY,
            day: fact(TODAY, { hasPlan: false, poolMinutes: 0, overCommittedMinutes: 7 }),
            timedDoneTasks: 0,
        })

        expect(report.kind).toBe("daily")
        expect(report.dayKey).toBe(TODAY)
        expect(report.state).toBe("NO_PLAN")
        expect(report.insights).toEqual([])
        expect(report.facts.totalTasks).toBe(0)
        expect(report.facts.completionPct).toBeNull()
        expect(report.facts.budget).toBeNull()
        expect(report.facts.poolMinutes).toBeNull()
        expect(report.facts.overCommittedMinutes).toBeNull()
    })

    it("returns NO_TASKS for a planned day without tasks", () => {
        const report = buildDailyReport({
            todayKey: TODAY,
            day: fact(TODAY),
            timedDoneTasks: 0,
        })

        expect(report.state).toBe("NO_TASKS")
        expect(report.insights).toEqual([])
        expect(report.facts.budget).toEqual({
            availableMinutes: 480,
            committedMinutes: 300,
        })
        expect(report.facts.poolMinutes).toBe(180)
        expect(report.facts.overCommittedMinutes).toBe(0)
        expect(report.facts.completionPct).toBeNull()
    })

    it("returns OK when tasks exist even without a plan", () => {
        const report = buildDailyReport({
            todayKey: TODAY,
            day: fact(TODAY, { hasPlan: false, doneTasks: 1 }),
            timedDoneTasks: 0,
        })

        expect(report.state).toBe("OK")
        expect(report.facts.budget).toBeNull()
        expect(ids(report.insights)).toEqual(["DAILY_ALL_DONE"])
    })

    it("returns OK for a planned day with open tasks", () => {
        const report = buildDailyReport({
            todayKey: TODAY,
            day: fact(TODAY, { doneTasks: 1, openTasks: 1 }),
            timedDoneTasks: 0,
        })

        expect(report.state).toBe("OK")
        expect(report.facts.totalTasks).toBe(2)
        expect(report.facts.completionPct).toBe(50)
        expect(report.insights).toEqual([])
    })
})

describe("buildDailyReport - facts", () => {
    it("copies validated numbers and derives totalTasks and completionPct", () => {
        const report = buildDailyReport({
            todayKey: TODAY,
            day: fact(TODAY, {
                availableMinutes: 600,
                committedMinutes: 200,
                poolMinutes: 400,
                overCommittedMinutes: 0,
                doneTasks: 3,
                openTasks: 2,
                spentMinutes: 90,
                savedMinutes: 15,
                overspentMinutes: 5,
            }),
            timedDoneTasks: 2,
        })

        expect(report.facts).toEqual({
            doneTasks: 3,
            openTasks: 2,
            totalTasks: 5,
            timedDoneTasks: 2,
            completionPct: 60,
            spentMinutes: 90,
            savedMinutes: 15,
            overspentMinutes: 5,
            budget: { availableMinutes: 600, committedMinutes: 200 },
            poolMinutes: 400,
            overCommittedMinutes: 0,
        })
    })

    it("does not mutate its inputs", () => {
        const day = Object.freeze(fact(TODAY, { doneTasks: 2, savedMinutes: 4 }))
        const input = Object.freeze({ todayKey: TODAY, day, timedDoneTasks: 1 })
        const snapshot = JSON.parse(JSON.stringify(input))

        const report = buildDailyReport(input)

        expect(report.facts.doneTasks).toBe(2)
        expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot)
    })
})

describe("buildDailyReport - validation", () => {
    it("rejects future days", () => {
        expect(() =>
            buildDailyReport({ todayKey: TODAY, day: fact(TOMORROW), timedDoneTasks: 0 }),
        ).toThrow(RangeError)
    })

    it("accepts past and current days", () => {
        expect(() =>
            buildDailyReport({ todayKey: TODAY, day: fact(YESTERDAY), timedDoneTasks: 0 }),
        ).not.toThrow()
        expect(() =>
            buildDailyReport({ todayKey: TODAY, day: fact(TODAY), timedDoneTasks: 0 }),
        ).not.toThrow()
    })

    it("rejects invalid keys and malformed input objects", () => {
        expect(() =>
            buildDailyReport({ todayKey: "2026-02-30", day: fact(TODAY), timedDoneTasks: 0 }),
        ).toThrow(RangeError)
        expect(() =>
            buildDailyReport({
                todayKey: TODAY,
                day: fact("2026-02-30"),
                timedDoneTasks: 0,
            }),
        ).toThrow(RangeError)
        expect(() =>
            buildDailyReport(null as unknown as Parameters<typeof buildDailyReport>[0]),
        ).toThrow(RangeError)
    })

    it("rejects non-boolean hasPlan", () => {
        const day = fact(TODAY, { hasPlan: "yes" as unknown as boolean })
        expect(() => buildDailyReport({ todayKey: TODAY, day, timedDoneTasks: 0 })).toThrow(
            RangeError,
        )
    })

    const numericFields: Array<keyof Omit<DayFacts, "dayKey" | "hasPlan">> = [
        "availableMinutes",
        "committedMinutes",
        "poolMinutes",
        "overCommittedMinutes",
        "doneTasks",
        "openTasks",
        "spentMinutes",
        "savedMinutes",
        "overspentMinutes",
    ]

    it("rejects NaN, infinities, fractions, unsafe integers and negatives in every DayFacts number", () => {
        const invalid = [Number.NaN, Infinity, -Infinity, 1.5, 2 ** 53, -(2 ** 53), -1, -0.0001]
        for (const field of numericFields) {
            for (const value of invalid) {
                const day = { ...fact(TODAY), [field]: value } as DayFacts
                expect(
                    () => buildDailyReport({ todayKey: TODAY, day, timedDoneTasks: 0 }),
                    `${field}=${String(value)}`,
                ).toThrow(RangeError)
            }
        }
    })

    it("rejects invalid timedDoneTasks and counts above doneTasks", () => {
        for (const value of [Number.NaN, Infinity, 1.5, 2 ** 53, -1]) {
            expect(() =>
                buildDailyReport({
                    todayKey: TODAY,
                    day: fact(TODAY, { doneTasks: 5 }),
                    timedDoneTasks: value,
                }),
            ).toThrow(RangeError)
        }
        expect(() =>
            buildDailyReport({
                todayKey: TODAY,
                day: fact(TODAY, { doneTasks: 2 }),
                timedDoneTasks: 3,
            }),
        ).toThrow(RangeError)
    })

    it("accepts negative zero as zero", () => {
        const report = buildDailyReport({
            todayKey: TODAY,
            day: fact(TODAY, { doneTasks: -0, openTasks: -0 }),
            timedDoneTasks: -0,
        })
        expect(report.facts.totalTasks === 0).toBe(true)
        expect(report.facts.completionPct).toBeNull()
    })
})

describe("buildDailyReport - data quality", () => {
    it("flags past days as approximate", () => {
        const report = buildDailyReport({
            todayKey: TODAY,
            day: fact(YESTERDAY, { doneTasks: 0 }),
            timedDoneTasks: 0,
        })
        expect(report.dataQuality.approximate).toBe(true)
        expect(report.dataQuality.partialTimeCoverage).toBe(false)
        expect(report.dataQuality.reasons).toEqual(["PAST_DAY_ROLLOVER"])
    })

    it("does not flag the current day as approximate", () => {
        const report = buildDailyReport({
            todayKey: TODAY,
            day: fact(TODAY, { doneTasks: 2 }),
            timedDoneTasks: 2,
        })
        expect(report.dataQuality.approximate).toBe(false)
        expect(report.dataQuality.partialTimeCoverage).toBe(false)
        expect(report.dataQuality.reasons).toEqual([])
    })

    it("flags untimed done tasks", () => {
        const report = buildDailyReport({
            todayKey: TODAY,
            day: fact(TODAY, { doneTasks: 3 }),
            timedDoneTasks: 1,
        })
        expect(report.dataQuality.approximate).toBe(false)
        expect(report.dataQuality.partialTimeCoverage).toBe(true)
        expect(report.dataQuality.reasons).toEqual(["PARTIAL_TIME_COVERAGE"])
    })

    it("keeps the reason order fixed when both flags are set", () => {
        const report = buildDailyReport({
            todayKey: TODAY,
            day: fact(YESTERDAY, { doneTasks: 3 }),
            timedDoneTasks: 1,
        })
        expect(report.dataQuality.reasons).toEqual([
            "PAST_DAY_ROLLOVER",
            "PARTIAL_TIME_COVERAGE",
        ])
    })
})

describe("buildDailyReport - insights", () => {
    it("emits DAILY_NONE_DONE when nothing is done and work remains", () => {
        const report = buildDailyReport({
            todayKey: TODAY,
            day: fact(TODAY, { openTasks: 2 }),
            timedDoneTasks: 0,
        })
        expect(ids(report.insights)).toEqual(["DAILY_NONE_DONE"])
        expect(report.insights[0]).toEqual({
            id: "DAILY_NONE_DONE",
            params: { openTasks: 2 },
        })
    })

    it("emits DAILY_ALL_DONE when nothing remains", () => {
        const report = buildDailyReport({
            todayKey: TODAY,
            day: fact(TODAY, { doneTasks: 2 }),
            timedDoneTasks: 1,
        })
        expect(ids(report.insights)).toEqual(["DAILY_ALL_DONE"])
        expect(report.insights[0]).toEqual({
            id: "DAILY_ALL_DONE",
            params: { totalTasks: 2 },
        })
    })

    it("emits DAILY_OVER_COMMITTED only for planned days", () => {
        const planned = buildDailyReport({
            todayKey: TODAY,
            day: fact(TODAY, { doneTasks: 1, overCommittedMinutes: 30 }),
            timedDoneTasks: 1,
        })
        expect(ids(planned.insights)).toEqual(["DAILY_ALL_DONE", "DAILY_OVER_COMMITTED"])
        expect(planned.insights[1]).toEqual({
            id: "DAILY_OVER_COMMITTED",
            params: { overCommittedMinutes: 30 },
        })

        const unplanned = buildDailyReport({
            todayKey: TODAY,
            day: fact(TODAY, { hasPlan: false, doneTasks: 1, overCommittedMinutes: 30 }),
            timedDoneTasks: 1,
        })
        expect(ids(unplanned.insights)).toEqual(["DAILY_ALL_DONE"])
    })

    it("emits DAILY_NO_POOL only for planned days with zero pool and open work", () => {
        const report = buildDailyReport({
            todayKey: TODAY,
            day: fact(TODAY, { openTasks: 1, poolMinutes: 0 }),
            timedDoneTasks: 0,
        })
        expect(ids(report.insights)).toEqual(["DAILY_NONE_DONE", "DAILY_NO_POOL"])
        expect(report.insights[1]).toEqual({
            id: "DAILY_NO_POOL",
            params: { openTasks: 1 },
        })

        const withoutPlan = buildDailyReport({
            todayKey: TODAY,
            day: fact(TODAY, { hasPlan: false, openTasks: 1, poolMinutes: 0 }),
            timedDoneTasks: 0,
        })
        expect(ids(withoutPlan.insights)).toEqual(["DAILY_NONE_DONE"])
    })

    it("emits DAILY_SAVED and DAILY_OVERSPENT only for positive amounts", () => {
        const saved = buildDailyReport({
            todayKey: TODAY,
            day: fact(TODAY, { doneTasks: 2, savedMinutes: 15 }),
            timedDoneTasks: 1,
        })
        expect(ids(saved.insights)).toEqual(["DAILY_ALL_DONE", "DAILY_SAVED"])
        expect(saved.insights[1]).toEqual({
            id: "DAILY_SAVED",
            params: { savedMinutes: 15, timedDoneTasks: 1, doneTasks: 2 },
        })

        const overspent = buildDailyReport({
            todayKey: TODAY,
            day: fact(TODAY, { doneTasks: 2, overspentMinutes: 5 }),
            timedDoneTasks: 2,
        })
        expect(ids(overspent.insights)).toEqual(["DAILY_ALL_DONE", "DAILY_OVERSPENT"])
        expect(overspent.insights[1]).toEqual({
            id: "DAILY_OVERSPENT",
            params: { overspentMinutes: 5, timedDoneTasks: 2, doneTasks: 2 },
        })

        const zero = buildDailyReport({
            todayKey: TODAY,
            day: fact(TODAY, { doneTasks: 1, savedMinutes: 0, overspentMinutes: 0 }),
            timedDoneTasks: 1,
        })
        expect(ids(zero.insights)).toEqual(["DAILY_ALL_DONE"])
    })

    it("emits insights in the fixed order", () => {
        const report = buildDailyReport({
            todayKey: TODAY,
            day: fact(TODAY, {
                doneTasks: 0,
                openTasks: 1,
                poolMinutes: 0,
                overCommittedMinutes: 5,
                savedMinutes: 1,
                overspentMinutes: 2,
            }),
            timedDoneTasks: 0,
        })
        expect(ids(report.insights)).toEqual([
            "DAILY_NONE_DONE",
            "DAILY_OVER_COMMITTED",
            "DAILY_NO_POOL",
            "DAILY_SAVED",
            "DAILY_OVERSPENT",
        ])
    })
})

describe("buildDailyReport - overflow guards", () => {
    it("rejects doneTasks + openTasks above MAX_SAFE_INTEGER", () => {
        expect(() =>
            buildDailyReport({
                todayKey: TODAY,
                day: fact(TODAY, { doneTasks: MAX, openTasks: 1 }),
                timedDoneTasks: 0,
            }),
        ).toThrow(RangeError)
        expect(() =>
            buildDailyReport({
                todayKey: TODAY,
                day: fact(TODAY, { doneTasks: MAX - 1, openTasks: 2 }),
                timedDoneTasks: 0,
            }),
        ).toThrow(RangeError)
    })

    it("accepts the maximum safe total", () => {
        const allOpen = buildDailyReport({
            todayKey: TODAY,
            day: fact(TODAY, { doneTasks: 0, openTasks: MAX }),
            timedDoneTasks: 0,
        })
        expect(allOpen.facts.totalTasks).toBe(MAX)
        expect(allOpen.facts.completionPct).toBe(0)

        const allDone = buildDailyReport({
            todayKey: TODAY,
            day: fact(TODAY, { doneTasks: MAX, openTasks: 0 }),
            timedDoneTasks: MAX,
        })
        expect(allDone.facts.totalTasks).toBe(MAX)
        expect(allDone.facts.completionPct).toBe(100)
    })

    it("computes correct percentages for a large safe total", () => {
        const half = 2 ** 51 - 1
        const report = buildDailyReport({
            todayKey: TODAY,
            day: fact(TODAY, { doneTasks: half, openTasks: half }),
            timedDoneTasks: 0,
        })
        expect(report.facts.totalTasks).toBe(2 ** 52 - 2)
        expect(report.facts.completionPct).toBe(50)
    })
})

describe("buildDailyReport - percentages", () => {
    it("rounds with Math.round and stays inside 0..100", () => {
        const table: Array<[number, number, number]> = [
            [1, 2, 33],
            [1, 7, 13],
            [7, 1, 88],
            [1, 199, 1],
            [0, 3, 0],
            [3, 0, 100],
            [1, 6, 14],
            [2, 3, 40],
        ]
        for (const [done, open, expected] of table) {
            const report = buildDailyReport({
                todayKey: TODAY,
                day: fact(TODAY, { doneTasks: done, openTasks: open }),
                timedDoneTasks: 0,
            })
            expect(report.facts.completionPct, `done=${done} open=${open}`).toBe(expected)
        }
    })
})

describe("buildDailyReport - DTO safety", () => {
    it("never exposes an unsafe number in facts or insight params", () => {
        const half = 2 ** 51 - 1
        const report = buildDailyReport({
            todayKey: YESTERDAY,
            day: fact(YESTERDAY, {
                doneTasks: half,
                openTasks: half,
                savedMinutes: MAX,
                overspentMinutes: MAX,
                overCommittedMinutes: MAX,
                poolMinutes: 0,
            }),
            timedDoneTasks: 0,
        })
        assertSafeNumbers(report.facts, "facts")
        assertSafeNumbers(report.insights, "insights")
        for (const insight of report.insights) {
            assertSafeNumbers(insight.params, `insight.${insight.id}`)
        }
    })
})
