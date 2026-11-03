import { buildDailyReport } from "@/app/lib/coach/dailyReport"
import type { CoachDailyReport, CoachWeeklyReport, DayFacts } from "@/app/lib/coach/types"
import { assertSafeNonNegativeInteger, compareDayKeys, weekDaysOf } from "@/app/lib/coach/week"
import { buildWeeklyReport } from "@/app/lib/coach/weeklyReport"
import { getPrisma } from "@/app/lib/getPrisma"
import { overspentForTask, savedForTask } from "@/app/lib/planner/summary"
import { ServiceError } from "@/app/lib/services/errors"

/**
 * Coach read service (step 2A).
 *
 * Responsibility split:
 * - This module only READS. Daily report: exactly one dailyPlan.findUnique and
 *   one task.findMany. Weekly report: exactly one dailyPlan.findMany and one
 *   task.findMany. No create/update/delete/upsert and no $transaction.
 * - No rebalance, no side effects, no analytics, no clock reads. "Today" and
 *   the target day/week are supplied by the caller (route in step 2B/2C).
 *
 * Snapshot caveat (accepted for MVP):
 * Plan and tasks are read as two independent queries (in parallel). If data
 * changes between them, the report can mix two points in time. No transaction
 * is used here: it would add cost/complexity without changing the engine
 * contract. Stronger consistency is a separate future improvement.
 *
 * Data quality:
 * - Past-day task rollover rewrites Task.dayKey, so historical open counts can
 *   be approximate. The engine encodes that in dataQuality; this service never
 *   hides or recomputes it.
 * - Stored minute values are never clamped. Every participating row is guarded
 *   BEFORE aggregation (see buildDayFacts) and the engine still validates the
 *   aggregated totals afterwards. Both layers are required: the engine alone
 *   cannot see a negative row that is cancelled by a positive one on the same
 *   day/week. Invalid data throws RangeError, which propagates unchanged.
 */

const MAX_TIMEZONE_LENGTH = 64

// IANA zone ids are Area/Location (or UTC/GMT) built from letters, digits,
// "_", "+", "-" and "/". The leading-letter rule also rejects offset forms
// such as "+05:00", which Intl would otherwise accept.
const IANA_TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+\-/]*$/

function invalidTimezoneError(): ServiceError {
    // The raw stored value is deliberately not included: the route only sees
    // a stable code and a user-facing message.
    return new ServiceError(
        500,
        "USER_TIMEZONE_INVALID",
        "منطقه‌ی زمانی حساب کاربری نامعتبر است",
        undefined,
        "INTERNAL",
        "ERROR",
    )
}

function isValidIanaTimezone(candidate: string): boolean {
    if (candidate.length > MAX_TIMEZONE_LENGTH) return false
    if (!IANA_TIMEZONE_PATTERN.test(candidate)) return false

    try {
        // Intl is the same ICU source used by canonicalDay/taskTime. A value it
        // cannot resolve is not a usable IANA timezone for this server.
        const formatter = new Intl.DateTimeFormat("en-US", { timeZone: candidate })
        return formatter.resolvedOptions().timeZone.length > 0
    } catch {
        return false
    }
}

/**
 * Strict IANA timezone resolver for coach reports.
 *
 * Non-string, empty/whitespace-only, oversized or unresolvable values fail
 * closed with 500 USER_TIMEZONE_INVALID. There is intentionally no silent
 * fallback to UTC/Asia/Tehran: a wrong zone would move the "today" boundary
 * and silently mislabel the report.
 */
export function resolveCoachTimezone(timezone: unknown): string {
    if (typeof timezone !== "string") {
        throw invalidTimezoneError()
    }

    const candidate = timezone.trim()
    if (candidate.length === 0 || !isValidIanaTimezone(candidate)) {
        throw invalidTimezoneError()
    }

    return candidate
}

export type CoachDailyQuery = {
    userId: number
    /** Target canonical day key, already validated by the route. */
    dayKey: string
    /** Today's canonical key in the user's timezone. */
    todayKey: string
}

export type CoachWeeklyQuery = {
    userId: number
    /** Saturday that starts the week, already validated by the route. */
    weekStart: string
    /** Today's canonical key in the user's timezone. */
    todayKey: string
}

/** Narrow row shape: only the columns needed for DayFacts, no PII. */
type CoachTaskRow = {
    dayKey: string
    completedOn: string | null
    status: string
    allocatedMinutes: number | null
    spentMinutes: number | null
}

type CoachPlanRow = {
    availableMinutes: number
}

/**
 * Build DayFacts with exactly the formulas used by planner.getDaySummary,
 * reusing savedForTask/overspentForTask instead of duplicating budget math.
 * No clamping is applied to stored values.
 *
 * F5: every participating row is validated BEFORE any reduce. The engine only
 * guards aggregated totals, so without this layer a negative row could be
 * cancelled by a positive one (e.g. spentMinutes -100 + 150 = 50) and the
 * report would silently understate/report corrupt data. `null` keeps its
 * existing "unknown/not recorded" meaning and is not turned into zero here.
 */
function buildDayFacts(
    dayKey: string,
    plan: CoachPlanRow | null,
    done: readonly CoachTaskRow[],
    open: readonly CoachTaskRow[],
): DayFacts {
    if (plan !== null) {
        assertSafeNonNegativeInteger(plan.availableMinutes, "availableMinutes")
    }

    for (const task of done) {
        // spentMinutes feeds spentMinutes and savedForTask/overspentForTask.
        if (task.spentMinutes != null) {
            assertSafeNonNegativeInteger(task.spentMinutes, "spentMinutes")
        }
        // allocatedMinutes feeds savedForTask/overspentForTask.
        if (task.allocatedMinutes != null) {
            assertSafeNonNegativeInteger(task.allocatedMinutes, "allocatedMinutes")
        }
    }

    for (const task of open) {
        // allocatedMinutes feeds committedMinutes/poolMinutes/overCommittedMinutes.
        if (task.allocatedMinutes != null) {
            assertSafeNonNegativeInteger(task.allocatedMinutes, "allocatedMinutes")
        }
    }

    const spentMinutes = done.reduce((sum, task) => sum + (task.spentMinutes ?? 0), 0)
    const savedMinutes = done.reduce((sum, task) => sum + savedForTask(task), 0)
    const overspentMinutes = done.reduce((sum, task) => sum + overspentForTask(task), 0)
    const committedMinutes = open.reduce(
        (sum, task) => sum + (task.allocatedMinutes ?? 0),
        0,
    )

    const availableMinutes = plan?.availableMinutes ?? 0
    const openBudgetMinutes = Math.max(0, availableMinutes - spentMinutes)
    const poolMinutes = Math.max(0, openBudgetMinutes - committedMinutes)
    const overCommittedMinutes = Math.max(0, committedMinutes - openBudgetMinutes)

    return {
        dayKey,
        hasPlan: plan !== null,
        availableMinutes,
        committedMinutes,
        poolMinutes,
        overCommittedMinutes,
        doneTasks: done.length,
        openTasks: open.length,
        spentMinutes,
        savedMinutes,
        overspentMinutes,
    }
}

/** DONE tasks with a recorded duration. */
function countTimedDone(tasks: readonly CoachTaskRow[]): number {
    return tasks.filter((task) => task.spentMinutes !== null).length
}

/**
 * Daily coach report from a stored snapshot.
 *
 * Exactly two reads: plan (findUnique) + tasks (findMany). DONE tasks are
 * grouped by completedOn (actual completion day), non-DONE tasks by dayKey
 * (planned day) - the same split as planner.getDaySummary.
 */
export async function getDailyCoachReport(
    input: CoachDailyQuery,
): Promise<CoachDailyReport> {
    const prisma = getPrisma()

    // Validate the day and reject future days before touching the database.
    if (compareDayKeys(input.dayKey, input.todayKey) > 0) {
        throw new RangeError("INVALID:futureDay")
    }

    const [plan, tasks] = await Promise.all([
        prisma.dailyPlan.findUnique({
            where: { userId_dayKey: { userId: input.userId, dayKey: input.dayKey } },
            select: { availableMinutes: true },
        }),
        prisma.task.findMany({
            where: {
                userId: input.userId,
                OR: [
                    { dayKey: input.dayKey, status: { not: "DONE" } },
                    { completedOn: input.dayKey, status: "DONE" },
                ],
            },
            select: {
                dayKey: true,
                completedOn: true,
                status: true,
                allocatedMinutes: true,
                spentMinutes: true,
            },
        }),
    ])

    const done: CoachTaskRow[] = []
    const open: CoachTaskRow[] = []

    for (const task of tasks) {
        if (task.status === "DONE") {
            // DONE belongs to the day it actually happened, never to dayKey.
            if (task.completedOn === input.dayKey) done.push(task)
        } else if (task.dayKey === input.dayKey) {
            open.push(task)
        }
    }

    const day = buildDayFacts(input.dayKey, plan, done, open)

    return buildDailyReport({
        todayKey: input.todayKey,
        day,
        timedDoneTasks: countTimedDone(done),
    })
}

/**
 * Weekly coach report for the Saturday-started week.
 *
 * Exactly two reads for all seven days (no N+1): plans where dayKey in week
 * and tasks whose planned day OR completion day falls in the week. DONE tasks
 * are grouped by completedOn, non-DONE by dayKey.
 *
 * Future days stay in days[] with isCovered=false and are excluded from
 * timedDoneTasks; the engine excludes them from every total, percentage and
 * insight as well. timedDoneTasks therefore only sums covered days and cannot
 * exceed the engine's covered doneTotal.
 */
export async function getWeeklyCoachReport(
    input: CoachWeeklyQuery,
): Promise<CoachWeeklyReport> {
    const prisma = getPrisma()

    // weekDaysOf also rejects a non-Saturday weekStart.
    const dayKeys = [...weekDaysOf(input.weekStart)]

    if (compareDayKeys(input.weekStart, input.todayKey) > 0) {
        throw new RangeError("INVALID:futureWeek")
    }

    const dayKeySet = new Set(dayKeys)

    const [plans, tasks] = await Promise.all([
        prisma.dailyPlan.findMany({
            where: { userId: input.userId, dayKey: { in: dayKeys } },
            select: { dayKey: true, availableMinutes: true },
        }),
        prisma.task.findMany({
            where: {
                userId: input.userId,
                OR: [
                    { dayKey: { in: dayKeys }, status: { not: "DONE" } },
                    { completedOn: { in: dayKeys }, status: "DONE" },
                ],
            },
            select: {
                dayKey: true,
                completedOn: true,
                status: true,
                allocatedMinutes: true,
                spentMinutes: true,
            },
        }),
    ])

    const planByDay = new Map<string, CoachPlanRow>()
    for (const plan of plans) {
        if (dayKeySet.has(plan.dayKey)) {
            planByDay.set(plan.dayKey, { availableMinutes: plan.availableMinutes })
        }
    }

    const doneByDay = new Map<string, CoachTaskRow[]>()
    const openByDay = new Map<string, CoachTaskRow[]>()

    for (const task of tasks) {
        if (task.status === "DONE") {
            const completedOn = task.completedOn
            if (completedOn !== null && dayKeySet.has(completedOn)) {
                const bucket = doneByDay.get(completedOn)
                if (bucket) bucket.push(task)
                else doneByDay.set(completedOn, [task])
            }
            continue
        }

        if (dayKeySet.has(task.dayKey)) {
            const bucket = openByDay.get(task.dayKey)
            if (bucket) bucket.push(task)
            else openByDay.set(task.dayKey, [task])
        }
    }

    const days: DayFacts[] = []
    let timedDoneTasks = 0

    for (const dayKey of dayKeys) {
        const done = doneByDay.get(dayKey) ?? []
        const open = openByDay.get(dayKey) ?? []

        days.push(buildDayFacts(dayKey, planByDay.get(dayKey) ?? null, done, open))

        // Covered-day only, so the input stays compatible with doneTotal.
        if (compareDayKeys(dayKey, input.todayKey) <= 0) {
            timedDoneTasks += countTimedDone(done)
        }
    }

    return buildWeeklyReport({
        todayKey: input.todayKey,
        weekStart: input.weekStart,
        days,
        timedDoneTasks,
    })
}
