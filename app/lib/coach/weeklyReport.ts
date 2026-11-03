/*
 * Weekly coach report - pure rule-based, no I/O, no text, no clock.
 *
 * Aggregation covers only days with dayKey <= todayKey. Future days stay in
 * the days[] snapshot with isCovered=false and never reach totals,
 * percentages or insight parameters.
 *
 * NO_DATA is true only when every covered day has
 * hasPlan === false && doneTasks === 0 && openTasks === 0.
 */

import type {
    CoachWeeklyReport,
    DataQuality,
    DataQualityReason,
    DayFacts,
    Insight,
    WeeklyDayFacts,
    WeeklyFacts,
    WeeklyReportInput,
    WeeklyReportState,
} from "./types"
import {
    assertSafeNonNegativeInteger,
    compareDayKeys,
    isWeekStart,
    roundPercent,
    weekDaysOf,
    weekEndOf,
} from "./week"

const WEEK_LENGTH = 7

/** Validate every field of a DayFacts snapshot; throws RangeError on any mismatch. */
function assertDayFacts(day: DayFacts): void {
    if (day === null || typeof day !== "object") {
        throw new RangeError("INVALID:day")
    }

    // compareDayKeys validates format, calendar round-trip and year domain.
    compareDayKeys(day.dayKey, day.dayKey)

    if (typeof day.hasPlan !== "boolean") {
        throw new RangeError("INVALID:hasPlan")
    }

    assertSafeNonNegativeInteger(day.availableMinutes, "availableMinutes")
    assertSafeNonNegativeInteger(day.committedMinutes, "committedMinutes")
    assertSafeNonNegativeInteger(day.poolMinutes, "poolMinutes")
    assertSafeNonNegativeInteger(day.overCommittedMinutes, "overCommittedMinutes")
    assertSafeNonNegativeInteger(day.doneTasks, "doneTasks")
    assertSafeNonNegativeInteger(day.openTasks, "openTasks")
    assertSafeNonNegativeInteger(day.spentMinutes, "spentMinutes")
    assertSafeNonNegativeInteger(day.savedMinutes, "savedMinutes")
    assertSafeNonNegativeInteger(day.overspentMinutes, "overspentMinutes")
}

function buildDataQuality(approximate: boolean, partialTimeCoverage: boolean): DataQuality {
    const reasons: DataQualityReason[] = []
    if (approximate) reasons.push("PAST_DAY_ROLLOVER")
    if (partialTimeCoverage) reasons.push("PARTIAL_TIME_COVERAGE")
    return { approximate, partialTimeCoverage, reasons }
}

/**
 * Build the weekly coach report for the week starting at weekStart.
 *
 * RangeError cases: invalid keys, weekStart not a Saturday, week in the
 * future, days not exactly 7 contiguous ascending entries from weekStart,
 * any invalid numeric field, timedDoneTasks > doneTotal, and any derived sum
 * that leaves the safe-integer range (guarded after every accumulation).
 */
export function buildWeeklyReport(input: WeeklyReportInput): CoachWeeklyReport {
    if (input === null || typeof input !== "object") {
        throw new RangeError("INVALID:input")
    }

    const weekStart = input.weekStart
    const todayKey = input.todayKey

    compareDayKeys(weekStart, weekStart)
    compareDayKeys(todayKey, todayKey)

    if (!isWeekStart(weekStart)) {
        throw new RangeError("INVALID:weekStart")
    }
    if (compareDayKeys(weekStart, todayKey) > 0) {
        throw new RangeError("INVALID:futureWeek")
    }

    const days = input.days
    if (!Array.isArray(days) || days.length !== WEEK_LENGTH) {
        throw new RangeError("INVALID:days")
    }

    const expectedKeys = weekDaysOf(weekStart)
    for (let index = 0; index < WEEK_LENGTH; index += 1) {
        const day = days[index]
        assertDayFacts(day)
        if (day.dayKey !== expectedKeys[index]) {
            throw new RangeError("INVALID:days")
        }
    }

    assertSafeNonNegativeInteger(input.timedDoneTasks, "timedDoneTasks")

    const weekEnd = weekEndOf(weekStart)
    const coveredThrough =
        compareDayKeys(todayKey, weekEnd) <= 0 ? todayKey : weekEnd

    let doneTotal = 0
    let openTotal = 0
    let spentTotal = 0
    let savedTotal = 0
    let overspentTotal = 0
    let coveredDayCount = 0
    let plannedDays = 0
    let activeDays = 0
    let peakDayKey: string | null = null
    let peakDayDoneTasks: number | null = null
    let allCoveredDaysEmpty = true
    let hasPastCoveredDay = false

    const dayFacts: WeeklyDayFacts[] = []

    for (let index = 0; index < WEEK_LENGTH; index += 1) {
        const day = days[index]
        const isCovered = compareDayKeys(day.dayKey, todayKey) <= 0

        dayFacts.push({
            dayKey: day.dayKey,
            hasPlan: day.hasPlan,
            doneTasks: day.doneTasks,
            openTasks: day.openTasks,
            isCovered,
        })

        if (!isCovered) {
            continue
        }

        coveredDayCount = coveredDayCount + 1

        if (day.hasPlan) {
            plannedDays = plannedDays + 1
        }
        if (day.doneTasks > 0 || day.openTasks > 0) {
            activeDays = activeDays + 1
        }
        if (day.hasPlan || day.doneTasks > 0 || day.openTasks > 0) {
            allCoveredDaysEmpty = false
        }
        if (compareDayKeys(day.dayKey, todayKey) < 0) {
            hasPastCoveredDay = true
        }

        // Derived accumulators: guard immediately after every addition so an
        // unsafe intermediate value never exists, even momentarily.
        doneTotal += day.doneTasks
        assertSafeNonNegativeInteger(doneTotal, "doneTotal")

        openTotal += day.openTasks
        assertSafeNonNegativeInteger(openTotal, "openTotal")

        spentTotal += day.spentMinutes
        assertSafeNonNegativeInteger(spentTotal, "spentTotal")

        savedTotal += day.savedMinutes
        assertSafeNonNegativeInteger(savedTotal, "savedTotal")

        overspentTotal += day.overspentMinutes
        assertSafeNonNegativeInteger(overspentTotal, "overspentTotal")

        if (day.doneTasks > (peakDayDoneTasks ?? 0)) {
            peakDayKey = day.dayKey
            peakDayDoneTasks = day.doneTasks
        }
    }

    // Derived sum W3: individually safe totals can still overflow together.
    const totalTasks = doneTotal + openTotal
    assertSafeNonNegativeInteger(totalTasks, "totalTasks")

    if (input.timedDoneTasks > doneTotal) {
        throw new RangeError("INVALID:timedDoneTasks")
    }

    const completionPct = totalTasks === 0 ? null : roundPercent(doneTotal, totalTasks)

    const partialTimeCoverage = doneTotal > input.timedDoneTasks
    const dataQuality = buildDataQuality(hasPastCoveredDay, partialTimeCoverage)

    const state: WeeklyReportState = allCoveredDaysEmpty ? "NO_DATA" : "OK"

    const facts: WeeklyFacts = {
        doneTotal,
        openTotal,
        totalTasks,
        timedDoneTasks: input.timedDoneTasks,
        completionPct,
        spentTotal,
        savedTotal,
        overspentTotal,
        coveredDayCount,
        plannedDays,
        activeDays,
        peakDayKey,
        peakDayDoneTasks,
    }

    const insights: Insight[] = []
    if (state === "OK") {
        if (doneTotal === 0 && openTotal > 0) {
            insights.push({ id: "WEEK_NONE_DONE", params: { openTasks: openTotal } })
        }
        if (peakDayKey !== null && peakDayDoneTasks !== null) {
            insights.push({
                id: "WEEK_PEAK_DAY",
                params: { dayKey: peakDayKey, doneTasks: peakDayDoneTasks },
            })
        }
        if (completionPct !== null) {
            insights.push({
                id: "WEEK_COMPLETION",
                params: {
                    completionPct,
                    doneTasks: doneTotal,
                    openTasks: openTotal,
                },
            })
        }
        if (savedTotal > 0) {
            insights.push({
                id: "WEEK_SAVED",
                params: {
                    savedMinutes: savedTotal,
                    timedDoneTasks: input.timedDoneTasks,
                    doneTasks: doneTotal,
                },
            })
        }
    }

    return {
        kind: "weekly",
        weekStart,
        weekEnd,
        coveredThrough,
        state,
        days: dayFacts,
        facts,
        insights,
        dataQuality,
    }
}
