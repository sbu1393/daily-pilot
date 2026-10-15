"use client"

import type {
    Channel,
    LocalNotificationSchema,
    LocalNotificationsPlugin,
    PermissionStatus,
    ScheduleWarning,
} from "@capacitor/local-notifications"

import {
    captureDiagnosticStack,
    classifyReminderKind,
    formatNativeDiagnostic,
    readExactAlarmDiagnostic,
    recordNativeDiagnostic,
    type ExactAlarmDiagnostic,
    type NativeDiagnosticInput,
} from "@/app/lib/native/diagnostics"

/*
 * یادآور محلی نیتیو — لایه‌ی کلاینت (Capacitor Local Notifications)
 * -----------------------------------------------------------------
 * مسئولیت: تشخیص محیط نیتیو، مجوز اعلان، زمان‌بندی و لغو اعلان‌های کاملاً محلی.
 *
 * قواعد:
 * - هیچ وابستگی به دیتابیس/API/Prisma/Auth/Push ندارد؛ این ماژول فقط پوسته‌ی
 *   نیتیو را می‌پیچد تا صفحه‌ها مستقیم با پلاگین Capacitor کار نکنند.
 * - همه‌ی توابع «شکست‌ناپذیر» هستند: هرگز throw نمی‌کنند و خروجی ساختاریافته با
 *   `reason` برمی‌گردانند (هم‌خانواده‌ی `app/lib/pushSubscription.ts`).
 * - ⚠️ خودِ آبجکت پلاگین هرگز مستقیماً از یک تابع `async` برگردانده نمی‌شود.
 *   پروکسی Capacitor برای هر پراپرتی ناشناخته — از جمله `then` — یک تابع
 *   برمی‌گرداند؛ پس اگر خروجی یک تابع async خودِ پلاگین باشد، موتور JS آن را
 *   thenable می‌بیند و `LocalNotifications.then(resolve, reject)` را صدا می‌زند.
 *   نتیجه: پیام `"LocalNotifications.then()" is not implemented on web` به‌صورت
 *   unhandledrejection، معلق‌ماندن همیشگی آن promise و نرسیدن هیچ خطایی به catch.
 *   برای همین هر جا پلاگین از مرز یک promise می‌گذرد، داخل یک آبجکت ساده
 *   بسته‌بندی می‌شود (آبجکت ساده thenable نیست).
 */

/** شناسه‌ی کانال اندروید؛ اعلان‌های یادآور با اهمیت بالا در همین کانال می‌آیند. */
export const LOCAL_REMINDER_CHANNEL_ID = "roozsaz_reminders"

/** کانال پیش‌فرض یادآور (Android 8+ برای نمایش اعلان به کانال نیاز دارد). */
const REMINDER_CHANNEL: Channel = {
    id: LOCAL_REMINDER_CHANNEL_ID,
    name: "یادآور روزساز",
    description: "یادآور کارهای روز — کاملاً محلی و بدون نیاز به اینترنت",
    importance: 5,
    visibility: 1,
    vibration: true,
    lights: true,
    lightColor: "#3b5bdb",
}

/** دلیل شکست — برای تصمیم‌گیری UI، بدون وابستگی به متن خطای نیتیو. */
export type LocalNotificationFailureReason =
    | "NOT_NATIVE" // اجرا داخل پوسته‌ی نیتیو (Capacitor) نیست
    | "PLUGIN_UNAVAILABLE" // پلاگین نیتیو پیدا نشد یا import شکست خورد
    | "PERMISSION_FAILED" // خواندن/درخواست مجوز با خطا برگشت
    | "PERMISSION_PROMPT" // مجوز هنوز گرفته نشده
    | "PERMISSION_DENIED" // کاربر مجوز را رد کرده
    | "SCHEDULE_FAILED"
    | "CANCEL_FAILED"

export type LocalNotificationFailure = {
    ok: false
    reason: LocalNotificationFailureReason
    /** پیام قابل نمایش: متن خطای اصلی یا توضیح کوتاه */
    message: string
}

export type LocalNotificationPermissionOutcome =
    | { ok: true; display: PermissionStatus["display"] }
    | LocalNotificationFailure

export type ScheduleLocalReminderOutcome =
    | { ok: true; id: number; warning?: ScheduleWarning }
    | LocalNotificationFailure

export type CancelLocalReminderOutcome = { ok: true } | LocalNotificationFailure

/** آیا همین حالا داخل پوسته‌ی نیتیو (APK) هستیم؟ */
export function isNativeLocalNotificationPlatform(): boolean {
    if (typeof window === "undefined") return false

    const capacitor = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } })
        .Capacitor

    return typeof capacitor?.isNativePlatform === "function" && capacitor.isNativePlatform()
}

/*
 * ── تشخیص (فقط شواهد، بدون تغییر رفتار) ──────────────────────────────
 * این بخش هیچ تصمیمی نمی‌گیرد و هیچ مقداری را عوض نمی‌کند؛ فقط هر تماس با
 * پل Capacitor را با پارامترهای مؤثرش ثبت می‌کند. دلیل وجودش روشن است: وقتی
 * اعلان با اپ بسته نمی‌رسد، باید بتوان بدون حدس گفت «آیا واقعاً زمان‌بندی شد،
 * برای چه لحظه‌ای، با چه شناسه‌ای، و بعدش لغو شد یا نه؟
 */

/**
 * اگر پل Capacitor بیشتر از این مدت پاسخ ندهد، یک رویداد `SCHEDULE_UNRESOLVED`
 * ثبت می‌شود.
 *
 * ⚠️ این مهلت **فقط ثبت می‌کند، هیچ چیزی را آزاد نمی‌کند**:
 * `plugin.schedule()` هنوز معلق است و promise همین تابع هم تا ابد معلق می‌ماند.
 * این عمدی است — «آزادکردن» با یک resolve/reject جعلی همان چیزی است که باعث
 * می‌شود گمان کنیم عملیات تمام شده. وضعیت واقعی در گزارش ثبت می‌شود تا روی
 * دستگاه قطعی شود که پل جواب نداده.
 *
 * صف سریالی که یک عملیات معلق می‌تواند قفلش کند در `primitives.ts` است
 * (`enqueueNative` + `releaseQueueAfterStall`) و همان‌جا با تست اندازه‌گیری
 * شده. این تابع خودش هیچ صف/mutex ندارد و هیچ schedule/cancel جایگزینی انجام
 * نمی‌دهد.
 */
export const SCHEDULE_UNRESOLVED_WARN_MS = 4_000

/** ثبت + چاپ یک رویداد تشخیصی؛ هرگز throw نمی‌کند و روی نتیجه اثری ندارد. */
function logNativeDiagnostic(input: NativeDiagnosticInput): void {
    const entry = recordNativeDiagnostic(input)
    if (entry) console.info(formatNativeDiagnostic(entry))
}

/** گلوگاهِ ثابت شروعᬓ هرาจะ schedule-local در همین page-ی diagnostic. */
export const SCHEDULE_ATTEMPT_PREFIX = "immortal-scheduled"

/** شماره‌ی 순서를 یک 시도는 해چ‌باید. */
let _scheduleAttemptSeq = 0

/**
 * خواندن pending بلافسره بعد از یک زمان‌بندی موفق.
 *
 * عمداً `await` نمی‌شود (شلیک و فراموش): اگر روی مسیر پاسخ‌دادن به
 * فراخوانی‌کننده منتظر می‌ماند، هم زمان‌بندی کندتر می‌شد و هم ترتیب صف سریال
 * تغییر می‌کرد. اینجا فقط می‌خواهیم ببینیم آیا همان شناسه در صف سیستم‌عامل
 * هست یا نه.
 */
async function snapshotPendingAfterSchedule(
    plugin: LocalNotificationsPlugin,
    focusId: number,
    kind: NativeDiagnosticInput["kind"],
    title: string,
): Promise<void> {
    try {
        const pending = await plugin.getPending()
        const items = pending.notifications.map((notification) => ({
            id: notification.id,
            title: notification.title,
            atIso: notification.schedule?.at
                ? new Date(notification.schedule.at).toISOString()
                : null,
        }))

        logNativeDiagnostic({
            event: "PENDING_SNAPSHOT",
            kind,
            id: focusId,
            title,
            focusFound: items.some((item) => item.id === focusId),
            pending: items,
        })
    } catch (err) {
        logNativeDiagnostic({
            event: "PENDING_SNAPSHOT",
            kind,
            id: focusId,
            title,
            message: describeError(err),
        })
    }
}

/**
 * لود تنبل پلاگین. نتیجه داخل یک آبجکت ساده بسته‌بندی می‌شود تا thenable نشود
 * (توضیح کامل در ابتدای فایل).
 */
async function loadLocalNotifications(): Promise<{ LocalNotifications: LocalNotificationsPlugin }> {
    const mod = await import("@capacitor/local-notifications")
    return { LocalNotifications: mod.LocalNotifications }
}

type PluginResolution =
    | { ok: true; plugin: LocalNotificationsPlugin }
    | LocalNotificationFailure

/** پلاگین را برای استفاده برمی‌گرداند، یا دلیل «چرا ممکن نیست» را می‌دهد. */
async function resolvePlugin(): Promise<PluginResolution> {
    if (!isNativeLocalNotificationPlatform()) {
        return {
            ok: false,
            reason: "NOT_NATIVE",
            message: "این صفحه داخل اپ نیتیو اجرا نشده است؛ اعلان محلی فقط در APK کار می‌کند.",
        }
    }

    try {
        const { LocalNotifications } = await loadLocalNotifications()
        return { ok: true, plugin: LocalNotifications }
    } catch (err) {
        return { ok: false, reason: "PLUGIN_UNAVAILABLE", message: describeError(err) }
    }
}

/**
 * مجوز نمایش اعلان را تضمین می‌کند: اگر داده شده باشد همان را برمی‌گرداند،
 * وگرنه یک بار از کاربر می‌پرسد. هرگز throw نمی‌کند.
 */
export async function requestLocalNotificationPermission(): Promise<LocalNotificationPermissionOutcome> {
    const resolved = await resolvePlugin()
    if (!resolved.ok) return resolved

    return ensurePermission(resolved.plugin)
}

/** پیاده‌سازی مشترک مجوز — تا `schedule` یک رفت‌وبرگشت اضافه‌ی نیتیو نداشته باشد. */
async function ensurePermission(
    plugin: LocalNotificationsPlugin,
): Promise<LocalNotificationPermissionOutcome> {
    try {
        const current = await plugin.checkPermissions()
        if (current.display === "granted") return { ok: true, display: current.display }

        const requested = await plugin.requestPermissions()
        if (requested.display === "granted") return { ok: true, display: requested.display }

        return {
            ok: false,
            reason: requested.display === "denied" ? "PERMISSION_DENIED" : "PERMISSION_PROMPT",
            message: `مجوز نمایش اعلان داده نشد (وضعیت: ${requested.display}).`,
        }
    } catch (err) {
        return { ok: false, reason: "PERMISSION_FAILED", message: describeError(err) }
    }
}

/*
 * ── دروازه‌ی آلارم دقیق ──────────────────────────────────────────────
 *
 * ⚠️ مهم‌ترین یافته‌ی این مرحله:
 *
 * پلاگین Capacitor وقتی `isExactNotification: true` می‌بیند و اپ **مجوز
 * «آلارم و یادآور» (SCHEDULE_EXACT_ALARM)** را ندارد، زمان‌بندی نمی‌کند؛
 * به‌جایش صفحه‌ی تنظیمات اندروید را باز می‌کند و `call` را **resolve
 * نمی‌کند** (شاهد در سورس پلاگین نصب‌شده:
 * `node_modules/@capacitor/local-notifications/.../LocalNotificationsPlugin.kt`
 * → `doSchedule()` شاخه‌ی `ACTION_REQUEST_SCHEDULE_EXACT_ALARM`، و
 * `performScheduleNow()` که فقط بعد از برگشت از آن صفحه اجرا می‌شود).
 *
 * نتیجه‌ی واقعی روی دستگاه (Android 12+، و با `targetSdkVersion 36` مجوز
 * مذکور روی Android 14+ به‌طور پیش‌فرض **داده نشده** است):
 *   ۱. هیچ آلارمی در AlarmManager ثبت نمی‌شود ⇒ با خاموش‌شدن صفحه/بسته‌شدن
 *      اپ هیچ اعلانی نمی‌آید (چون هیچ‌وقت ثبت نشده بود).
 *   ۲. Promise ای که صف سریال نیتیو روی آن منتظر است هرگز settle نمی‌شود ⇒
 *      قفل‌شدن *همه‌ی* زمان‌بندی/لغوهای بعدی (هم تسک و هم روزانه).
 *
 * پس قاعده این است: **هیچ‌وقت** بدون خواندن capability، `isExactNotification`
 * را `true` نفرست؛ چون آن شاخه‌ی مسدودکننده فقط با همین پرچم فعال می‌شود.
 * اگر واقعاً مجوز داده شده باشد، همان آلارم دقیق (و در حالت Doze نیز بیدارکننده)
 * استفاده می‌شود؛ وگرنه `allowWhileIdle: true` با `setAndAllowWhileIdle`
 * (RTC_WAKEUP) ثبت می‌شود — غیردقیق، ولی **ثبت‌شده** و مستقل از باز بودن اپ،
 * اینترنت و صفحه‌ی روشن.
 *
 * این خواندن فقط read-only است: هیچ مجوزی نمی‌خواهد و هیچ صفحه‌ای باز نمی‌کند.
 */
async function canScheduleExactAlarms(plugin: LocalNotificationsPlugin): Promise<boolean> {
    try {
        const setting = await plugin.checkExactNotificationSetting()
        return setting.exact_alarm === "granted"
    } catch {
        /* اگر خواندن ممکن نبود، فرض می‌کنیم مجوز نداریم (مسیر امن و غیرمسدودکننده). */
        return false
    }
}

export type ScheduleLocalReminderInput = {
    title: string
    body: string
    /** تأخیر نسبت به همین حالا (میلی‌ثانیه). اگر `at` بدهی نادیده گرفته می‌شود. */
    delayMs?: number
    /** لحظه‌ی دقیق اعلان. */
    at?: Date
    /** شناسه‌ی ثابت (اختیاری)؛ پیش‌فرض یک شناسه‌ی تصادفی ۳۲ بیتی است. */
    id?: number
    /**
     * «آیا آلارم دقیق خواسته می‌شود؟» — پیش‌فرض `true`.
     *
     * `true` یعنی *درخواست*، نه تضمین: اگر `canScheduleExactAlarms()` مجوز را
     * نداشته باشد، همین‌جا به `false` تبدیل می‌شود تا اعلان با آلارم غیردقیق
     * (`allowWhileIdle`) ثبت شود. دلیلش در بلوک بالای `canScheduleExactAlarms`
     * نوشته شده: با پرچم `true` و مجوزِ نداشته، پلاگین وقت‌بندی نمی‌کند، صفحه‌ی
     * تنظیمات را باز می‌کند و promise را معلق می‌گذارد.
     */
    exact?: boolean
}

/**
 * یک اعلان محلی زمان‌بندی می‌کند و شناسه‌ی آن را برمی‌گرداند تا بعداً قابل لغو باشد.
 * مجوز را خودش تضمین می‌کند؛ اگر کاربر مجوز ندهد، خروجی `ok: false` است.
 */
export async function scheduleLocalReminder(
    input: ScheduleLocalReminderInput,
): Promise<ScheduleLocalReminderOutcome> {
    const resolved = await resolvePlugin()
    if (!resolved.ok) return resolved

    const { plugin } = resolved

    /*
     * شناسه/زمان/نوع قبل از هر تماس با پل قطعی می‌شوند تا همه‌ی رویدادهای
     * تشخیصی همین try (از جمله مرحله‌ی مجوز) بتوانند id و attempt را حمل کنند.
     * این صرفاً جابه‌جایی محاسبه است — نه تغییر رفتار.
     */
    const id = input.id ?? randomNotificationId()
    const at = input.at ?? new Date(Date.now() + (input.delayMs ?? 0))
    const kind = classifyReminderKind(input.title)
    const exactRequested = input.exact ?? true

    ++_scheduleAttemptSeq
    const attemptNo = _scheduleAttemptSeq

    logNativeDiagnostic({
        event: "SCHEDULE_START",
        kind,
        id,
        title: input.title,
        attemptNo,
        requestedAt: at.getTime(),
        requestedAtIso: at.toISOString(),
        delayMs: at.getTime() - Date.now(),
        isExact: exactRequested,
        allowWhileIdle: true,
        channelId: LOCAL_REMINDER_CHANNEL_ID,
    })

    const permission = await ensurePermission(plugin)

    logNativeDiagnostic({
        event: "PERMISSION_RESULT",
        kind,
        id,
        title: input.title,
        attemptNo,
        isExact: exactRequested,
        allowWhileIdle: true,
        channelId: LOCAL_REMINDER_CHANNEL_ID,
        message: permission.ok
            ? `مجوز اعلان تأیید شد: ${permission.display}`
            : `خواندن/درخواست مجوز ناموفق بود (${permission.reason}): ${permission.message}`,
    })

    if (!permission.ok) return permission

    /*
     * دروازه‌ی capability پیش از ساختن اعلان.
     *
     * این تنها جایی است که مقدار `isExactNotification` تعیین می‌شود و هیچ‌وقت
     * `true` نمی‌ماند مگر اندروید خودش تأیید کند. اگر این خواندن را حذف کنی،
     * مسیر `doSchedule() → ACTION_REQUEST_SCHEDULE_EXACT_ALARM` برمی‌گردد و
     * همان قفل صف و «هیچ اعلانی نمی‌آید» تکرار می‌شود.
     */
    const exactGranted = exactRequested ? await canScheduleExactAlarms(plugin) : false
    const useExactAlarm = exactRequested && exactGranted

    logNativeDiagnostic({
        event: "EXACT_CAPABILITY",
        kind,
        id,
        title: input.title,
        attemptNo,
        requestedAt: at.getTime(),
        requestedAtIso: at.toISOString(),
        isExact: useExactAlarm,
        allowWhileIdle: true,
        channelId: LOCAL_REMINDER_CHANNEL_ID,
        message: exactRequested
            ? exactGranted
                ? "canScheduleExactAlarms: granted ⇒ آلارم دقیق"
                : "canScheduleExactAlarms: denied ⇒ آلارم غیردقیق (allowWhileIdle)"
            : "exact صریحاً خاموش است؛ وضعیت خوانده نشد.",
    })

    const notification: LocalNotificationSchema = {
        id,
        title: input.title,
        body: input.body,
        channelId: LOCAL_REMINDER_CHANNEL_ID,
        isExactNotification: useExactAlarm,
        schedule: { at, allowWhileIdle: true },
    }

    const requestedAtMs = Date.now()

    /* همه‌ی پارامترهایی که واقعاً به اندروید می‌روند — قبل از هر تماس با پل. */
    logNativeDiagnostic({
        event: "SCHEDULE_REQUESTED",
        kind,
        id,
        title: input.title,
        requestedAt: at.getTime(),
        requestedAtIso: at.toISOString(),
        delayMs: at.getTime() - requestedAtMs,
        isExact: notification.isExactNotification,
        allowWhileIdle: notification.schedule?.allowWhileIdle,
        channelId: notification.channelId,
        /*
         * فقط وقتی پیام می‌گذاریم که «دقیق خواسته شد ولی مجوز نبود» — چون این
         * همان حالتِ تعیین‌کننده است: اعلان می‌رسد (غیردقیق و Doze-safe)، ولی
         * ممکن است چند دقیقه دیرتر از لحظه‌ی دقیق. اگر مجوز بود، چیزی اضافه نمی‌شود.
         */
        message:
            exactRequested && !exactGranted
                ? "مجوز «آلارم و یادآور» داده نشده؛ اعلان با آلارم غیردقیق (allowWhileIdle) ثبت شد."
                : undefined,
    })

    let settled = false

    logNativeDiagnostic({
        event: "NATIVE_SCHEDULE_START",
        kind,
        id,
        title: input.title,
        attemptNo,
        requestedAt: at.getTime(),
        requestedAtIso: at.toISOString(),
        isExact: notification.isExactNotification,
        allowWhileIdle: notification.schedule?.allowWhileIdle,
        channelId: notification.channelId,
    })

    const hangTimer = setTimeout(() => {
        if (settled) return

        logNativeDiagnostic({
            event: "SCHEDULE_UNRESOLVED",
            kind,
            id,
            title: input.title,
            requestedAt: at.getTime(),
            requestedAtIso: at.toISOString(),
            delayMs: at.getTime() - Date.now(),
            attemptNo,
            message: `plugin.schedule() بعد از ${SCHEDULE_UNRESOLVED_WARN_MS}ms هنوز resolve/reject نشده؛ promise همچنان معلق است. هیچ چیزی اینجا آزاد یا لغو نمی‌شود.`,
        })
    }, SCHEDULE_UNRESOLVED_WARN_MS)

    try {
        // ساخت/به‌روزرسانی کانال idempotent است؛ قبل از زمان‌بندی تضمینش می‌کنیم.
        await plugin.createChannel(REMINDER_CHANNEL)

        logNativeDiagnostic({
            event: "CHANNEL_RESULT",
            kind,
            id,
            title: input.title,
            attemptNo,
            channelId: REMINDER_CHANNEL.id,
            message: "ایجاد/به‌روزرسانی کانال انجام شد.",
        })

        const result = await plugin.schedule({ notifications: [notification] })

        settled = true
        clearTimeout(hangTimer)

        const resolvedId = result.notifications[0]?.id ?? id

        logNativeDiagnostic({
            event: "NATIVE_SCHEDULE_RESOLVED",
            kind,
            id: resolvedId,
            title: input.title,
            attemptNo,
            requestedAt: at.getTime(),
            requestedAtIso: at.toISOString(),
            isExact: notification.isExactNotification,
            allowWhileIdle: notification.schedule?.allowWhileIdle,
            channelId: notification.channelId,
            warning: result.warning
                ? { code: result.warning.code, message: result.warning.message }
                : undefined,
        })

        void snapshotPendingAfterSchedule(plugin, resolvedId, kind, input.title)

        return { ok: true, id: resolvedId, warning: result.warning }
    } catch (err) {
        settled = true
        clearTimeout(hangTimer)

        const message = describeError(err)

        logNativeDiagnostic({
            event: "NATIVE_SCHEDULE_REJECTED",
            kind,
            id,
            title: input.title,
            attemptNo,
            requestedAt: at.getTime(),
            requestedAtIso: at.toISOString(),
            isExact: notification.isExactNotification,
            allowWhileIdle: notification.schedule?.allowWhileIdle,
            channelId: notification.channelId,
            message,
        })

        return { ok: false, reason: "SCHEDULE_FAILED", message }
    }
}

/** یک اعلان زمان‌بندی‌شده را با شناسه‌اش لغو می‌کند. */
export async function cancelLocalReminder(id: number): Promise<CancelLocalReminderOutcome> {
    const resolved = await resolvePlugin()
    if (!resolved.ok) return resolved

    /*
     * پشته‌ی تماس اینجاست چون مهم‌ترین سؤالِ «چرا اعلان نیامد» معمولاً این است
     * که «چه چیزی بعد از زمان‌بندی آن را لغو کرد». این پشته عمداً فقط چند فریم
     * اول است و هیچ اثری روی رفتار لغو ندارد.
     */
    logNativeDiagnostic({
        event: "CANCEL_REQUESTED",
        kind: "UNKNOWN",
        id,
        stack: captureDiagnosticStack(),
    })

    try {
        await resolved.plugin.cancel({ notifications: [{ id }] })

        logNativeDiagnostic({ event: "CANCEL_DONE", kind: "UNKNOWN", id })

        return { ok: true }
    } catch (err) {
        const message = describeError(err)

        logNativeDiagnostic({ event: "CANCEL_FAILED", kind: "UNKNOWN", id, message })

        return { ok: false, reason: "CANCEL_FAILED", message }
    }
}

/*
 * ── تشخیص: اعلان‌های pending ──────────────────────────────────────────
 * عمداً یک **خواندنِ صرف** است: نه `schedule` می‌کند، نه `cancel`، نه
 * `createChannel` و نه مجوز می‌خواهد. فقط می‌پرسد «الان چه چیزی در صف
 * سیستم‌عامل ثبت شده است» تا بتوان فهمید یک یادآور واقعاً زمان‌بندی شده یا
 * فقط در state خودِ اپ وجود دارد.
 */

/** یک اعلانِ در انتظار، به شکل قابل نمایش. */
export type PendingLocalReminder = {
    id: number
    title: string
    /** لحظه‌ی trigger؛ `null` یعنی بدون زمان‌بندی (اعلان فوری/تکراری). */
    at: Date | null
}

export type PendingLocalRemindersOutcome =
    | { ok: true; notifications: PendingLocalReminder[]; now: Date }
    | { ok: false; reason: "NOT_NATIVE" | "PLUGIN_UNAVAILABLE" | "PENDING_QUERY_FAILED"; message: string }

/**
 * خواندن فهرست اعلان‌های در انتظار از سیستم‌عامل.
 *
 * از API رسمی `LocalNotifications.getPending()` استفاده می‌کند که دقیقاً
 * همان چیزی را برمی‌گرداند که `schedule()` در سیستم‌عامل ثبت کرده — پس
 * پاسخِ «آیا واقعاً زمان‌بندی شد؟» را بدون هیچ حدسی می‌دهد.
 *
 * هیچ تغییری در وضعیت اعلان‌های موجود نمی‌دهد.
 */
export async function listPendingLocalReminders(): Promise<PendingLocalRemindersOutcome> {
    const resolved = await resolvePlugin()
    if (!resolved.ok) {
        return {
            ok: false,
            reason: resolved.reason === "PLUGIN_UNAVAILABLE" ? "PLUGIN_UNAVAILABLE" : "NOT_NATIVE",
            message: resolved.message,
        }
    }

    try {
        const result = await resolved.plugin.getPending()

        return {
            ok: true,
            now: new Date(),
            notifications: result.notifications.map((notification) => ({
                id: notification.id,
                title: notification.title,
                at: notification.schedule?.at ?? null,
            })),
        }
    } catch (err) {
        return { ok: false, reason: "PENDING_QUERY_FAILED", message: describeError(err) }
    }
}

/** شناسه‌ی امن برای اندروید (شناسه‌ها ۳۲ بیتی علامت‌دار هستند). */
function randomNotificationId(): number {
    return Math.floor(Math.random() * 2_000_000_000)
}

/** متن خطای نیتیو یا خطای غیرمنتظره را به یک پیام خوانا تبدیل می‌کند. */
function describeError(err: unknown): string {
    if (err instanceof Error) return `${err.name}: ${err.message}`
    if (err && typeof err === "object" && "message" in err) {
        return String((err as { message: unknown }).message)
    }
    return String(err)
}

/*
 * تشخیص read-only وضعیت exact-alarm برای UI.
 *
 * این تابع هیچ مجوزی نمی‌خواهد، هیچ تنظیماتی را عوض نمی‌کند و هیچ
 * زمان‌بندی/لغو جدیدی انجام نمی‌دهد. خودش پلاگین را resolve می‌کند و خواندن
 * خالص را به `readExactAlarmDiagnostic` می‌سپارد تا منطق وضعیت یک‌جا بماند.
 *
 * روی مرورگر (غیر نیتیو) هم درست جواب می‌دهد (`native: false`)، چون
 * `resolvePlugin()` همان‌جا `NOT_NATIVE` می‌دهد.
 */
export async function checkExactAlarmCapability(): Promise<ExactAlarmDiagnostic> {
    const resolved = await resolvePlugin()
    if (!resolved.ok) {
        return {
            native: false,
            canReadExactSetting: false,
            exactAlarmSetting: "unknown",
            manifestDeclarativeOnly: false,
        }
    }

    return readExactAlarmDiagnostic(() => resolved.plugin.checkExactNotificationSetting())
}

/** Read-only accessor for the LocalNotifications plugin instance.
 * Used only by the delivery probe; does not schedule, cancel, or change permissions
 * or exact-alarm state or the serial queue guard.
 */
export async function getLocalNotificationsPluginForDiagnostics() {
    const resolved = await resolvePlugin()
    if (!resolved.ok) {
        return resolved
    }
    return { ok: true as const, plugin: resolved.plugin }
}
