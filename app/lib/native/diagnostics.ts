"use client"

import type { LocalNotificationsPlugin } from "@capacitor/local-notifications"

/*
 * گزارش تشخیصی یادآورهای نیتیو (فقط شواهد — بدون هیچ رفتار درمانی)
 * -----------------------------------------------------------------
 * این ماژول **هیچ تصمیمی نمی‌گیرد**. نه زمان‌بندی می‌کند، نه لغو، نه مجوز
 * می‌خواهد. کارش فقط این است که هر تماس واقعی با پل Capacitor را با همه‌ی
 * پارامترهای مؤثر ثبت کند تا بعداً بتوان بدون حدس گفت:
 *
 *   «واقعاً چه چیزی به اندروید داده شد، کِی، با چه شناسه‌ای، و نتیجه‌اش چه شد؟»
 *
 * چرا در حافظه‌ی پایدار (`localStorage`) هم نوشته می‌شود؟
 * چون مهم‌ترین سؤال این است که «وقتی اپ کاملاً بسته/کشته شد چه اتفاقی افتاد».
 * اگر گزارش فقط در حافظه‌ی JS باشد، با مرگ پروسه پاک می‌شود و دیگر چیزی برای
 * مقایسه نمی‌ماند. با ذخیره‌ی محلی، بعد از باز کردن دوباره‌ی اپ می‌توان دید
 * آخرین زمان‌بندیِ موفق چه بوده و آیا لغوی بعدش آمده یا نه.
 *
 * قواعد:
 * - هیچ import ای از `daily-reminder`/`task-reminder`/Context/UI ندارد (نه وابستگی
 *   حلقوی، نه دستکاری رفتار). نوع یادآور از **خودِ عنوانی که به نیتیو داده
 *   می‌شود** استنتاج می‌شود و همین عنوان خام هم در گزارش می‌ماند.
 * - دسترسی به `localStorage` همیشه در `try/catch` و فقط سمت کلاینت است.
 * - نوشتن هرگز throw نمی‌کند (هم‌خانواده‌ی بقیه‌ی لایه‌ی نیتیو).
 */

/** نوع یادآور — `UNKNOWN` یعنی عنوان با هیچ‌کدام از مسیرها جور نیست. */
export type ReminderKind = "TASK" | "DAILY" | "ALARM" | "UNKNOWN"

/** چه چیزی ثبت شده — رویدادها عمداً ریز هستند تا ترتیب وقایع قابل بازسازی باشد. */
export type NativeDiagnosticEvent =
    | "SCHEDULE_REQUESTED"
    | "SCHEDULE_RESOLVED"
    | "SCHEDULE_FAILED"
    | "SCHEDULE_UNRESOLVED"
    | "PENDING_SNAPSHOT"
    | "QUEUE_RELEASED"
    | "CANCEL_REQUESTED"
    | "CANCEL_DONE"
    | "CANCEL_FAILED"
    | "DELIVERY_SNAPSHOT"
    | "NATIVE_SCHEDULE_START"
    | "NATIVE_SCHEDULE_RESOLVED"
    | "NATIVE_SCHEDULE_REJECTED"
    | "CHANNEL_RESULT"
    | "UNRESOLVED_GUARDED"
    | "CANCEL_ATTEMPT_FOR_UNRESOLVED"
    | "CANCEL_FAILED_FOR_UNRESOLVED"
    /*
     * سه رویدادِ حاشیه‌ای که برای تشخیص «کدام مرحله در اجرای دوم متوقف شد»
     * کم بودند: شروع تلاش، نتیجه‌ی مجوز، و نتیجه‌ی capability آلارم دقیق.
     * هر سه فقط شواهدند و هیچ تصمیمی نمی‌گیرند.
     */
    | "SCHEDULE_START"
    | "PERMISSION_RESULT"
    | "EXACT_CAPABILITY"

/** یک اعلان در snapshot — دقیقاً همان چیزی که سیستم‌عامل برگردانده. */
export type NativeDiagnosticPendingItem = {
    id: number
    title: string
    atIso: string | null
}

/**
 * یک اعلانِ visible در shade/notification-list از `getDeliveredNotifications()`.
 * حاوی همان چیزی که پلاگین delivered-return می‌کند (خونه newline with android
 * StatusBarNotification-derived record).
 */
export type NativeDiagnosticDeliveredItem = {
    id: number
    /** Android tag; ممکن است null یا خالی باشد (در resp. cases). */
    tag?: string
    title?: string
    body?: string
    /** nullable — در موارد where notification body not available. */
    bodyNull?: boolean
    /** extra keys count برای نشان دادن که داده extra alongside id/title/body موجود است یا نه. */
    extraKeysCount?: number
}

export type NativeDiagnosticEntry = {
    /** شماره‌ی ترتیبی یکنوا — برای مرتب‌کردن بعد از خواندن از storage */
    seq: number
    /** `Date.now()` در لحظه‌ی ثبت */
    at: number
    /** همان `at` به شکل ISO (خوانا در گزارش) */
    iso: string
    event: NativeDiagnosticEvent
    kind: ReminderKind
    /** شماره‌ی نوبت این تلاش در طول عمر پروسه — برای تفکیک اجرای اول/دوم/سوم. */
    attemptNo?: number
    id?: number
    title?: string
    /** `schedule.at.getTime()` — لحظه‌ای که به اندروید داده شد */
    requestedAt?: number
    requestedAtIso?: string
    /** `requestedAt - at` ⇒ «چند میلی‌ثانیه بعد» (منفی یعنی در گذشته) */
    delayMs?: number
    isExact?: boolean
    allowWhileIdle?: boolean
    channelId?: string
    warning?: { code: string; message: string }
    message?: string
    /** فهرست pending همان لحظه (فقط در `PENDING_SNAPSHOT`) */
    pending?: NativeDiagnosticPendingItem[]
    /** آیا شناسه‌ی هدف در snapshot بود؟ */
    focusFound?: boolean
/**
 * فهرست delivered notifications_same moment (فقط در `DELIVERY_SNAPSHOT`).
 * اینجا از `getDeliveredNotifications()` می‌آید و فقط برای تشخیص آیا
 * اعلانی در shade/notification-list visible بوده یا نه.
 */
    delivered?: NativeDiagnosticDeliveredItem[]
    /** آیا شناسه‌ی هدف در delivered snapshot بود؟ */
    deliveryFocusFound?: boolean
    /**
     * چند فریم اول پشته‌ی تماس — فقط برای رویدادهای لغو.
     * این تنها راه دیدنِ این است که «چه کسی لغو کرد»، بدون اینکه در
     * Context/هوک دست ببریم. در build فشرده نام‌ها کوتاه می‌شوند ولی ترتیب
     * فایل‌ها همان مسیر واقعی فراخوانی را نشان می‌دهد.
     */
    stack?: string
}

/** تعداد فریم‌هایی که از پشته نگه می‌داریم (پشته‌ی کامل فقط نویز است). */
export const NATIVE_DIAGNOSTIC_STACK_FRAMES = 4

/** رویدادهای ثبت‌شده بدون فیلدهای مشتق — ورودی `recordNativeDiagnostic`. */
export interface NativeDiagnosticInput extends Omit<NativeDiagnosticEntry, "seq" | "at" | "iso"> {}

/** سقف نگه‌داری — یک ring buffer کوچک تا هرگز حافظه/storage راپر نکند. */
export const MAX_NATIVE_DIAGNOSTIC_ENTRIES = 100

/** کلید ذخیره‌ی محلی — جدا از کلیدهای یادآور، فقط شواهد. */
export const NATIVE_DIAGNOSTICS_STORAGE_KEY = "dp:native-diagnostics"

/** پیشوند عنوان یادآور تسک — از `scheduleTaskReminder` می‌آید. */
const TASK_TITLE_PREFIX = "🔔"

/** عنوان ثابت یادآور روزانه — از `scheduleDailyReminder` می‌آید. */
const DAILY_TITLE = "یادآور روزساز"

let entries: NativeDiagnosticEntry[] = []
let seqCounter = 0
let loaded = false
const listeners = new Set<(entries: NativeDiagnosticEntry[]) => void>()

/**
 * استنتاج نوع یادآور از عنوانی که به نیتیو داده می‌شود.
 *
 * چرا از شناسه استنتاج نمی‌کنیم؟ چون شناسه یک hash است و معکوس‌کردنش یعنی
 * وابستگی به هر دو wrapper. عنوان اما در همان لحظه ساخته شده و قطعی است:
 * یادآور تسک همیشه با `🔔 ` و یادآور روزانه همیشه با عنوان ثابت می‌آید.
 */
export function classifyReminderKind(title: string | undefined): ReminderKind {
    if (typeof title !== "string") return "UNKNOWN"
    if (title.startsWith(TASK_TITLE_PREFIX)) return "TASK"
    if (title === DAILY_TITLE) return "DAILY"
    return "UNKNOWN"
}

/** دسترسی امن به storage (حالت خصوصی مرورگر/SSR می‌تواند throw کند). */
function getStorage(): Storage | null {
    try {
        if (typeof window === "undefined") return null
        return window.localStorage
    } catch {
        return null
    }
}

/** یک‌بار خواندن از storage — فقط سمت کلاینت و فقط برای شواهد قبلی. */
function ensureLoaded(): void {
    if (loaded) return
    loaded = true

    const storage = getStorage()
    if (!storage) return

    try {
        const raw = storage.getItem(NATIVE_DIAGNOSTICS_STORAGE_KEY)
        if (!raw) return

        const parsed: unknown = JSON.parse(raw)
        if (!Array.isArray(parsed)) return

        const restored = parsed.filter(isDiagnosticEntry).slice(-MAX_NATIVE_DIAGNOSTIC_ENTRIES)
        entries = restored
        seqCounter = restored.reduce((max, entry) => Math.max(max, entry.seq), 0)
    } catch {
        /* گزارش خراب هرگز نباید اپ را بشکند — فقط نادیده گرفته می‌شود. */
    }
}

/** شکل حداقلیِ یک رکورد معتبر در storage. */
function isDiagnosticEntry(value: unknown): value is NativeDiagnosticEntry {
    if (!value || typeof value !== "object") return false
    const candidate = value as Partial<NativeDiagnosticEntry>
    return typeof candidate.seq === "number" && typeof candidate.at === "number" && typeof candidate.event === "string"
}

function persist(): void {
    const storage = getStorage()
    if (!storage) return

    try {
        storage.setItem(NATIVE_DIAGNOSTICS_STORAGE_KEY, JSON.stringify(entries))
    } catch {
        /* سهمیه پر شده — گزارش در حافظه می‌ماند، چیزی خراب نمی‌شود. */
    }
}

/** یک فراخوانی محافظت‌شده — یک مشترک خراب نباید بقیه (و خودِ ثبت) را بشکند. */
function safeNotify(listener: (entries: NativeDiagnosticEntry[]) => void, snapshot: NativeDiagnosticEntry[]): void {
    try {
        listener(snapshot)
    } catch {
        /* گزارش تشخیصی هرگز نباید به‌خاطر یک مصرف‌کننده‌ی خراب بشکند. */
    }
}

function notify(): void {
    const snapshot = [...entries]
    for (const listener of listeners) {
        safeNotify(listener, snapshot)
    }
}

/**
 * ثبت یک رویداد. هرگز throw نمی‌کند.
 * @returns همان رکورد ثبت‌شده (یا `null` اگر ثبت نشد).
 */
export function recordNativeDiagnostic(input: NativeDiagnosticInput): NativeDiagnosticEntry | null {
    try {
        ensureLoaded()

        seqCounter += 1
        const at = Date.now()
        const entry: NativeDiagnosticEntry = {
            ...input,
            seq: seqCounter,
            at,
            iso: new Date(at).toISOString(),
        }

        entries = [...entries, entry].slice(-MAX_NATIVE_DIAGNOSTIC_ENTRIES)
        persist()
        notify()

        return entry
    } catch {
        return null
    }
}

/** ترجمه‌ی خرابی غیرمنتظره به یک پیام کوتاه برای گزارش تشخیصی. */
export function describeDiagnosticError(err: unknown): string {
    if (err instanceof Error) return `${err.name}: ${err.message}`
    if (err && typeof err === "object" && "message" in err) {
        return String((err as { message: unknown }).message)
    }
    return String(err)
}

/** کل گزارش به ترتیب قدیمی→جدید (نسخه‌ی کپی، تا بیرون دستکاری نشود). */
export function getNativeDiagnostics(): NativeDiagnosticEntry[] {
    ensureLoaded()
    return [...entries]
}

/** اشتراک روی گزارش — خروجی، تابع لغو اشتراک است. */
export function subscribeNativeDiagnostics(
    listener: (entries: NativeDiagnosticEntry[]) => void,
): () => void {
    ensureLoaded()
    listeners.add(listener)

    // وضعیت فعلی بلافاصله داده می‌شود — ولی با همان محافظتِ fan-out، تا
    // یک مصرف‌کننده‌ی خراب کل مسیر اشتراک را در همان لحظه نشکند.
    safeNotify(listener, [...entries])

    return () => {
        listeners.delete(listener)
    }
}

/** پاک‌کردن گزارش (دستی، از UI تشخیص). */
export function clearNativeDiagnostics(): void {
    entries = []
    persist()
    notify()
}

/**
 * ثبت یک رویداد `DELIVERY_SNAPSHOT` `read-only`.
 *
 * این تابع هیچ schedule/cancel/reschedule/permission/exact/queue تغییری نمی‌کند.
 * فقط یک لحظه‌ی خوانی از وضعیت سیستم‌عامل با استفاده از `getPending()` و
 * `getDeliveredNotifications()` است، و نتیجه را در گزارش تشخیصی ثابت می‌کند.
 *
 * از آنجا که `getDeliveredNotifications()` روی مرورگر در/plugin-level returns empty
 * یا 가능한 thrown/catched، همه چیز محافظت‌شده در `try/catch` است و هرگز throw نمی‌کند.
 */
export async function recordDeliverySnapshot(
    plugin: LocalNotificationsPlugin,
    focusId: number,
    kind: ReminderKind,
    title: string,
): Promise<void> {
    try {
        const [pendingResult, deliveredResult] = await Promise.all([
            plugin.getPending(),
            plugin.getDeliveredNotifications(),
        ])

        const pendingItems: NativeDiagnosticPendingItem[] = pendingResult.notifications.map(
            (n) => ({
                id: n.id,
                title: n.title,
                atIso: n.schedule?.at
                    ? new Date(n.schedule.at).toISOString()
                    : null,
            }),
        )

        const deliveredItems: NativeDiagnosticDeliveredItem[] = deliveredResult.notifications.map(
            (n) => {
                const extraKeysCount =
                    (typeof n.extra === "object" && n.extra != null && !Array.isArray(n.extra)
                        ? Object.keys(n.extra).length
                        : 0) ?? 0

                return {
                    id: n.id,
                    tag: n.tag ?? undefined,
                    title: n.title ?? undefined,
                    body: n.body ?? undefined,
                    bodyNull: n.body == null ? true : undefined,
                    extraKeysCount,
                }
            },
        )

        const focusFoundPending = pendingItems.some((item) => item.id === focusId)
        const deliveryFocusFound = deliveredItems.some((item) => item.id === focusId)

        recordNativeDiagnostic({
            event: "DELIVERY_SNAPSHOT",
            kind,
            id: focusId,
            title,
            pending: pendingItems,
            focusFound: focusFoundPending,
            delivered: deliveredItems,
            deliveryFocusFound,
        })
    } catch (err) {
        recordNativeDiagnostic({
            event: "DELIVERY_SNAPSHOT",
            kind,
            id: focusId,
            title,
            message: describeDiagnosticError(err),
        })
    }
}

/**
 * وضعیت permission قطعی exact-alarm که plugin سطح کلاینت برمی‌گرداند.
 * عمداً فقط خواندن است: هیچ درخواست مجوز، هیچ تغییر manifest، هیچ schedule
 * یا cancel جدیدی انجام نمی‌دهد.
 */
export type ExactAlarmSetting = "granted" | "denied" | "unknown"

/**
 * اطلاعات read-only وضعیت exact alarm.
 * هیچ کدام از مقادیر این آبجکت هیچ تصمیم رفتاری نمی‌گیرند.
 */
export type ExactAlarmDiagnostic = {
    /** آیا همین حالا در محیط نیتیو هستیم که معنی‌دار باشد */
    native: boolean
    /** آیا API پلاگین واقعاً پاسخ داد (یعنی وضعیت زیر «خوانده‌شده» است، نه حدس) */
    canReadExactSetting: boolean
    /** وضعیت مجوز آلارم دقیق — همیشه یکی از سه مقدار ثابت */
    exactAlarmSetting: ExactAlarmSetting
    /**
     * آیا فقط به اعلامِ manifest تکیه کرده‌ایم (بدون خواندن واقعی وضعیت).
     * در این استک `SCHEDULE_EXACT_ALARM` از manifest خودِ پلاگین می‌آید، پس
     * «اعلام‌شده بودن» هیچ ربطی به «داده‌شده بودن» ندارد.
     */
    manifestDeclarativeOnly: boolean
}

/**
 * خواندن وضعیت exact alarm با استفاده از API رسمی پلاگین.
 * این تابع هیچ اثری روی رفتار زمان‌بندی ندارد، هیچ مجوزی نمی‌خواهد و
 * هیچ تغییر پایداری در state سیستم‌عامل ایجاد نمی‌کند.
 *
 * روی مرورگر (غیر نیتیو) هرگز درخواست خارجی نمی‌کند.
 *
 * نکته‌ی کلیدی: این تابع *فقط می‌خواند*. مسیر «درخواست مجوز»
 * (`changeExactNotificationSetting` که صفحه‌ی تنظیمات را باز می‌کند) عمداً
 * اینجا صدا زده نمی‌شود.
 */
export async function readExactAlarmDiagnostic(
    readExactSetting: (() => Promise<{ exact_alarm: string }>) | null,
): Promise<ExactAlarmDiagnostic> {
    if (typeof window === "undefined") {
        return {
            native: false,
            canReadExactSetting: false,
            exactAlarmSetting: "unknown",
            manifestDeclarativeOnly: false,
        }
    }    /*
     * `window.Capacitor` عمداً با cast خوانده می‌شود: این ماژول هیچ import ای از
     * `@capacitor/core` ندارد (تا pure بماند)، پس augmentation گلوبالش هم اینجا
     * بارگذاری نشده است. همان الگوی `isNativeLocalNotificationPlatform`.
     */
    const capacitor = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
        .Capacitor

    if (!capacitor?.isNativePlatform?.()) {
        return {
            native: false,
            canReadExactSetting: false,
            exactAlarmSetting: "unknown",
            manifestDeclarativeOnly: false,
        }
    }

    if (typeof readExactSetting !== "function") {
        return {
            native: true,
            canReadExactSetting: false,
            exactAlarmSetting: "unknown",
            manifestDeclarativeOnly: true,
        }
    }

    try {
        const out = await readExactSetting()
        const status =
            out?.exact_alarm === "granted"
                ? "granted"
                : out?.exact_alarm === "denied"
                    ? "denied"
                    : "unknown"

        return {
            native: true,
            canReadExactSetting: true,
            exactAlarmSetting: status,
            manifestDeclarativeOnly: false,
        }
    } catch {
        return {
            native: true,
            canReadExactSetting: false,
            exactAlarmSetting: "unknown",
            manifestDeclarativeOnly: true,
        }
    }
}

/** خلاصه‌ی یک خطی برای console — همان چیزی که کنار هر رویداد چاپ می‌شود. */
export function formatNativeDiagnostic(entry: NativeDiagnosticEntry): string {
    const parts: string[] = [`[native-diag] ${entry.event}`, `kind=${entry.kind}`]

    if (entry.attemptNo !== undefined) parts.push(`attempt=${entry.attemptNo}`)
    if (entry.id !== undefined) parts.push(`id=${entry.id}`)
    if (entry.title) parts.push(`title=${entry.title}`)
    if (entry.requestedAtIso) parts.push(`at=${entry.requestedAtIso}`)
    if (entry.delayMs !== undefined) parts.push(`in=${Math.round(entry.delayMs / 1000)}s`)
    if (entry.isExact !== undefined) parts.push(`exact=${entry.isExact}`)
    if (entry.allowWhileIdle !== undefined) parts.push(`whileIdle=${entry.allowWhileIdle}`)
    if (entry.warning) parts.push(`warning=${entry.warning.code}`)
    if (entry.focusFound !== undefined) parts.push(`focusInPending=${entry.focusFound}`)
    if (entry.pending) parts.push(`pending=${entry.pending.length}`)
    if (entry.delivered) parts.push(`delivered=${entry.delivered.length}`)
    if (entry.deliveryFocusFound !== undefined) parts.push(`deliveryFocusFound=${entry.deliveryFocusFound}`)
    if (entry.message) parts.push(`message=${entry.message}`)

    return parts.join(" · ")
}

/**
 * پشته‌ی تماس فشرده برای شواهد لغو.
 * عمداً فقط چند فریم: هدف این است که بشود دید *از کدام مسیر* آمده، نه
 * بازسازی کامل call stack.
 */
export function captureDiagnosticStack(): string {
    const stack = new Error("native-diagnostics").stack
    if (!stack) return ""

    return stack
        .split("\\n")
        .slice(1, NATIVE_DIAGNOSTIC_STACK_FRAMES + 1)
        .map((line) => line.trim())
        .join(" | ")
}
