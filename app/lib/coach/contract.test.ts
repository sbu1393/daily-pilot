/*
 * Contract tests for the coach engine (step 1).
 *
 * These tests lock the public surface and the safety rules that are easy to
 * break silently later: export counts, DTO key sets, absence of persisted
 * dependencies, "divide before scaling" percentages, and a guard after every
 * derived sum. Static scans are intentionally narrow and point at the two
 * report modules only.
 */

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import * as dailyReportModule from "./dailyReport"
import * as weeklyReportModule from "./weeklyReport"
import * as typesModule from "./types"
import * as weekModule from "./week"
import type {
    DailyFacts,
    DataQuality,
    DayFacts,
    Insight,
    InsightParams,
    WeeklyDayFacts,
    WeeklyFacts,
} from "./types"
import { buildDailyReport } from "./dailyReport"
import { buildWeeklyReport } from "./weeklyReport"
import { weekDaysOf } from "./week"

const MAX = Number.MAX_SAFE_INTEGER

function source(name: string): string {
    return readFileSync(new URL(name, import.meta.url), "utf8")
}

const sources = {
    types: source("types.ts"),
    week: source("week.ts"),
    daily: source("dailyReport.ts"),
    weekly: source("weeklyReport.ts"),
} as const

function day(dayKey: string, overrides: Partial<DayFacts> = {}): DayFacts {
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

function week(overrides: Array<Partial<DayFacts>> = []): DayFacts[] {
    return weekDaysOf("2026-10-31").map((key, index) => day(key, overrides[index] ?? {}))
}

function insightIds(insights: readonly Insight[]): string[] {
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

describe("contract - module surfaces", () => {
    it("week.ts exports exactly the eight agreed names", () => {
        expect(Object.keys(weekModule).sort()).toEqual(
            [
                "assertSafeNonNegativeInteger",
                "compareDayKeys",
                "isWeekStart",
                "roundPercent",
                "shiftDayKey",
                "weekDaysOf",
                "weekEndOf",
                "weekStartOf",
            ].sort(),
        )
    })

    it("report modules export exactly one builder each", () => {
        expect(Object.keys(dailyReportModule)).toEqual(["buildDailyReport"])
        expect(Object.keys(weeklyReportModule)).toEqual(["buildWeeklyReport"])
    })

    it("types.ts is a type-only module with no runtime exports", () => {
        expect(Object.keys(typesModule)).toEqual([])
    })
})

describe("contract - type-level guarantees", () => {
    type IsNever<T> = [T] extends [never] ? true : false

    it("DayFacts has no totalTasks", () => {
        const check: IsNever<Extract<"totalTasks", keyof DayFacts>> = true
        expect(check).toBe(true)
    })

    it("WeeklyFacts has no previous-week comparison fields", () => {
        const noPrevious: IsNever<Extract<"previousWeekDoneTotal", keyof WeeklyFacts>> = true
        const noDelta: IsNever<Extract<"deltaDoneTasks", keyof WeeklyFacts>> = true
        expect(noPrevious).toBe(true)
        expect(noDelta).toBe(true)
    })

    it("InsightParams has no trend ids", () => {
        const noUp: IsNever<Extract<"WEEK_TREND_UP", keyof InsightParams>> = true
        const noDown: IsNever<Extract<"WEEK_TREND_DOWN", keyof InsightParams>> = true
        expect(noUp).toBe(true)
        expect(noDown).toBe(true)
    })
})

describe("contract - source purity", () => {
    const persianOrArabic = /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/
    const forbidden = /Date\.now|new Date\(\s*\)|\bIntl\b|prisma|react|next\/|window|document|process\.|console\./

    it("engine sources contain no Persian/Arabic characters", () => {
        for (const [name, text] of Object.entries(sources)) {
            expect(text, name).not.toMatch(persianOrArabic)
        }
    })

    it("engine sources contain no clock, Intl, I/O, framework or DB dependencies", () => {
        for (const [name, text] of Object.entries(sources)) {
            expect(text, name).not.toMatch(forbidden)
        }
    })

    it("engine sources mention no removed trend or previous-week concepts", () => {
        const removed = /WEEK_TREND_UP|WEEK_TREND_DOWN|previousWeek|deltaDoneTasks/
        for (const [name, text] of Object.entries(sources)) {
            expect(text, name).not.toMatch(removed)
        }
    })
})

describe("contract - safe percentage rule", () => {
    it("percent scaling happens only in week.ts, exactly once", () => {
        expect(sources.daily).not.toContain("* 100")
        expect(sources.weekly).not.toContain("* 100")
        expect((sources.week.match(/\* 100/g) ?? []).length).toBe(1)
    })

    it("week.ts divides before scaling", () => {
        expect(sources.week).not.toContain("part * 100")
        const divideIndex = sources.week.indexOf("/ whole")
        const scaleIndex = sources.week.indexOf("* 100")
        expect(divideIndex).toBeGreaterThan(-1)
        expect(scaleIndex).toBeGreaterThan(-1)
        expect(divideIndex).toBeLessThan(scaleIndex)
    })
})

describe("contract - guarded accumulators", () => {
    const accumulatorPattern = /^\s*([A-Za-z_$][\w$]*)\s*\+=/

    function collectAccumulators(text: string): string[] {
        const lines = text.split("\n")
        const found: string[] = []
        lines.forEach((line, index) => {
            const match = accumulatorPattern.exec(line)
            if (match === null) return
            found.push(match[1])
            const nextLine = lines[index + 1] ?? ""
            expect(nextLine, `guard for ${match[1]}`).toContain(
                `assertSafeNonNegativeInteger(${match[1]},`,
            )
        })
        return found.sort()
    }

    it("weeklyReport guards every accumulation on the next line", () => {
        expect(collectAccumulators(sources.weekly)).toEqual(
            ["doneTotal", "openTotal", "overspentTotal", "savedTotal", "spentTotal"].sort(),
        )
    })

    it("dailyReport has no unguarded accumulators", () => {
        expect(collectAccumulators(sources.daily)).toEqual([])
    })

    it("derived totalTasks is guarded before use in both report modules", () => {
        expect(sources.daily).toMatch(
            /const totalTasks = day\.doneTasks \+ day\.openTasks\n\s*assertSafeNonNegativeInteger\(\s*totalTasks,/,
        )
        expect(sources.weekly).toMatch(
            /const totalTasks = doneTotal \+ openTotal\n\s*assertSafeNonNegativeInteger\(\s*totalTasks,/,
        )
    })
})

describe("contract - DTO key sets", () => {
    const daily = buildDailyReport({
        todayKey: "2026-11-03",
        day: day("2026-11-03", { doneTasks: 1, savedMinutes: 2 }),
        timedDoneTasks: 1,
    })

    const weekly = buildWeeklyReport({
        todayKey: "2026-11-03",
        weekStart: "2026-10-31",
        days: week([{ doneTasks: 1, savedMinutes: 2 }]),
        timedDoneTasks: 1,
    })

    it("DailyFacts has exactly 11 keys", () => {
        const keys: Array<keyof DailyFacts> = [
            "doneTasks",
            "openTasks",
            "totalTasks",
            "timedDoneTasks",
            "completionPct",
            "spentMinutes",
            "savedMinutes",
            "overspentMinutes",
            "budget",
            "poolMinutes",
            "overCommittedMinutes",
        ]
        expect(Object.keys(daily.facts).sort()).toEqual([...keys].sort())
        expect(keys).toHaveLength(11)
    })

    it("WeeklyFacts has exactly 13 keys", () => {
        const keys: Array<keyof WeeklyFacts> = [
            "doneTotal",
            "openTotal",
            "totalTasks",
            "timedDoneTasks",
            "completionPct",
            "spentTotal",
            "savedTotal",
            "overspentTotal",
            "coveredDayCount",
            "plannedDays",
            "activeDays",
            "peakDayKey",
            "peakDayDoneTasks",
        ]
        expect(Object.keys(weekly.facts).sort()).toEqual([...keys].sort())
        expect(keys).toHaveLength(13)
    })

    it("WeeklyDayFacts has exactly 5 keys and DataQuality has 3", () => {
        const dayKeys: Array<keyof WeeklyDayFacts> = [
            "dayKey",
            "hasPlan",
            "doneTasks",
            "openTasks",
            "isCovered",
        ]
        const qualityKeys: Array<keyof DataQuality> = [
            "approximate",
            "partialTimeCoverage",
            "reasons",
        ]
        expect(Object.keys(weekly.days[0]).sort()).toEqual([...dayKeys].sort())
        expect(Object.keys(weekly.dataQuality).sort()).toEqual([...qualityKeys].sort())
        expect(Object.keys(daily.dataQuality).sort()).toEqual([...qualityKeys].sort())
    })
})

describe("contract - insight id inventory", () => {
    it("the engine can emit exactly the ten agreed ids", () => {
        const dailyOne = buildDailyReport({
            todayKey: "2026-11-03",
            day: day("2026-11-03", {
                doneTasks: 0,
                openTasks: 2,
                poolMinutes: 0,
                overCommittedMinutes: 5,
                savedMinutes: 3,
                overspentMinutes: 4,
            }),
            timedDoneTasks: 0,
        })
        const dailyTwo = buildDailyReport({
            todayKey: "2026-11-03",
            day: day("2026-11-03", { doneTasks: 1 }),
            timedDoneTasks: 1,
        })
        const weeklyOne = buildWeeklyReport({
            todayKey: "2026-11-03",
            weekStart: "2026-10-31",
            days: week([{ doneTasks: 2, openTasks: 1, savedMinutes: 4 }]),
            timedDoneTasks: 2,
        })
        const weeklyTwo = buildWeeklyReport({
            todayKey: "2026-11-03",
            weekStart: "2026-10-31",
            days: week([{ openTasks: 2 }]),
            timedDoneTasks: 0,
        })

        const ids = new Set([
            ...insightIds(dailyOne.insights),
            ...insightIds(dailyTwo.insights),
            ...insightIds(weeklyOne.insights),
            ...insightIds(weeklyTwo.insights),
        ])

        expect([...ids].sort()).toEqual(
            [
                "DAILY_NONE_DONE",
                "DAILY_ALL_DONE",
                "DAILY_OVER_COMMITTED",
                "DAILY_NO_POOL",
                "DAILY_SAVED",
                "DAILY_OVERSPENT",
                "WEEK_NONE_DONE",
                "WEEK_PEAK_DAY",
                "WEEK_COMPLETION",
                "WEEK_SAVED",
            ].sort(),
        )
    })
})

describe("contract - DTO numeric safety", () => {
    it("daily boundary report exposes only safe numbers", () => {
        const report = buildDailyReport({
            todayKey: "2026-11-03",
            day: day("2026-11-02", {
                doneTasks: 2 ** 51 - 1,
                openTasks: 2 ** 51 - 1,
                savedMinutes: MAX,
                overspentMinutes: MAX,
                overCommittedMinutes: MAX,
                poolMinutes: 0,
            }),
            timedDoneTasks: 0,
        })
        assertSafeNumbers(report.facts, "daily.facts")
        assertSafeNumbers(report.insights, "daily.insights")
        expect(report.facts.totalTasks).toBe(2 ** 52 - 2)
    })

    it("weekly large report exposes only safe numbers", () => {
        const perDay = 2 ** 49 - 1
        const report = buildWeeklyReport({
            todayKey: "2026-11-06",
            weekStart: "2026-10-31",
            days: week(
                Array.from({ length: 7 }, () => ({
                    doneTasks: perDay,
                    openTasks: perDay,
                    spentMinutes: perDay,
                    savedMinutes: perDay,
                    overspentMinutes: perDay,
                })),
            ),
            timedDoneTasks: 0,
        })
        assertSafeNumbers(report.facts, "weekly.facts")
        assertSafeNumbers(report.days, "weekly.days")
        for (const insight of report.insights) {
            assertSafeNumbers(insight.params, `weekly.insight.${insight.id}`)
        }
        expect(report.facts.completionPct).toBe(50)
    })
})
