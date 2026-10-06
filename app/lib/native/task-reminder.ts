"use client"

import type { ScheduleWarning } from "@capacitor/local-notifications"

import {
    cancelLocalReminder,
    scheduleLocalReminder,
    type LocalNotificationFailure,
    type LocalNotificationFailureReason,
    type LocalNotificationPermissionOutcome,
} from "@/app/lib/native/local-notifications"
import { enqueueNative, stableNotificationId } from "@/app/lib/native/primitives"

/*
 * یادآور تسک — لایه‌ی نیتیو (Android)
 * -----------------------------------------------------------------
 * همتای `daily-reminder.ts` برای یادآور هر تسک، و دقیقاً با همان قواعد:
 *
 * - **هیچ ریاضیات زمان جدیدی اختراع نمی‌شود.** `dueAt` در پروژه از قبل یک لحظه‌ی
 *   مطلق است: UI فاصله‌ی دلخواه (۱۰/۳۰/۶۰ دقیقه یا زمان دلخواه) را هنگام انتخاب
 *   به `Date.now() + lead` تبدیل و ذخیره می‌کند. اینجا فقط همان لحظه‌ی ذخیره‌شده به
 *   زمان‌بند نیتیو داده می‌شود؛ نه `lead` دوباره اعمال می‌شود و نه مفهومش عوض.
 *
 * - **هیچ چیزی درباره‌ی سرور، Prisma، Web Push یا cron می‌داند.** یادآور تسک
 *   از ابتدا یک مفهوم کاملاً دستگاهی بوده و می‌ماند؛ فقط *delivery* روی Android
 *   از تایمر مرورگر به سیستم‌عامل منتقل می‌شود.
 *
 * - هیچ دسترسی مستقیمی به `window`/`Capacitor` در این فایل نیست؛ تشخیص پلتفرم و
 *   درخواست مجوز از بیرون تزریق می‌شوند تا ترتیبشان قابل تست باشد.
 *
 * قواعد مشترک با یادآور روزانه: توابع «شکست‌ناپذیر» هستند و خروجی ساختاریافته با
 * `reason` می‌دهند؛ شناسه قطعی است پس زمان‌بندی دوباره همان اعلان را **جایگزین**
 * می‌کند و هرگز duplicate نمی‌سازد؛ و همه‌ی عملیات از صف سریال مشترک عبور
 * می‌کنند تا `cancel` بعد از `schedule` ننشیند.
 */

/** دلیل شکست — دو مورد از همین wrapper می‌آید، بقیه از لایه‌ی نیتیو. */
export type TaskReminderFailureReason =
    | "INVALID_TASK_ID"
    | "INVALID_DUE_AT"
    | "IN_THE_PAST"
    | LocalNotificationFailureReason

export type TaskReminderScheduleOutcome =
    | { ok: true; id: number; at: Date; warning?: ScheduleWarning }
    | { ok: false; reason: TaskReminderFailureReason; message: string }

export type TaskReminderCancelOutcome =
    | { ok: true }
    | { ok: false; reason: TaskReminderFailureReason; message: string }

/** پیشوند کلید — یادآور روزانه `daily-reminder:` دارد و از این جدا می‌ماند. */
export const TASK_REMINDER_KEY_PREFIX = "task-reminder"

/**
 * شناسه‌ی قطعی اعلان یادآور یک تسک.
 *
 * فقط به `taskId` وابسته است، نه به تاریخ و نه به زمان انتخابی — دقیقاً همان
 * سیاستی که یادآور روزانه برای scope خودش دارد. نتیجه:
 *  - تغییر زمان reminder ⇒ همان `id` ⇒ اعلان قبلی **جایگزین** می‌شود؛
 *  - حذف reminder ⇒ همان `id` ⇒ بدون نیاز به «به‌خاطر سپردن» لغو می‌شود؛
 *  - باز شدن دوباره‌ی اپ ⇒ همان `id` قابل بازیابی است.
 */
export function taskReminderNotificationId(taskId: number): number {
    return stableNotificationId(`${TASK_REMINDER_KEY_PREFIX}:${taskId}`)
}

/** آیا شناسه‌ی تسک قابل استفاده است؟ (۱ و ب��تر) */
function isValidTaskId(taskId: number): boolean {
    return Number.isInteger(taskId) && taskId > 0
}

function toFailure(
    reason: TaskReminderFailureReason,
    message: string,
): { ok: false; reason: TaskReminderFailureReason; message: string } {
    return { ok: false, reason, message }
}

/**
 * اعتبارسنجی زمان یادآور — پیش از هر تماس با پل نیتیو.
 *
 * `dueAt <= now` یعنی یادآور از دست رفته (مثلاً اپ دیروز باز نشده بود، یا کاربر
 * همین حالا ساعتی را انتخاب کرده که گذشته). در این حالت اصلاً زمان‌بندی نمی‌کنیم:
 * آلارمی در گذشته یعنی اعلانی که یا همان لحظه می‌پرد یا اصلاً نمی‌پرد، و در
 * هر دو حالت کاربر گمراه می‌شود. مسیر مرورگر برای این حالت همان رفتار قبلی
 * (`markDueReminders` + پنجره‌ی جبران ۱۵ دقیقه‌ای) را نگه می‌دارد.
 */
export function validateTaskReminderTime(
    dueAt: number,
    now: number = Date.now(),
): { ok: true; at: Date } | { ok: false; reason: TaskReminderFailureReason; message: string } {
    if (!Number.isFinite(dueAt)) {
        return toFailure("INVALID_DUE_AT", "زمان یادآور معتبر نیست؛ اعلانی زمان‌بندی نشد.")
    }

    const at = new Date(dueAt)

    if (at.getTime() <= now) {
        return toFailure("IN_THE_PAST", "زمان یادآور گذشته است؛ اعلانی زمان‌بندی نشد.")
    }

    return { ok: true, at }
}

/**
 * زمان‌بندی اعلان محلی یادآورِ یک تسک.
 *
 * اگر قبلاً با همین شناسه زمان‌بندی شده باشد، جایگزینش می‌شود (idempotent) — پس
 * «تغییر زمان reminder» یک اعلان تازه نمی‌سازد، همان قبلی را عوض می‌کند.
 */
export async function scheduleTaskReminder(input: {
    taskId: number
    title: string
    dueAt: number
}): Promise<TaskReminderScheduleOutcome> {
    if (!isValidTaskId(input.taskId)) {
        return toFailure("INVALID_TASK_ID", "شناسه‌ی کار معتبر نیست؛ اعلانی زمان‌بندی نشد.")
    }

    const validated = validateTaskReminderTime(input.dueAt)
    if (!validated.ok) return validated

    const { at } = validated

    return enqueueNative(async () => {
        const result = await scheduleLocalReminder({
            title: `🔔 ${input.title}`,
            body: "زمان انجام این کار رسیده است ⏰",
            id: taskReminderNotificationId(input.taskId),
            at,
        })

        if (!result.ok) return result

        return { ok: true, id: result.id, at, warning: result.warning }
    })
}

/** لغو اعلان یادآورِ یک تسک — همیشه با همان شناسه‌ی قطعی. */
export async function cancelTaskReminder(taskId: number): Promise<TaskReminderCancelOutcome> {
    if (!isValidTaskId(taskId)) {
        return toFailure("INVALID_TASK_ID", "شناسه‌ی کار معتبر نیست.")
    }

    return enqueueNative(async () => {
        const result = await cancelLocalReminder(taskReminderNotificationId(taskId))

        if (!result.ok) return result

        return { ok: true as const }
    })
}

/**
 * لغو گروهی — برای «تسک حذف/انجام شد» و برای پاک‌سازی هنگام تعویض کاربر.
 *
 * هر لغو از صف مشترک رد می‌شود و هیچ‌کدام شکستِ دیگری را متوقف نمی‌کند.
 */
export async function cancelTaskReminders(taskIds: number[]): Promise<void> {
    const unique = Array.from(new Set(taskIds.filter(isValidTaskId)))

    await Promise.all(unique.map((taskId) => cancelTaskReminder(taskId)))
}

export type TaskReminderAuthorizeOutcome =
    | { ok: true; at: Date }
    | LocalNotificationFailure
    | { ok: false; reason: TaskReminderFailureReason; message: string }

/**
 * دروازه‌ی ثبت یادآور روی نیتیو — **پیش از** هر ذخیره‌سازی یا زمان‌بندی.
 *
 * چرا این تابع وجود دارد؟ همان باگی که یادآور روزانه را از کار انداخت: اگر
 * زمان‌بندی پیش از آماده‌شدن مجوز شروع شود، `ensurePermission()` هنوز `prompt`
 * می‌بیند و **پیش از رسیدن به `plugin.schedule()`** برمی‌گردد؛ آن خطا بی‌صدا
 * می‌ماند و هیچ آلارمی ساخته نمی‌شود. اینجا هر دو شرط — اعتبار زمان و مجوز —
 * پیش از اجازه‌ی ذخیره/زمان‌بندی بسته می‌شوند.
 *
 * عمداً **زمان‌بندی نمی‌کند**: تنها جایی که `scheduleTaskReminder` صدا زده
 * می‌شود، effect واکنشی روی لیست یادآورهاست (single source of truth). اگر هم
 * اینجا و هم آنجا زمان‌بندی می‌شد، هر ثبت دو بار از پل عبور می‌کرد.
 *
 * هیچ Capacitor ای mock نمی‌شود: فقط یک تابع مجوز تزریق می‌شود.
 */
export async function authorizeTaskReminder(input: {
    taskId: number
    dueAt: number
    requestPermission: () => Promise<LocalNotificationPermissionOutcome>
}): Promise<TaskReminderAuthorizeOutcome> {
    if (!isValidTaskId(input.taskId)) {
        return toFailure("INVALID_TASK_ID", "شناسه‌ی کار معتبر نیست؛ یادآوری ثبت نشد.")
    }

    const validated = validateTaskReminderTime(input.dueAt)
    if (!validated.ok) return validated

    const permission = await input.requestPermission()
    if (!permission.ok) {
        return {
            ok: false,
            reason: permission.reason,
            message: permission.message,
        }
    }

    return { ok: true, at: validated.at }
}
