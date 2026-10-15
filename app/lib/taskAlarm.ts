import { stableNotificationId } from "./native/primitives"
import { scopeToken } from "./reminder"

/**
 * آلارم تسک — منطق خالص (بدون React و بدون DOM).
 *
 * ── چرا این ماژول جدا از `taskReminder.ts` است؟ ──────────────────────
 * این دو قابلیتِ متفاوت‌اند و باید مستقل بمانند:
 *
 *   یادآور (Feature A) → اعلان در نوار اعلان، از سوی پلاگین
 *                        `@capacitor/local-notifications`.
 *   آلارم  (Feature B) → صدای واقعی + صفحه‌ی تمام‌عرض با «توقف/تعویق»، از سوی
 *                        پلاگین محلی خودِ اپ (`TaskAlarm`).
 *
 * حذف یکی نباید دیگری را بشکند و شکست یکی نباید در گزارش دیگری گم شود. تنها
 * اشتراکشان دو تابع نمایشیِ خالص (`formatReminderTime`/`formatReminderRelative`)
 * است که ریاضیات زمانِ جلالی در آن‌ها دوباره اختراع نشود.
 *
 * ── منبع حقیقت ──────────────────────────────────────────────────────
 * این ماژول فقط «آینه‌ی UI» است. حقیقتِ زمان‌بندی در SharedPreferences خودِ
 * اندروید است (`TaskAlarmStore.java`)، تا آلارم بدون WebView، بدون اینترنت و
 * بدون نشستِ ورود هم کار کند. به همین دلیل هم `getPending` نیتیو مرجع
 * آشتی‌دادن است و روی آن سوار می‌شود.
 */

export type TaskAlarm = {
    taskId: number
    /** عنوان در لحظه‌ی ثبت؛ آلارم باید حتی اگر لیست تسک‌ها عوض شود خوانا بماند */
    title: string
    /** لحظه‌ی زنگ (epoch ms) */
    at: number
    createdAt: number
}

/** کلید localStorage — user-scoped، مثل یادآورها (روی دستگاه مشترک نشتی نمی‌کند). */
const ALARMS_PREFIX = "dp:task-alarms"

export function taskAlarmsStorageKey(userId: number | null): string {
    return `${ALARMS_PREFIX}:${scopeToken(userId)}`
}

/**
 * شناسه‌ی قطعی آلارم یک تسک.
 *
 * فقط به `taskId` وابسته است: تغییر زمان ⇒ همان شناسه ⇒ همان `PendingIntent`
 * و همان اعلان **جایگزین** می‌شود؛ حذف ⇒ همان شناسه لغو می‌شود؛ باز شدن دوباره‌ی
 * اپ ⇒ همان شناسه بازیابی می‌شود. فضای کلید (`task-alarm:`) از فضای کلیدِ
 * یادآورها (`task-reminder:`) جداست.
 */
export function taskAlarmId(taskId: number): number {
    return stableNotificationId(`task-alarm:${taskId}`)
}

/**
 * حداقل فاصله‌ی منطقی تا زنگ.
 *
 * چرا فقط چند ثانیه و نه یک دقیقه؟ چون ورودی استاندارد `datetime-local` دقت
 * «دقیقه» دارد: کاربر عملاً همیشه یک سرِ دقیقه را انتخاب می‌کند و آن لحظه
 * می‌تواند فقط چند ثانیه جلوتر از «الآن» باشد. با حداقلِ یک‌دقیقه‌ای، انتخابِ
 * کاملاً معتبرِ «دقیقه‌ی بعد» بی‌دلیل رد می‌شد. این مقدار فقط «گذشته» را می‌گیرد.
 */
export const TASK_ALARM_MIN_LEAD_MS = 5 * 1000

/** پیش‌فرض وقتی هنوز آلارمی نیست: ۱۰ دقیقه بعد. */
export const TASK_ALARM_DEFAULT_LEAD_MS = 10 * 60 * 1000

/** مدت تعویق پیش‌فرض روی صفحه‌ی آلارم (هم‌راستا با `TaskAlarmController`). */
export const TASK_ALARM_SNOOZE_MINUTES = 5

/** آلارم‌های گذشته تا این مدت در لیست می‌مانند (برای بازخورد «زنگ زد»). */
export const TASK_ALARM_PAST_GRACE_MS = 5 * 60 * 1000

/** سقف تعداد آلارم‌های ذخیره‌شده (محافظ در برابر رشد بی‌نهایت localStorage). */
export const TASK_ALARM_MAX_ITEMS = 100

export const TASK_ALARM_QUICK_CHOICES: { label: string; minutes: number }[] = [
    { label: "۵ دقیقه دیگر", minutes: 5 },
    { label: "۱۵ دقیقه دیگر", minutes: 15 },
    { label: "۳۰ دقیقه دیگر", minutes: 30 },
    { label: "۱ ساعت دیگر", minutes: 60 },
]

type StorageLike = {
    getItem: (key: string) => string | null
    setItem: (key: string, value: string) => void
    removeItem?: (key: string) => void
}

function isValidTaskAlarm(value: unknown): value is TaskAlarm {
    if (typeof value !== "object" || value === null) return false

    const alarm = value as Record<string, unknown>

    return (
        typeof alarm.taskId === "number" &&
        Number.isFinite(alarm.taskId) &&
        typeof alarm.title === "string" &&
        typeof alarm.at === "number" &&
        Number.isFinite(alarm.at) &&
        typeof alarm.createdAt === "number" &&
        Number.isFinite(alarm.createdAt)
    )
}

/**
 * پاک‌سازی: آلارم‌های خیلی گذشته حذف می‌شوند و سقف تعداد اعمال می‌شود.
 * ترتیب خروجی صعودی بر اساس زمان زنگ است.
 */
export function pruneTaskAlarms(
    list: TaskAlarm[],
    now: number,
    graceMs: number = TASK_ALARM_PAST_GRACE_MS,
): TaskAlarm[] {
    return list
        .filter((alarm) => now - alarm.at < graceMs)
        .sort((a, b) => a.at - b.at)
        .slice(0, TASK_ALARM_MAX_ITEMS)
}

/** خواندن امن؛ داده‌ی خراب بی‌صدا نادیده گرفته می‌شود. */
export function readTaskAlarms(
    storage: StorageLike | null,
    now: number = Date.now(),
    userId: number | null = null,
): TaskAlarm[] {
    if (!storage) return []

    try {
        const raw = storage.getItem(taskAlarmsStorageKey(userId))
        if (!raw) return []

        const parsed: unknown = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []

        return pruneTaskAlarms(parsed.filter(isValidTaskAlarm), now)
    } catch {
        return []
    }
}

/** نوشتن امن؛ در حالت خصوصی/سهمیه‌ی پر بی‌صدا رد می‌شود. */
export function writeTaskAlarms(
    storage: StorageLike | null,
    list: TaskAlarm[],
    userId: number | null = null,
): void {
    if (!storage) return

    try {
        storage.setItem(taskAlarmsStorageKey(userId), JSON.stringify(list))
    } catch {
        /* ignore */
    }
}

/** ثبت/جایگزینی آلارم یک تسک (هر تسک حداکثر یک آلارم فعال دارد). */
export function upsertTaskAlarm(
    list: TaskAlarm[],
    task: { id: number; title: string },
    at: number,
    now: number = Date.now(),
): TaskAlarm[] {
    const next: TaskAlarm = { taskId: task.id, title: task.title, at, createdAt: now }

    return pruneTaskAlarms([...list.filter((alarm) => alarm.taskId !== task.id), next], now)
}

export function removeTaskAlarm(
    list: TaskAlarm[],
    taskId: number,
    now: number = Date.now(),
): TaskAlarm[] {
    return pruneTaskAlarms(
        list.filter((alarm) => alarm.taskId !== taskId),
        now,
    )
}

export function findTaskAlarm(list: TaskAlarm[], taskId: number): TaskAlarm | undefined {
    return list.find((alarm) => alarm.taskId === taskId)
}

/** آیا زمان انتخاب‌شده برای آلارم قابل قبول است؟ */
export function validateTaskAlarmTime(
    at: number,
    now: number = Date.now(),
): { ok: true } | { ok: false; reason: "IN_THE_PAST" } {
    if (!Number.isFinite(at) || at - now < TASK_ALARM_MIN_LEAD_MS) {
        return { ok: false, reason: "IN_THE_PAST" }
    }

    return { ok: true }
}
