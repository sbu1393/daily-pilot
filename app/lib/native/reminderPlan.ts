import type { TaskReminder } from "@/app/lib/taskReminder"

/*
 * برنامه‌ی عملیات نیتیو برای لیست یادآورها — منطق خالص و بدون React.
 * -----------------------------------------------------------------
 * تنها جایی که تصمیم گرفته می‌شود «کدام یادآور باید در سیستم‌عامل زمان‌بندی
 * شود و کدام اعلان باید لغو شود». از `useTaskReminder` بیرون کشیده شده تا
 * این تصمیم بدون mount کردن یک hook قابل تست باشد.
 *
 * قاعده‌ی کلیدی (باگ واقعیِ رفع‌شده):
 *   «اجرا شده» هرگز به‌معنای «لغو کن» نیست.
 *
 * اگر `firedAt !== null` را از مجموعه‌ی «مطلوب‌ها» بیرون بگذاریم، آن یادآور
 * در نگاه بعدیِ effect «کهنه» دیده می‌شود و اعلانش لغو می‌گردد. روی Android
 * با آلارم غیردقیق (`setAndAllowWhileIdle`) این یعنی: اگر زمان رسیدن یادآور
 * بگذرد ولی سیستم‌عامل آلارم را کمی دیرتر برساند، خودِ اپ اعلانِ در انتظار را
 * پیش از رسیدن لغو می‌کند. پس:
 *   - «زمان‌بندی» فقط برای یادآورهای اجرانشده لازم است؛
 *   - «لغو» فقط وقتی معنا دارد که یادآور از لیست **حذف** شده باشد
 *     (کار حذف/تمام شد، یا یادآور دستی پاک شد).
 */

export type NativeReminderPlan = {
    /** شناسه‌ی تسک‌هایی که باید زمان‌بندی شوند (یادآورِ اجرانشده). */
    toSchedule: number[]
    /** شناسه‌ی تسک‌هایی که اعلانشان باید لغو شود (یادآوری دیگر در لیست نیست). */
    stale: number[]
}

/**
 * برنامه‌ی عملیات را از لیست یادآورها و مجموعه‌ی شناسه‌های زمان‌بندی‌شده می‌سازد.
 *
 * @param reminders لیست فعلی یادآورها (منبع حقیقت UI)
 * @param scheduled شناسه‌ی تسک‌هایی که همین حالا اعلان نیتیو دارند
 */
export function planNativeReminders(
    reminders: TaskReminder[],
    scheduled: Iterable<number>,
): NativeReminderPlan {
    /* همه‌ی یادآورهای موجود «مطلوب»اند — اجراشده یا نه. */
    const wanted = new Set<number>()
    for (const reminder of reminders) wanted.add(reminder.taskId)

    const stale = Array.from(scheduled).filter((taskId) => !wanted.has(taskId))

    /* ترتیب لیست حفظ می‌شود تا ترتیب فراخوانی‌های پل قطعی بماند. */
    const toSchedule = reminders
        .filter((reminder) => reminder.firedAt === null)
        .map((reminder) => reminder.taskId)

    return { toSchedule, stale }
}
