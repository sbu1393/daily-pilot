/**
 * G-02 — Phase 4B-1: DRY-RUN analyzer for the Jalali → canonical dayKey migration.
 *
 * READ-ONLY: این اسکریپت فقط findMany میزند. هیچ UPDATE/DELETE/executeRaw و
 * هیچ اجرای migration در کار نیست. تغییر دیتا فقط در فاز 4B-2 و بعد از تأیید.
 *
 * Run:  node --experimental-strip-types scripts/analyze-daykey-migration.ts
 * Needs: DATABASE_URL + اعمالشده بودن migration فاز 2A (ستون User.timezone).
 *
 * قواعد تبدیل: فقط لایهی اپلیکیشن — از fromDayKey موجود (jalili.ts) برای
 * نیمهشب تهران و از getCanonicalDayKey (canonicalDay.ts) برای کلید canonical
 * بر اساس timezone هر کاربر استفاده میشود. هیچ پارس جلالی در SQL انجام نمیشود.
 */
import { pathToFileURL } from "node:url"
import jMoment from "moment-jalaali"
import { getPrisma } from "../app/lib/getPrisma.ts"
import { fromDayKey } from "../app/lib/jalili.ts"
import { getCanonicalDayKey } from "../app/lib/canonicalDay.ts"

const JALALI_KEY_RE = /^\d{4}-\d{2}-\d{2}$/
// کلیدی که سالش ۱۹۰۰+ است برای دیتای فعلی مشکوک است (میلادی‌نما / خراب)
const GREGORIAN_LOOKING_RE = /^(19|20)\d{2}-/

export type UserRow = { id: number; timezone: string }
export type TaskRow = {
    id: number
    userId: number
    dayKey: string | null
    scheduledDate: Date
    completedOn: string | null
    status: string
}
export type PlanRow = { id: number; userId: number; dayKey: string }

export type Issue = { kind: string; id: number; userId: number; detail: string }
export type Conversion = { from: string; to: string; tasks: number; plans: number }
export type Collision = { userId: number; to: string; sources: string[]; taskIds: number[]; planIds: number[] }
export type TaskConversionMapEntry = { userId: number; from: string; to: string; taskIds: number[] }
export type DailyPlanCollisionCandidate = { userId: number; to: string; sources: string[]; planIds: number[] }
export type PerUserCollision = { userId: number; timezone: string; collisions: number; taskIds: number[]; planIds: number[] }
export type AffectedRowCounts = {
    tasks: number
    tasksWithValidDayKey: number
    tasksMissingDayKey: number
    tasksInvalidDayKey: number
    dailyPlans: number
    dailyPlansValid: number
    dailyPlansInvalid: number
    totalRowsToRewrite: number // valid dayKeys + قابل derive (بدون invalidها)
}
export type RollbackPlan = {
    taskRowsInScope: number
    taskRowsUntouchable: number
    planRowsInScope: number
    planRowsUntouchable: number
    note: string
}

export type DryRunReport = {
    summary: { users: number; tasks: number; dailyPlans: number; conversions: number }
    missingScheduledDate: Issue[] // طبق اسکیما غیرممکن — دفاعی
    missingDayKey: Issue[] // dayKey null ولی scheduledDate موجود → قابل derive
    invalidDayKeys: Issue[] // فرمت/تاریخ جلالی نامعتبر (Task.dayKey، Task.completedOn، DailyPlan.dayKey)
    gregorianLookingKeys: Issue[] // کلیدهایی که سالشان ۱۹۰۰+ است
    inconsistentRecords: Issue[] // dayKey در تناقض با scheduledDate (فقط تسکهای باز — در DONE انتظارِ جابجایی داریم)
    doneCompletedOnMismatches: Issue[] // DONE بدون completedOn یا completedOn بدون DONE
    conversions: Conversion[] // جدول تبدیل distinct جلالی → canonical
    taskConversionMap: TaskConversionMapEntry[] // نقشهی دقیق تبدیل dayKey تسکها per user
    collisions: Collision[] // برخورد (userId, canonical) با منابع متفاوت — خطر برای unique ها
    dailyPlanCollisionCandidates: DailyPlanCollisionCandidate[] // کاندیداهای نقض unique روی DailyPlan
    perUserCollisions: PerUserCollision[] // گزارش برخورد per user
    affectedRowCounts: AffectedRowCounts // شمارش دقیق ردیفهای تحتتأثیر
    rollback: RollbackPlan // نیازمندیهای snapshot برای rollback
    verdict: { blockers: number; warnings: number; blockersDetail: string[] }
}

/** اعتبارسنجی سختگیرانهی کلید جلالی: فرمت + پارس strict + round-trip (توکنهای padded: jMM/jDD) */
export function isValidJalaliKey(key: string): boolean {
    if (!JALALI_KEY_RE.test(key)) return false
    const m = jMoment(key, "jYYYY-jMM-jDD", true)
    return m.isValid() && m.format("jYYYY-jMM-jDD") === key
}

/** قاعدهی تبدیل معماری: جلالی → نیمهشب تهران → کلید canonical میلادی در timezone کاربر */
export function toCanonicalKey(jalaliKey: string, timezone: string): string {
    return getCanonicalDayKey(fromDayKey(jalaliKey), timezone)
}

function pushInvalid(out: Issue[], kind: string, id: number, userId: number, key: string) {
    const reason = !JALALI_KEY_RE.test(key)
        ? "bad-format"
        : GREGORIAN_LOOKING_RE.test(key)
          ? "gregorian-looking"
          : "invalid-jalali-date"
    out.push({ kind: `${kind}:${reason}`, id, userId, detail: key })
}

export function analyze(
    users: UserRow[],
    tasks: TaskRow[],
    plans: PlanRow[],
    convert: (jalaliKey: string, timezone: string) => string = toCanonicalKey,
): DryRunReport {
    const tzOf = new Map(users.map((u) => [u.id, u.timezone]))

    const report: DryRunReport = {
        summary: { users: users.length, tasks: tasks.length, dailyPlans: plans.length, conversions: 0 },
        missingScheduledDate: [],
        missingDayKey: [],
        invalidDayKeys: [],
        gregorianLookingKeys: [],
        inconsistentRecords: [],
        doneCompletedOnMismatches: [],
        conversions: [],
        taskConversionMap: [],
        collisions: [],
        dailyPlanCollisionCandidates: [],
        perUserCollisions: [],
        affectedRowCounts: {
            tasks: 0,
            tasksWithValidDayKey: 0,
            tasksMissingDayKey: 0,
            tasksInvalidDayKey: 0,
            dailyPlans: 0,
            dailyPlansValid: 0,
            dailyPlansInvalid: 0,
            totalRowsToRewrite: 0,
        },
        rollback: {
            taskRowsInScope: 0,
            taskRowsUntouchable: 0,
            planRowsInScope: 0,
            planRowsUntouchable: 0,
            note: "",
        },
        verdict: { blockers: 0, warnings: 0, blockersDetail: [] },
    }

    const convCounts = new Map<string, Conversion>() // key: `${userId}|${from}`
    const canonicalSources = new Map<string, Collision>() // key: `${userId}|${to}`
    const taskConvMap = new Map<string, TaskConversionMapEntry>() // key: `${userId}|${from}`
    let tasksValid = 0
    let tasksMissing = 0
    let tasksInvalid = 0
    let plansValid = 0
    let plansInvalid = 0

    const recordConversion = (
        kind: "task" | "plan",
        userId: number,
        from: string,
        to: string,
        id: number,
    ) => {
        const ck = `${userId}|${from}`
        let c = convCounts.get(ck)
        if (!c) {
            c = { from, to, tasks: 0, plans: 0 }
            convCounts.set(ck, c)
        }
        if (kind === "task") {
            c.tasks++
            const tk = `${userId}|${from}`
            let entry = taskConvMap.get(tk)
            if (!entry) {
                entry = { userId, from, to, taskIds: [] }
                taskConvMap.set(tk, entry)
            }
            entry.taskIds.push(id)
        } else {
            c.plans++
        }

        const sk = `${userId}|${to}`
        let s = canonicalSources.get(sk)
        if (!s) {
            s = { userId, to, sources: [], taskIds: [], planIds: [] }
            canonicalSources.set(sk, s)
        }
        if (!s.sources.includes(from)) s.sources.push(from)
        if (kind === "task") s.taskIds.push(id)
        else s.planIds.push(id)
    }

    for (const t of tasks) {
        const tz = tzOf.get(t.userId) ?? "UTC"
        if (t.scheduledDate == null || Number.isNaN(t.scheduledDate.getTime())) {
            report.missingScheduledDate.push({
                kind: "task:missing-scheduledDate",
                id: t.id,
                userId: t.userId,
                detail: `status=${t.status}`,
            })
        }

        if (t.dayKey == null) {
            tasksMissing++
            report.missingDayKey.push({
                kind: "task:missing-dayKey",
                id: t.id,
                userId: t.userId,
                detail:
                    t.scheduledDate && !Number.isNaN(t.scheduledDate.getTime())
                        ? `derivable canonical=${getCanonicalDayKey(t.scheduledDate, tz)}`
                        : "no scheduledDate either",
            })
        } else if (isValidJalaliKey(t.dayKey)) {
            tasksValid++
            const to = convert(t.dayKey, tz)
            recordConversion("task", t.userId, t.dayKey, to, t.id)

            // تناقض dayKey با scheduledDate — فقط برای تسکهای باز هشدار است؛
            // در DONE جابجایی dayKey به روز اتمام رفتار عمدی سیستم است.
            if (t.scheduledDate && !Number.isNaN(t.scheduledDate.getTime())) {
                const scheduledCanonical = getCanonicalDayKey(t.scheduledDate, tz)
                if (scheduledCanonical !== to && t.status !== "DONE") {
                    report.inconsistentRecords.push({
                        kind: "task:dayKey-scheduledDate-drift",
                        id: t.id,
                        userId: t.userId,
                        detail: `dayKey→${to} but scheduledDate→${scheduledCanonical} (status=${t.status})`,
                    })
                }
            }
        } else {
            if (GREGORIAN_LOOKING_RE.test(t.dayKey)) {
                report.gregorianLookingKeys.push({
                    kind: "task.dayKey",
                    id: t.id,
                    userId: t.userId,
                    detail: t.dayKey,
                })
            }
            tasksInvalid++
            pushInvalid(report.invalidDayKeys, "task.dayKey", t.id, t.userId, t.dayKey)
        }

        if (t.completedOn != null) {
            if (!isValidJalaliKey(t.completedOn)) {
                if (GREGORIAN_LOOKING_RE.test(t.completedOn)) {
                    report.gregorianLookingKeys.push({
                        kind: "task.completedOn",
                        id: t.id,
                        userId: t.userId,
                        detail: t.completedOn,
                    })
                }
                pushInvalid(report.invalidDayKeys, "task.completedOn", t.id, t.userId, t.completedOn)
            } else if (t.status !== "DONE") {
                report.doneCompletedOnMismatches.push({
                    kind: "task:completedOn-without-DONE",
                    id: t.id,
                    userId: t.userId,
                    detail: `completedOn=${t.completedOn} status=${t.status}`,
                })
            }
        } else if (t.status === "DONE") {
            report.doneCompletedOnMismatches.push({
                kind: "task:DONE-without-completedOn",
                id: t.id,
                userId: t.userId,
                detail: `status=DONE`,
            })
        }
    }

    for (const p of plans) {
        if (isValidJalaliKey(p.dayKey)) {
            plansValid++
            recordConversion("plan", p.userId, p.dayKey, convert(p.dayKey, tzOf.get(p.userId) ?? "UTC"), p.id)
        } else {
            plansInvalid++
            if (GREGORIAN_LOOKING_RE.test(p.dayKey)) {
                report.gregorianLookingKeys.push({
                    kind: "dailyPlan.dayKey",
                    id: p.id,
                    userId: p.userId,
                    detail: p.dayKey,
                })
            }
            pushInvalid(report.invalidDayKeys, "dailyPlan.dayKey", p.id, p.userId, p.dayKey)
        }
    }

    report.conversions = Array.from(convCounts.values()).sort((a, b) =>
        a.from < b.from ? -1 : a.from > b.from ? 1 : 0,
    )
    report.collisions = Array.from(canonicalSources.values())
        .filter((c) => c.sources.length > 1)
        .sort((a, b) => a.userId - b.userId || (a.to < b.to ? -1 : 1))

    report.taskConversionMap = Array.from(taskConvMap.values()).sort((a, b) =>
        a.userId - b.userId || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0),
    )

    const perUser = new Map<number, PerUserCollision>()
    for (const c of report.collisions) {
        let p = perUser.get(c.userId)
        if (!p) {
            p = { userId: c.userId, timezone: tzOf.get(c.userId) ?? "unknown", collisions: 0, taskIds: [], planIds: [] }
            perUser.set(c.userId, p)
        }
        p.collisions++
        p.taskIds.push(...c.taskIds)
        p.planIds.push(...c.planIds)
    }
    report.perUserCollisions = Array.from(perUser.values()).sort((a, b) => a.userId - b.userId)

    report.dailyPlanCollisionCandidates = report.collisions
        .filter((c) => c.planIds.length > 0)
        .map((c) => ({ userId: c.userId, to: c.to, sources: c.sources, planIds: c.planIds }))

    report.affectedRowCounts = {
        tasks: tasks.length,
        tasksWithValidDayKey: tasksValid,
        tasksMissingDayKey: tasksMissing,
        tasksInvalidDayKey: tasksInvalid,
        dailyPlans: plans.length,
        dailyPlansValid: plansValid,
        dailyPlansInvalid: plansInvalid,
        totalRowsToRewrite: tasksValid + tasksMissing + plansValid,
    }

    report.rollback = {
        taskRowsInScope: tasksValid + tasksMissing,
        taskRowsUntouchable: tasksInvalid,
        planRowsInScope: plansValid,
        planRowsUntouchable: plansInvalid,
        note: "Snapshot Task + DailyPlan + User قبل از rewrite (pg_dump + audit JSON per-row) — جزئیات در docs/daykey-canonical-migration-plan.md",
    }

    const planBlockers = report.collisions.filter((c) => c.planIds.length > 0)
    const invalidPlans = report.invalidDayKeys.filter((i) => i.kind.startsWith("dailyPlan"))
    report.verdict.blockersDetail = [
        ...planBlockers.map((c) => `DailyPlan unique collision: user=${c.userId} → ${c.to} from ${c.sources.join(" + ")}`),
        ...invalidPlans.map((i) => `Unconvertible DailyPlan.dayKey id=${i.id}: ${i.detail}`),
    ]
    report.verdict.blockers =
        report.verdict.blockersDetail.length +
        (report.missingScheduledDate.length > 0 ? 1 : 0)
    report.verdict.warnings =
        report.invalidDayKeys.length +
        report.missingDayKey.length +
        report.inconsistentRecords.length +
        report.doneCompletedOnMismatches.length +
        report.gregorianLookingKeys.length

    report.summary.conversions = report.conversions.length
    return report
}

async function main() {
    const prisma = getPrisma()

    let users: UserRow[]
    try {
        users = await prisma.user.findMany({ select: { id: true, timezone: true }, orderBy: { id: "asc" } })
    } catch (error) {
        console.error(
            "✖ READ FAILED — احتمالاً migration فاز 2A اعمال نشده (ستون User.timezone).",
            "قبل از تحلیل، migrationهای معلق را روی دیتابیس مقصد اعمال کن:",
            error instanceof Error ? error.message : error,
        )
        process.exitCode = 1
        return
    }

    const taskRows = await prisma.task.findMany({
        select: { id: true, userId: true, dayKey: true, scheduledDate: true, completedOn: true, status: true },
        orderBy: { id: "asc" },
    })
    const planRows = await prisma.dailyPlan.findMany({
        select: { id: true, userId: true, dayKey: true },
        orderBy: { id: "asc" },
    })

    const report = analyze(users, taskRows, planRows)

    console.log("=== G-02 DRY-RUN (READ-ONLY — no writes performed) ===")
    console.log(JSON.stringify(report, null, 2))
    console.log("=== END — database untouched ===")
}

const invokedDirectly =
    process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
    main().catch((error) => {
        console.error("✖ DRY-RUN FAILED:", error)
        process.exitCode = 1
    })
}
