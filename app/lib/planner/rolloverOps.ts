// Phase 4.4 — pure core of «انتقال تسک به روز دیگر» (rollover)
// ------------------------------------------------------------------
// این ماژول **هیچ I/O ای ندارد**. فقط از روی تسک‌های از قبل خوانده‌شده، «شرحِ
// نوشتن» (write plan) را تولید می‌کند: هر تسک چه چیزی را به کدام روز می‌برد و
// چه رویدادی باید ثبت شود.
//
// چرا pure core؟ چون دو مسیرِ مستقل باید **دقیقاً یک** تعریف داشته باشند:
//   - `rolloverTasks()`  → تراکنش خودش را دارد و همان را می‌سازد.
//   - `applyPlan()`      → داخل تراکنش Apply، همراه گاردِ نسخه و metadata.
//
// اگر هر کدام منطق خودش را داشتند، یکی از آن‌ها به‌مرور از دیگری عقب می‌ماند و
// «یک انتقال، دو معنا» می‌شد. اینجا یک هستهٔ واحد داریم و هر دو مصرف‌کننده فقط
// آن را به Prisma خودش ترجمه می‌کنند (شکل فراخوانی Prisma در هر دو مسیر فرق دارد،
// پس ترجمه عمداً بیرون از این ماژول است).
//
// قواعد قفل‌شده (LOCKED):
// - Planning-only: فقط dayKey/scheduledDate/previousScheduledDate/allocatedMinutes
//   نوشته می‌شوند. status/category/priority/score/estimatedTime/reason **هرگز**
//   در write plan نمی‌آیند — پس امکان پاک‌کردن یا بازنویسی‌شان هم صفر است.
// - مقصد (toDayKey) **داوری‌شده از بیرون** است؛ این ماژول خودش تصمیم نمی‌گیرد فردا کیست.
//   مسیر عمومی rollover قاعدهٔ «عقب‌افتاده → امروز» خودش را نگه می‌دارد و مسیر
//   Apply همیشه `shiftCanonicalKey(basis.dayKey, 1)` را می‌دهد.
// - تاریخ‌ها فقط با helperهای canonical محاسبه می‌شوند (بدون دست‌کاری دستی تاریخ).
// - هیچ Prisma، هیچ PrismaClient، هیچ ساعت سیستمی: کاملاً قابل تست در node.

import { canonicalKeyToLocalMidnight } from "@/app/lib/canonicalDay"

/** حداقلِ ساختاری که برای ساخت write plan لازم است (Task کامل Prisma هم می‌تواند بدهد شود). */
export type RolloverSourceTask = {
    id: number
    dayKey: string
    scheduledDate: Date
    allocatedMinutes?: number | null
}

/** نوشتنِ لازم روی یک تسک برای انتقالش به روز مقصد. */
export type RolloverTaskOp = {
    taskId: number
    fromDayKey: string
    toDayKey: string
    /** نیمه‌شب محلیِ روز مقصد در timezone کاربر (instant UTC) */
    scheduledDate: Date
    /** تاریخ قبلی — برای تشخیص rollover دست‌نخورده می‌ماند */
    previousScheduledDate: Date
    /** تخصیص در روز مقصد دوباره با rebalance تصمیم گرفته می‌شود */
    allocatedMinutes: null
}

/** رویداد تاریخچه‌ایِ همان انتقال (semantics یکسان با TaskEvent موجود). */
export type RolloverEventOp = {
    taskId: number
    fromDayKey: string
    toDayKey: string
}

export type RolloverOps = {
    /** خلاصهٔ گزارش‌پذیر (همان شکلی که rolloverTasks قبلاً برمی‌گرداند) */
    moved: { id: number; from: string; to: string }[]
    taskOps: RolloverTaskOp[]
    eventOps: RolloverEventOp[]
}

/**
 * buildRolloverOps — هستهٔ خالصِ rollover.
 *
 * @param tasks       تسک‌های از قبل خوانده‌شده و متعلق به کاربر (فیلتر وضعیت/مالکیت
 *                   بر عهدهٔ مصرف‌کننده است؛ اینجا هیچ query ای زده نمی‌شود).
 * @param toDayKey    روز مقصد — **تصمیم‌گرفته‌شده توسط مصرف‌کننده**.
 * @param timezone    timezone کاربر، فقط برای محاسبهٔ نیمه‌شب محلیِ مقصد.
 */
export function buildRolloverOps(
    tasks: readonly RolloverSourceTask[],
    toDayKey: string,
    timezone: string,
): RolloverOps {
    const destinationDate = canonicalKeyToLocalMidnight(toDayKey, timezone)

    const taskOps: RolloverTaskOp[] = tasks.map((task) => ({
        taskId: task.id,
        fromDayKey: task.dayKey,
        toDayKey,
        scheduledDate: destinationDate,
        previousScheduledDate: task.scheduledDate,
        allocatedMinutes: null,
    }))

    const eventOps: RolloverEventOp[] = taskOps.map((op) => ({
        taskId: op.taskId,
        fromDayKey: op.fromDayKey,
        toDayKey: op.toDayKey,
    }))

    const moved = taskOps.map((op) => ({ id: op.taskId, from: op.fromDayKey, to: op.toDayKey }))

    return { moved, taskOps, eventOps }
}
