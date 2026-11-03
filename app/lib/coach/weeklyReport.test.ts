import { describe, expect, it } from "vitest"
import type { DayFacts, Insight } from "./types"
import { buildWeeklyReport } from "./weeklyReport"
import { weekDaysOf } from "./week"

const MAX = Number.MAX_SAFE_INTEGER
const WEEK_START = "2026-10-31"
const KEYS = weekDaysOf(WEEK_START)
const TODAY_TUE = KEYS[3]
const TODAY_FRI = KEYS[6]
const NEXT_WEEK = "2026-11-07"

function day(dayKey: string, overrides: Partial<DayFacts> = {}): DayFacts {
    return {
        dayKey,
        hasPlan: false,
        availableMinutes: 480,
        committedMinutes: 0,
        poolMinutes: 480,
        overCommittedMinutes: 0,
        doneTasks: 0,
        openTasks: 0,
        spentMinutes: 0,
        savedMinutes: 0,
        overspentMinutes: 0,
        ...overrides,
    }
}

function week(overrides: Array<Partial<DayFacts>> = []): DayFacts[] {
    return KEYS.map((key, index) => day(key, overrides[index] ?? {}))
}

function ids(insights: readonly Insight[]): string[] {
    return insights.map((insight) => insight.id)
}

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

describe("buildWeeklyReport - shape and coverage", () => {
    it("returns exactly seven ascending days and the correct bounds", () => {
        const report = buildWeeklyReport({
            todayKey: TODAY_TUE,
            weekStart: WEEK_START,
            days: week([]),
            timedDoneTasks: 0,
        })

        expect(report.kind).toBe("weekly")
        expect(report.weekStart).toBe(WEEK_START)
        expect(report.weekEnd).toBe("2026-11-06")
        expect(report.coveredThrough).toBe(TODAY_TUE)
        expect(report.days.map((entry) => entry.dayKey)).toEqual([...KEYS])
        expect(report.days.map((entry) => entry.isCovered)).toEqual([
            true,
            true,
            true,
            true,
            false,
            false,
            false,
        ])
        expect(report.state).toBe("NO_DATA")
    })

    it("covers the whole week once today reaches Friday", () => {
        const report = buildWeeklyReport({
            todayKey: TODAY_FRI,
            weekStart: WEEK_START,
            days: week([]),
            timedDoneTasks: 0,
        })
        expect(report.days.every((entry) => entry.isCovered)).toBe(true)
        expect(report.facts.coveredDayCount).toBe(7)
        expect(report.coveredThrough).toBe(TODAY_FRI)
    })

    it("clamps coveredThrough to weekEnd for later today keys", () => {
        const report = buildWeeklyReport({
            todayKey: NEXT_WEEK,
            weekStart: WEEK_START,
            days: week([]),
            timedDoneTasks: 0,
        })
        expect(report.coveredThrough).toBe("2026-11-06")
        expect(report.facts.coveredDayCount).toBe(7)
    })

    it("works at both ends of the supported domain", () => {
        const first = buildWeeklyReport({
            todayKey: "0100-01-02",
            weekStart: "0100-01-02",
            days: weekDaysOf("0100-01-02").map((key) => day(key)),
            timedDoneTasks: 0,
        })
        expect(first.weekEnd).toBe("0100-01-08")
        expect(first.state).toBe("NO_DATA")

        const last = buildWeeklyReport({
            todayKey: "9999-12-31",
            weekStart: "9999-12-25",
            days: weekDaysOf("9999-12-25").map((key) => day(key)),
            timedDoneTasks: 0,
        })
        expect(last.weekEnd).toBe("9999-12-31")
        expect(last.state).toBe("NO_DATA")
    })
})

describe("buildWeeklyReport - validation", () => {
    it("rejects a weekStart that is not a Saturday", () => {
        expect(() =>
            buildWeeklyReport({
                todayKey: TODAY_TUE,
                weekStart: TODAY_TUE,
                days: week([]),
                timedDoneTasks: 0,
            }),
        ).toThrow(RangeError)
    })

    it("rejects a future week", () => {
        expect(() =>
            buildWeeklyReport({
                todayKey: "2026-10-30",
                weekStart: WEEK_START,
                days: week([]),
                timedDoneTasks: 0,
            }),
        ).toThrow(RangeError)
    })

    it("rejects invalid keys and malformed input objects", () => {
        expect(() =>
            buildWeeklyReport({
                todayKey: "2026-02-30",
                weekStart: WEEK_START,
                days: week([]),
                timedDoneTasks: 0,
            }),
        ).toThrow(RangeError)
        expect(() =>
            buildWeeklyReport({
                todayKey: TODAY_TUE,
                weekStart: "2026-02-28",
                days: week([]),
                timedDoneTasks: 0,
            }),
        ).toThrow(RangeError)
        expect(() =>
            buildWeeklyReport(null as unknown as Parameters<typeof buildWeeklyReport>[0]),
        ).toThrow(RangeError)
    })

    it("rejects days that are not exactly seven entries", () => {
        expect(() =>
            buildWeeklyReport({
                todayKey: TODAY_TUE,
                weekStart: WEEK_START,
                days: week([]).slice(0, 6),
                timedDoneTasks: 0,
            }),
        ).toThrow(RangeError)
        expect(() =>
            buildWeeklyReport({
                todayKey: TODAY_TUE,
                weekStart: WEEK_START,
                days: [...week([]), day("2026-11-07")],
                timedDoneTasks: 0,
            }),
        ).toThrow(RangeError)
        expect(() =>
            buildWeeklyReport({
                todayKey: TODAY_TUE,
                weekStart: WEEK_START,
                days: undefined as unknown as DayFacts[],
                timedDoneTasks: 0,
            }),
        ).toThrow(RangeError)
    })

    it("rejects days that are not contiguous and ascending from weekStart", () => {
        const shifted = week([])
        shifted[3] = { ...shifted[3], dayKey: KEYS[4] }
        expect(() =>
            buildWeeklyReport({
                todayKey: TODAY_TUE,
                weekStart: WEEK_START,
                days: shifted,
                timedDoneTasks: 0,
            }),
        ).toThrow(RangeError)

        const duplicated = week([])
        duplicated[1] = { ...duplicated[1], dayKey: KEYS[0] }
        expect(() =>
            buildWeeklyReport({
                todayKey: TODAY_TUE,
                weekStart: WEEK_START,
                days: duplicated,
                timedDoneTasks: 0,
            }),
        ).toThrow(RangeError)
    })

    it("rejects invalid DayFacts fields inside days[]", () => {
        const days = week([])
        days[2] = { ...days[2], doneTasks: -1 }
        expect(() =>
            buildWeeklyReport({
                todayKey: TODAY_TUE,
                weekStart: WEEK_START,
                days,
                timedDoneTasks: 0,
            }),
        ).toThrow(RangeError)

        const badPlan = week([])
        badPlan[0] = { ...badPlan[0], hasPlan: 1 as unknown as boolean }
        expect(() =>
            buildWeeklyReport({
                todayKey: TODAY_TUE,
                weekStart: WEEK_START,
                days: badPlan,
                timedDoneTasks: 0,
            }),
        ).toThrow(RangeError)
    })
})

describe("buildWeeklyReport - aggregation", () => {
    it("sums only covered days and derives every fact", () => {
        const report = buildWeeklyReport({
            todayKey: TODAY_TUE,
            weekStart: WEEK_START,
            days: week([
                { hasPlan: true, doneTasks: 2, openTasks: 1, spentMinutes: 30, savedMinutes: 5, overspentMinutes: 2 },
                { hasPlan: true, openTasks: 2, spentMinutes: 10, overspentMinutes: 1 },
                { doneTasks: 1, spentMinutes: 20, savedMinutes: 3 },
                { hasPlan: true, doneTasks: 3, openTasks: 1, spentMinutes: 45, savedMinutes: 7, overspentMinutes: 4 },
                { doneTasks: 9, openTasks: 9, spentMinutes: 900, savedMinutes: 900, overspentMinutes: 900 },
                { doneTasks: 9, openTasks: 9, spentMinutes: 900, savedMinutes: 900, overspentMinutes: 900 },
                { doneTasks: 9, openTasks: 9, spentMinutes: 900, savedMinutes: 900, overspentMinutes: 900 },
            ]),
            timedDoneTasks: 5,
        })

        expect(report.facts).toEqual({
            doneTotal: 6,
            openTotal: 4,
            totalTasks: 10,
            timedDoneTasks: 5,
            completionPct: 60,
            spentTotal: 105,
            savedTotal: 15,
            overspentTotal: 7,
            coveredDayCount: 4,
            plannedDays: 3,
            activeDays: 4,
            peakDayKey: TODAY_TUE,
            peakDayDoneTasks: 3,
        })
    })

    it("keeps the earliest day on a peak tie", () => {
        const report = buildWeeklyReport({
            todayKey: TODAY_TUE,
            weekStart: WEEK_START,
            days: week([
                { doneTasks: 2 },
                { doneTasks: 2 },
                { doneTasks: 1 },
            ]),
            timedDoneTasks: 0,
        })
        expect(report.facts.peakDayKey).toBe(KEYS[0])
        expect(report.facts.peakDayDoneTasks).toBe(2)
    })

    it("returns a null peak when no covered day has done work", () => {
        const report = buildWeeklyReport({
            todayKey: TODAY_TUE,
            weekStart: WEEK_START,
            days: week([{ openTasks: 2 }]),
            timedDoneTasks: 0,
        })
        expect(report.facts.peakDayKey).toBeNull()
        expect(report.facts.peakDayDoneTasks).toBeNull()
    })

    it("counts active days without summing done and open", () => {
        const report = buildWeeklyReport({
            todayKey: TODAY_TUE,
            weekStart: WEEK_START,
            days: week([{ doneTasks: 1 }, {}, { openTasks: 1 }]),
            timedDoneTasks: 1,
        })
        expect(report.facts.activeDays).toBe(2)
    })

    it("computes aggregate percentages with Math.round", () => {
        const oneOfThree = buildWeeklyReport({
            todayKey: TODAY_TUE,
            weekStart: WEEK_START,
            days: week([{ doneTasks: 1, openTasks: 2 }]),
            timedDoneTasks: 0,
        })
        expect(oneOfThree.facts.completionPct).toBe(33)

        const sevenOfEight = buildWeeklyReport({
            todayKey: TODAY_TUE,
            weekStart: WEEK_START,
            days: week([{ doneTasks: 7, openTasks: 1 }]),
            timedDoneTasks: 0,
        })
        expect(sevenOfEight.facts.completionPct).toBe(88)

        const empty = buildWeeklyReport({
            todayKey: TODAY_TUE,
            weekStart: WEEK_START,
            days: week([{ hasPlan: true }]),
            timedDoneTasks: 0,
        })
        expect(empty.state).toBe("OK")
        expect(empty.facts.completionPct).toBeNull()
    })

    it("ignores future days even when their numbers are enormous", () => {
        const report = buildWeeklyReport({
            todayKey: TODAY_TUE,
            weekStart: WEEK_START,
            days: week([
                { doneTasks: 1 },
                {},
                {},
                {},
                { doneTasks: MAX, openTasks: MAX, spentMinutes: MAX, savedMinutes: MAX, overspentMinutes: MAX },
                { doneTasks: MAX, openTasks: MAX, spentMinutes: MAX, savedMinutes: MAX, overspentMinutes: MAX },
                { doneTasks: MAX, openTasks: MAX, spentMinutes: MAX, savedMinutes: MAX, overspentMinutes: MAX },
            ]),
            timedDoneTasks: 0,
        })

        expect(report.facts.doneTotal).toBe(1)
        expect(report.facts.openTotal).toBe(0)
        expect(report.facts.totalTasks).toBe(1)
        expect(report.facts.spentTotal).toBe(0)
        expect(report.facts.savedTotal).toBe(0)
        expect(report.facts.overspentTotal).toBe(0)
        expect(report.facts.coveredDayCount).toBe(4)
        expect(report.days[6].doneTasks).toBe(MAX)
        expect(report.days[6].isCovered).toBe(false)
    })

    it("does not mutate its inputs", () => {
        const days = week([{ doneTasks: 1, savedMinutes: 2 }])
        const snapshot = JSON.parse(JSON.stringify(days))
        days.forEach((entry) => Object.freeze(entry))
        Object.freeze(days)

        const report = buildWeeklyReport({
            todayKey: TODAY_TUE,
            weekStart: WEEK_START,
            days,
            timedDoneTasks: 0,
        })

        expect(report.facts.doneTotal).toBe(1)
        expect(JSON.parse(JSON.stringify(days))).toEqual(snapshot)
    })
})

describe("buildWeeklyReport - NO_DATA", () => {
    it("N1: all covered days empty", () => {
        const report = buildWeeklyReport({
            todayKey: TODAY_TUE,
            weekStart: WEEK_START,
            days: week([]),
            timedDoneTasks: 0,
        })
        expect(report.state).toBe("NO_DATA")
        expect(report.insights).toEqual([])
        expect(report.facts.plannedDays).toBe(0)
        expect(report.facts.coveredDayCount).toBe(4)
    })

    it("N2: future days with plans and tasks do not affect NO_DATA", () => {
        const report = buildWeeklyReport({
            todayKey: TODAY_TUE,
            weekStart: WEEK_START,
            days: week([
                {},
                {},
                {},
                {},
                { hasPlan: true, openTasks: 3 },
                { hasPlan: true, openTasks: 3 },
                { hasPlan: true, openTasks: 3 },
            ]),
            timedDoneTasks: 0,
        })
        expect(report.state).toBe("NO_DATA")
        expect(report.facts.openTotal).toBe(0)
    })

    it("N3: a single done task without a plan yields OK", () => {
        const report = buildWeeklyReport({
            todayKey: TODAY_TUE,
            weekStart: WEEK_START,
            days: week([{ doneTasks: 1 }]),
            timedDoneTasks: 0,
        })
        expect(report.state).toBe("OK")
        expect(ids(report.insights)).toEqual(["WEEK_PEAK_DAY", "WEEK_COMPLETION"])
        expect(report.insights[1]).toEqual({
            id: "WEEK_COMPLETION",
            params: { completionPct: 100, doneTasks: 1, openTasks: 0 },
        })
    })

    it("N4: a single open task without a plan yields OK and WEEK_NONE_DONE", () => {
        const report = buildWeeklyReport({
            todayKey: TODAY_TUE,
            weekStart: WEEK_START,
            days: week([{ openTasks: 2 }]),
            timedDoneTasks: 0,
        })
        expect(report.state).toBe("OK")
        expect(ids(report.insights)).toEqual(["WEEK_NONE_DONE", "WEEK_COMPLETION"])
        expect(report.insights[0]).toEqual({
            id: "WEEK_NONE_DONE",
            params: { openTasks: 2 },
        })
    })

    it("N5: a plan without tasks yields OK with no insights", () => {
        const report = buildWeeklyReport({
            todayKey: TODAY_TUE,
            weekStart: WEEK_START,
            days: week([{ hasPlan: true }]),
            timedDoneTasks: 0,
        })
        expect(report.state).toBe("OK")
        expect(report.facts.plannedDays).toBe(1)
        expect(report.facts.completionPct).toBeNull()
        expect(report.insights).toEqual([])
    })

    it("N6: only Saturday is covered and empty", () => {
        const report = buildWeeklyReport({
            todayKey: WEEK_START,
            weekStart: WEEK_START,
            days: week([
                {},
                { hasPlan: true, openTasks: 3 },
                { hasPlan: true, openTasks: 3 },
                { hasPlan: true, openTasks: 3 },
                { hasPlan: true, openTasks: 3 },
                { hasPlan: true, openTasks: 3 },
                { hasPlan: true, openTasks: 3 },
            ]),
            timedDoneTasks: 0,
        })
        expect(report.state).toBe("NO_DATA")
        expect(report.facts.coveredDayCount).toBe(1)
    })
})

describe("buildWeeklyReport - data quality", () => {
    it("flags weeks containing past covered days", () => {
        const report = buildWeeklyReport({
            todayKey: TODAY_TUE,
            weekStart: WEEK_START,
            days: week([]),
            timedDoneTasks: 0,
        })
        expect(report.dataQuality.approximate).toBe(true)
        expect(report.dataQuality.partialTimeCoverage).toBe(false)
        expect(report.dataQuality.reasons).toEqual(["PAST_DAY_ROLLOVER"])
    })

    it("does not flag a week that only covers today", () => {
        const report = buildWeeklyReport({
            todayKey: WEEK_START,
            weekStart: WEEK_START,
            days: week([]),
            timedDoneTasks: 0,
        })
        expect(report.dataQuality.approximate).toBe(false)
        expect(report.dataQuality.reasons).toEqual([])
    })

    it("flags untimed done work and keeps the reason order", () => {
        const report = buildWeeklyReport({
            todayKey: TODAY_TUE,
            weekStart: WEEK_START,
            days: week([{ doneTasks: 2 }]),
            timedDoneTasks: 1,
        })
        expect(report.dataQuality.partialTimeCoverage).toBe(true)
        expect(report.dataQuality.reasons).toEqual([
            "PAST_DAY_ROLLOVER",
            "PARTIAL_TIME_COVERAGE",
        ])
    })

    it("does not flag full time coverage", () => {
        const report = buildWeeklyReport({
            todayKey: TODAY_TUE,
            weekStart: WEEK_START,
            days: week([{ doneTasks: 2 }]),
            timedDoneTasks: 2,
        })
        expect(report.dataQuality.partialTimeCoverage).toBe(false)
    })
})

describe("buildWeeklyReport - insights", () => {
    it("emits WEEK_PEAK_DAY, WEEK_COMPLETION and WEEK_SAVED in order", () => {
        const report = buildWeeklyReport({
            todayKey: TODAY_TUE,
            weekStart: WEEK_START,
            days: week([{ doneTasks: 2, savedMinutes: 10 }]),
            timedDoneTasks: 2,
        })
        expect(ids(report.insights)).toEqual([
            "WEEK_PEAK_DAY",
            "WEEK_COMPLETION",
            "WEEK_SAVED",
        ])
        expect(report.insights[0]).toEqual({
            id: "WEEK_PEAK_DAY",
            params: { dayKey: KEYS[0], doneTasks: 2 },
        })
        expect(report.insights[2]).toEqual({
            id: "WEEK_SAVED",
            params: { savedMinutes: 10, timedDoneTasks: 2, doneTasks: 2 },
        })
    })

    it("emits no insights for NO_DATA", () => {
        const report = buildWeeklyReport({
            todayKey: TODAY_TUE,
            weekStart: WEEK_START,
            days: week([]),
            timedDoneTasks: 0,
        })
        expect(report.state).toBe("NO_DATA")
        expect(report.insights).toEqual([])
    })
})

describe("buildWeeklyReport - overflow guards", () => {
    const buildAllCovered = (
        overrides: Array<Partial<DayFacts>>,
        timedDoneTasks = 0,
    ) =>
        buildWeeklyReport({
            todayKey: TODAY_FRI,
            weekStart: WEEK_START,
            days: week(overrides),
            timedDoneTasks,
        })

    it("S8: rejects doneTotal overflow", () => {
        expect(() => buildAllCovered([{ doneTasks: MAX }, { doneTasks: 1 }])).toThrow(RangeError)
    })

    it("S9: rejects openTotal overflow", () => {
        expect(() => buildAllCovered([{ openTasks: MAX }, { openTasks: 1 }])).toThrow(RangeError)
    })

    it("S10: rejects spentTotal overflow", () => {
        expect(() => buildAllCovered([{ spentMinutes: MAX }, { spentMinutes: 1 }])).toThrow(
            RangeError,
        )
    })

    it("S11: rejects savedTotal overflow", () => {
        expect(() => buildAllCovered([{ savedMinutes: MAX }, { savedMinutes: 1 }])).toThrow(
            RangeError,
        )
    })

    it("S12: rejects overspentTotal overflow", () => {
        expect(() =>
            buildAllCovered([{ overspentMinutes: MAX }, { overspentMinutes: 1 }]),
        ).toThrow(RangeError)
    })

    it("S13: rejects totalTasks overflow even when doneTotal and openTotal are safe", () => {
        expect(() => buildAllCovered([{ doneTasks: MAX }, { openTasks: 1 }])).toThrow(RangeError)
    })

    it("S14: aggregation guards run before the timedDoneTasks bound check", () => {
        expect(() =>
            buildAllCovered([{ doneTasks: MAX }, { doneTasks: 1 }], 1),
        ).toThrow(RangeError)
    })

    it("S16: accepts large but safe totals and computes 50 percent", () => {
        const perDay = 2 ** 49 - 1
        const report = buildAllCovered(
            Array.from({ length: 7 }, () => ({ doneTasks: perDay, openTasks: perDay })),
        )
        expect(report.facts.doneTotal).toBe(7 * perDay)
        expect(report.facts.openTotal).toBe(7 * perDay)
        expect(report.facts.totalTasks).toBe(14 * perDay)
        expect(report.facts.completionPct).toBe(50)
        expect(Number.isSafeInteger(report.facts.totalTasks)).toBe(true)
    })

    it("S17: never exposes an unsafe number in facts, days or insight params", () => {
        const perDay = 2 ** 49 - 1
        const report = buildAllCovered(
            Array.from({ length: 7 }, () => ({
                doneTasks: perDay,
                openTasks: perDay,
                spentMinutes: perDay,
                savedMinutes: perDay,
                overspentMinutes: perDay,
            })),
            0,
        )
        assertSafeNumbers(report.facts, "facts")
        assertSafeNumbers(report.days, "days")
        for (const insight of report.insights) {
            assertSafeNumbers(insight.params, `insight.${insight.id}`)
        }
    })
})

describe("buildWeeklyReport - numeric validation", () => {
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
                const days = week([])
                days[1] = { ...days[1], [field]: value } as DayFacts
                expect(
                    () =>
                        buildWeeklyReport({
                            todayKey: TODAY_TUE,
                            weekStart: WEEK_START,
                            days,
                            timedDoneTasks: 0,
                        }),
                    `${field}=${String(value)}`,
                ).toThrow(RangeError)
            }
        }
    })

    it("rejects invalid timedDoneTasks and counts above doneTotal", () => {
        for (const value of [Number.NaN, Infinity, 1.5, 2 ** 53, -1]) {
            expect(() =>
                buildWeeklyReport({
                    todayKey: TODAY_TUE,
                    weekStart: WEEK_START,
                    days: week([{ doneTasks: 2 }]),
                    timedDoneTasks: value,
                }),
            ).toThrow(RangeError)
        }
        expect(() =>
            buildWeeklyReport({
                todayKey: TODAY_TUE,
                weekStart: WEEK_START,
                days: week([{ doneTasks: 2 }]),
                timedDoneTasks: 3,
            }),
        ).toThrow(RangeError)
    })

    it("accepts negative zero as zero", () => {
        const report = buildWeeklyReport({
            todayKey: TODAY_TUE,
            weekStart: WEEK_START,
            days: week([{ doneTasks: -0, openTasks: -0 }]),
            timedDoneTasks: -0,
        })
        expect(report.facts.totalTasks).toBe(0)
        expect(report.facts.completionPct).toBeNull()
    })
})
