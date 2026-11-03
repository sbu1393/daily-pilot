/*
 * Coach engine data contract (step 1) - types only, no runtime values.
 *
 * Constraints:
 * - No imports at all (no React/Next/Prisma, no other project module).
 * - No human-facing text; only ids, states, day keys and numbers.
 * - The engine receives "today" as input and never reads the system clock.
 */

/** Canonical Gregorian day key "YYYY-MM-DD" - same contract as Task.dayKey / Task.completedOn */
export type CanonicalDayKey = string

/* ================================ INPUT ================================ */

/**
 * Data snapshot of a single day.
 * Structurally a subset of DaySummary, but imports nothing from it.
 * Intentionally has no totalTasks: the engine derives it from done + open.
 */
export type DayFacts = {
    dayKey: CanonicalDayKey
    hasPlan: boolean
    availableMinutes: number
    committedMinutes: number
    poolMinutes: number
    overCommittedMinutes: number
    doneTasks: number
    openTasks: number
    spentMinutes: number
    savedMinutes: number
    overspentMinutes: number
}

export type DailyReportInput = {
    /** Today's canonical key in the user's timezone. */
    todayKey: CanonicalDayKey
    /** Must satisfy day.dayKey <= todayKey; otherwise RangeError. */
    day: DayFacts
    /** DONE tasks of that day with spentMinutes recorded: 0 <= x <= doneTasks. */
    timedDoneTasks: number
}

export type WeeklyReportInput = {
    /** Today's canonical key; must satisfy todayKey >= weekStart. */
    todayKey: CanonicalDayKey
    /** Saturday; otherwise RangeError. */
    weekStart: CanonicalDayKey
    /** Exactly 7 entries, ascending and contiguous starting at weekStart. */
    days: readonly DayFacts[]
    /** Covered-day DONE tasks with spentMinutes recorded. */
    timedDoneTasks: number
}

/* ============================= DATA QUALITY ============================= */

export type DataQualityReason =
    | "PAST_DAY_ROLLOVER"
    | "PARTIAL_TIME_COVERAGE"

export type DataQuality = {
    /** true only for PAST_DAY_ROLLOVER - drives the "approximate" badge. */
    readonly approximate: boolean
    /** true when doneTasks > timedDoneTasks. */
    readonly partialTimeCoverage: boolean
    /** Fixed order: PAST_DAY_ROLLOVER, then PARTIAL_TIME_COVERAGE. */
    readonly reasons: readonly DataQualityReason[]
}

/* ========================== INSIGHTS (no text) ========================== */

export type InsightParams = {
    DAILY_NONE_DONE: { openTasks: number }
    DAILY_ALL_DONE: { totalTasks: number }
    DAILY_OVER_COMMITTED: { overCommittedMinutes: number }
    DAILY_NO_POOL: { openTasks: number }
    DAILY_SAVED: { savedMinutes: number; timedDoneTasks: number; doneTasks: number }
    DAILY_OVERSPENT: { overspentMinutes: number; timedDoneTasks: number; doneTasks: number }

    WEEK_NONE_DONE: { openTasks: number }
    WEEK_PEAK_DAY: { dayKey: CanonicalDayKey; doneTasks: number }
    WEEK_COMPLETION: { completionPct: number; doneTasks: number; openTasks: number }
    WEEK_SAVED: { savedMinutes: number; timedDoneTasks: number; doneTasks: number }
}

export type InsightId = keyof InsightParams

export type Insight = {
    [K in InsightId]: { readonly id: K; readonly params: InsightParams[K] }
}[InsightId]

/* ============================ DAILY OUTPUT ============================ */

export type DailyReportState = "NO_PLAN" | "NO_TASKS" | "OK"

export type DailyFacts = {
    readonly doneTasks: number
    readonly openTasks: number
    /** Derived: doneTasks + openTasks - never read from input. */
    readonly totalTasks: number
    readonly timedDoneTasks: number
    /** Math.round(done / total, then scaled); null when total = 0. */
    readonly completionPct: number | null
    readonly spentMinutes: number
    readonly savedMinutes: number
    readonly overspentMinutes: number
    /** null when !hasPlan - never a fake zero. */
    readonly budget: {
        readonly availableMinutes: number
        readonly committedMinutes: number
    } | null
    readonly poolMinutes: number | null
    readonly overCommittedMinutes: number | null
}

export type CoachDailyReport = {
    readonly kind: "daily"
    readonly dayKey: CanonicalDayKey
    readonly state: DailyReportState
    readonly facts: DailyFacts
    /** Populated only when state === "OK". */
    readonly insights: readonly Insight[]
    readonly dataQuality: DataQuality
}

/* ============================ WEEKLY OUTPUT ============================ */

export type WeeklyReportState = "NO_DATA" | "OK"

export type WeeklyDayFacts = {
    readonly dayKey: CanonicalDayKey
    readonly hasPlan: boolean
    readonly doneTasks: number
    readonly openTasks: number
    /** dayKey <= todayKey */
    readonly isCovered: boolean
}

export type WeeklyFacts = {
    readonly doneTotal: number
    readonly openTotal: number
    readonly totalTasks: number
    readonly timedDoneTasks: number
    readonly completionPct: number | null
    readonly spentTotal: number
    readonly savedTotal: number
    readonly overspentTotal: number
    readonly coveredDayCount: number
    readonly plannedDays: number
    readonly activeDays: number
    readonly peakDayKey: CanonicalDayKey | null
    readonly peakDayDoneTasks: number | null
}

export type CoachWeeklyReport = {
    readonly kind: "weekly"
    readonly weekStart: CanonicalDayKey
    readonly weekEnd: CanonicalDayKey
    /** min(todayKey, weekEnd) */
    readonly coveredThrough: CanonicalDayKey
    readonly state: WeeklyReportState
    /** Always 7 entries, ascending, future days included with isCovered=false. */
    readonly days: readonly WeeklyDayFacts[]
    readonly facts: WeeklyFacts
    readonly insights: readonly Insight[]
    readonly dataQuality: DataQuality
}

export type CoachReport = CoachDailyReport | CoachWeeklyReport
