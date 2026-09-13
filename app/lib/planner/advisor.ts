// Advisor — «الان با چه کاری شروع کنم؟» — Part 1/3 (Pure Logic)
// -------------------------------------------------------------
// یک لایه‌ی مشاوره‌ایِ کاملاً PURE روی همان دامنه‌ی موجود:
// - بدون DB، بدون شبکه، بدون side-effect — فقط مرتب‌سازی و ریاضیات ساده.
// - هیچ فایل موجودی را تغییر نمی‌دهد؛ هیچ وابستگی‌ای import نمی‌کند.
// - هیچ لحن قطعی/دِدلاینی در پیام‌ها نیست؛ فقط پیشنهاد دوستانه.
//
// قراردادها:
// - ورودی هرگز mutate نمی‌شود (اول clone، بعد sort).
// - ترتیب: وضعیت (IN_PROGRESS > TODO > DONE) ← اولویت (HIGH > MEDIUM > LOW > null)
//   ← امتیاز نزولی (null = ۵۰) ← تخمین بزرگ‌تر جلوتر ← id صعودی.
// - همه‌ی دقیقه‌ها clamp می‌شوند تا اعدادِ عقلایی و قابل نمایش بمانند.

export type AdvisorTaskInput = {
    id: number
    title: string
    status: "TODO" | "IN_PROGRESS" | "DONE"
    priority: "HIGH" | "MEDIUM" | "LOW" | null
    score: number | null
    estimatedTime: number | null
    allocatedMinutes: number | null
}

export type AdvisorItem = {
    taskId: number
    rank: number
    estimatedMinutes: number
    focusMinutes: number
    pauseAfterMinutes: number
    reason: string
}

export type AdvisorResult = {
    orderedTaskIds: number[]
    nextTaskId: number | null
    items: AdvisorItem[]
    totalEstimatedMinutes: number
    overflowTaskIds: number[]
    message: string
}

/** وزن ترتیبِ وضعیت — کوچک‌تر = جلوتر */
const STATUS_WEIGHT: Record<AdvisorTaskInput["status"], number> = {
    IN_PROGRESS: 0,
    TODO: 1,
    DONE: 2,
}

/** وزن ترتیبِ اولویت — null آخرِ صف (بعد از LOW) */
const PRIORITY_WEIGHT: Record<"HIGH" | "MEDIUM" | "LOW", number> = {
    HIGH: 0,
    MEDIUM: 1,
    LOW: 2,
}
/** null → آخرِ صف */
const PRIORITY_WEIGHT_NULL = 3
const priorityWeightOf = (priority: AdvisorTaskInput["priority"]): number =>
    priority === null ? PRIORITY_WEIGHT_NULL : PRIORITY_WEIGHT[priority]

/** تخمین پیش‌فرض وقتی کاربر/هوش مصنوعی چیزی ثبت نکرده — همسو با موتور پیشنهاد روز */
const DEFAULT_ESTIMATE = 30

/** دلیلِ هر رتبه — فقط از همان کلیدهایی که واقعاً در مرتب‌سازی اثر گذاشتند */
function reasonOf(task: AdvisorTaskInput): string {
    if (task.status === "IN_PROGRESS") return "در حال انجام — اول ادامه‌اش بده"
    if (task.status === "DONE") return "انجام شده"
    switch (task.priority) {
        case "HIGH":
            return "اولویت بالا"
        case "MEDIUM":
            return "اولویت متوسط"
        case "LOW":
            return "اولویت پایین"
        default:
            return "بدون اولویت مشخص"
    }
}

/**
 * مشاور شروع — Pure function (بدون I/O، بدون persist، بدون AI).
 *
 * - `orderedTaskIds`/`items`: کل کارها (حتی DONE — همیشه آخرِ صف) با رتبه‌ی ۱-محور.
 * - `nextTaskId`: اولین کارِ غیر-DONE در ترتیب؛ برای لیست خالی/تمام‌شده null.
 * - `totalEstimatedMinutes`: جمع تخمین امنِ همه‌ی کارها (نه فقط امروز).
 * - `overflowTaskIds`: وقتی `availableMinutes` عدد باشد، کارهایی که در ظرفیتِ باقی‌مانده
 *   به‌طور کامل جا نمی‌شوند (کارهای DONE چیزی از ظرفیت مصرف نمی‌کنند).
 *   ظرفیت null یعنی محدودیتی اعلام نشده → سرریزی وجود ندارد.
 */
export function buildAdvisor(
    tasks: AdvisorTaskInput[],
    opts: { displayName: string; availableMinutes: number | null },
): AdvisorResult {
    // ۱) clone صریح — ورودی caller هرگز دست نمی‌خورد
    const ordered = [...tasks].sort((a, b) => {
        const byStatus = STATUS_WEIGHT[a.status] - STATUS_WEIGHT[b.status]
        if (byStatus !== 0) return byStatus

        const byPriority = priorityWeightOf(a.priority) - priorityWeightOf(b.priority)
        if (byPriority !== 0) return byPriority

        const scoreA = a.score ?? 50
        const scoreB = b.score ?? 50
        if (scoreA !== scoreB) return scoreB - scoreA // امتیاز نزولی

        const estA = a.estimatedTime ?? DEFAULT_ESTIMATE
        const estB = b.estimatedTime ?? DEFAULT_ESTIMATE
        if (estA !== estB) return estB - estA // تلاش بزرگ‌تر جلوتر

        return a.id - b.id // تساوی کامل → id صعودی
    })

    // ۲) دقیقه‌های امن (همان فرمول‌های clamp در مشخصات)
    const estimatedOf = (t: AdvisorTaskInput) =>
        Math.min(Math.max(t.estimatedTime ?? DEFAULT_ESTIMATE, 5), 480)
    const focusOf = (estimatedMinutes: number) =>
        Math.min(Math.max(estimatedMinutes, 25), 90)
    const pauseOf = (focusMinutes: number) =>
        Math.min(Math.max(focusMinutes + 30, 60), 120)

    // ۳) رتبه‌بندی ۱-محور برای همه‌ی کارها
    const items: AdvisorItem[] = ordered.map((t, index) => {
        const estimatedMinutes = estimatedOf(t)
        const focusMinutes = focusOf(estimatedMinutes)
        return {
            taskId: t.id,
            rank: index + 1,
            estimatedMinutes,
            focusMinutes,
            pauseAfterMinutes: pauseOf(focusMinutes),
            reason: reasonOf(t),
        }
    })

    const orderedTaskIds = ordered.map((t) => t.id)

    // ۴) کار بعدی: اولین غیر-DONE در همان ترتیب
    const nextTask = ordered.find((t) => t.status !== "DONE") ?? null

    // ۵) سرریز ظرفیت — فقط وقتی ظرفیت عددی اعلام شده؛ DONE از ظرفیت مصرف نمی‌کند
    const overflowTaskIds: number[] = []
    if (opts.availableMinutes !== null) {
        let consumed = 0
        for (const t of ordered) {
            if (t.status === "DONE") continue
            const estimate = estimatedOf(t)
            if (consumed + estimate > opts.availableMinutes) {
                overflowTaskIds.push(t.id)
            } else {
                consumed += estimate
            }
        }
    }

    // ۶) پیام دوستانه — بدون دِدلاین، بدون لحن قطعی
    let message: string
    if (!nextTask) {
        message =
            tasks.length === 0
                ? `${opts.displayName} جان، فعلاً کاری برای پیشنهاد ندارم.`
                : `${opts.displayName} جان، همه‌ی کارها انجام شده — دست مریزاد! 🎉`
    } else {
        message = `${opts.displayName} جان، پیشنهاد من اینه که با تسک «${nextTask.title}» شروع کنی.`
    }

    return {
        orderedTaskIds,
        nextTaskId: nextTask ? nextTask.id : null,
        items,
        totalEstimatedMinutes: items.reduce((sum, item) => sum + item.estimatedMinutes, 0),
        overflowTaskIds,
        message,
    }
}
