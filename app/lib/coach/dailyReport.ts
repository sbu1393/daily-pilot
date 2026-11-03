/*
 * Daily coach report - pure rule-based, no I/O, no text, no clock.
 *
 * State model:
 *   totalTasks > 0              -> "OK"        (may still have hasPlan === false)
 *   totalTasks === 0 && hasPlan -> "NO_TASKS"
 *   totalTasks === 0 && !hasPlan-> "NO_PLAN"
 *
 * Insights are produced only for "OK". Plan-dependent insights additionally
 * require hasPlan === true (a day with tasks but no plan is still "OK").
 */

import type {
    CoachDailyReport,
    DailyFacts,
    DailyReportInput,
    DailyReportState,
    DataQuality,
    DataQualityReason,
    DayFacts,
    Insight,
} from "./types"
import {
    assertSafeNonNegativeInteger,
    compareDayKeys,
    roundPercent,
} from "./week"

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
 * Build the daily coach report for one already-selected day.
 *
 * RangeError cases: invalid day key or today key, day.dayKey > todayKey,
 * non-boolean hasPlan, any non safe-integer/non-negative numeric field,
 * timedDoneTasks > doneTasks, and any derived sum that leaves the safe range.
 */
export function buildDailyReport(input: DailyReportInput): CoachDailyReport {
    if (input === null || typeof input !== "object") {
        throw new RangeError("INVALID:input")
    }

    const day = input.day
    assertDayFacts(day)

    const todayKey = input.todayKey
    compareDayKeys(todayKey, todayKey)

    if (compareDayKeys(day.dayKey, todayKey) > 0) {
        throw new RangeError("INVALID:futureDay")
    }

    assertSafeNonNegativeInteger(input.timedDoneTasks, "timedDoneTasks")
    if (input.timedDoneTasks > day.doneTasks) {
        throw new RangeError("INVALID:timedDoneTasks")
    }

    // Derived sum D1: both operands are safe, the sum may not be.
    const totalTasks = day.doneTasks + day.openTasks
    assertSafeNonNegativeInteger(totalTasks, "totalTasks")

    // Derived percentage D2: only from validated part/whole.
    const completionPct = totalTasks === 0 ? null : roundPercent(day.doneTasks, totalTasks)

    const isPastDay = compareDayKeys(day.dayKey, todayKey) < 0
    const partialTimeCoverage = day.doneTasks > input.timedDoneTasks
    const dataQuality = buildDataQuality(isPastDay, partialTimeCoverage)

    const state: DailyReportState =
        totalTasks > 0 ? "OK" : day.hasPlan ? "NO_TASKS" : "NO_PLAN"

    const facts: DailyFacts = {
        doneTasks: day.doneTasks,
        openTasks: day.openTasks,
        totalTasks,
        timedDoneTasks: input.timedDoneTasks,
        completionPct,
        spentMinutes: day.spentMinutes,
        savedMinutes: day.savedMinutes,
        overspentMinutes: day.overspentMinutes,
        budget: day.hasPlan
            ? {
                  availableMinutes: day.availableMinutes,
                  committedMinutes: day.committedMinutes,
              }
            : null,
        poolMinutes: day.hasPlan ? day.poolMinutes : null,
        overCommittedMinutes: day.hasPlan ? day.overCommittedMinutes : null,
    }

    const insights: Insight[] = []
    if (state === "OK") {
        if (day.doneTasks === 0 && day.openTasks > 0) {
            insights.push({ id: "DAILY_NONE_DONE", params: { openTasks: day.openTasks } })
        }
        if (day.openTasks === 0) {
            insights.push({ id: "DAILY_ALL_DONE", params: { totalTasks } })
        }
        if (day.hasPlan && day.overCommittedMinutes > 0) {
            insights.push({
                id: "DAILY_OVER_COMMITTED",
                params: { overCommittedMinutes: day.overCommittedMinutes },
            })
        }
        if (day.hasPlan && day.poolMinutes === 0 && day.openTasks > 0) {
            insights.push({ id: "DAILY_NO_POOL", params: { openTasks: day.openTasks } })
        }
        if (day.savedMinutes > 0) {
            insights.push({
                id: "DAILY_SAVED",
                params: {
                    savedMinutes: day.savedMinutes,
                    timedDoneTasks: input.timedDoneTasks,
                    doneTasks: day.doneTasks,
                },
            })
        }
        if (day.overspentMinutes > 0) {
            insights.push({
                id: "DAILY_OVERSPENT",
                params: {
                    overspentMinutes: day.overspentMinutes,
                    timedDoneTasks: input.timedDoneTasks,
                    doneTasks: day.doneTasks,
                },
            })
        }
    }

    return {
        kind: "daily",
        dayKey: day.dayKey,
        state,
        facts,
        insights,
        dataQuality,
    }
}
