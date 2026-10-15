"use client"

import { recordNativeDiagnostic } from "@/app/lib/native/diagnostics"

/*
 * آلارم نیتیو تسک — لایه‌ی کلاینت (پلاگین محلی `TaskAlarm`)
 * -----------------------------------------------------------------
 * این ماژول **عمداً از پلاگین `@capacitor/local-notifications` جدا است**:
 *
 *   یادآور (Feature A)  → اعلان در نوار اعلان؛ تحویل با AlarmManager پلاگین.
 *   آلارم  (Feature B)  → صدای واقعی + صفحه‌ی تمام‌عرض با توقف/تعویق؛ تحویل با
 *                          پلاگین محلی خودِ اپ (`TaskAlarm`).
 *
 * قواعد (هم‌خانواده‌ی `local-notifications.ts`):
 * - هیچ‌وقت throw نمی‌کند؛ خروجی ساختاریافته با `reason` برمی‌گرداند.
 * - خودِ آبجکت پلاگین هرگز از یک تابع `async` برگردانده نمی‌شود (تله‌ی thenable
 *   در Capacitor: پروکسی برای هر پراپرتی ناشناخته — از جمله `then` — تابع
 *   برمی‌گرداند و موتور JS آن را thenable می‌بیند).
 * - «موجود بودن پلاگین» و «نیتیو بودن» دو چیز جدا هستند و هر کدام دلیل خودش را
 *   در گزارش دارد؛ اگر پلاگین در یک APK ثبت نشده باشد، این تفاوت دیده می‌شود.
 */

/** نام پلاگین در پل Capacitor — همان که در `MainActivity` ثبت می‌شود. */
export const TASK_ALARM_PLUGIN_NAME = "TaskAlarm"

/** دلیل شکست — برای تصمیم‌گیری UI، بدون وابستگی به متن خطای نیتیو. */
export type TaskAlarmFailureReason =
    | "NOT_NATIVE" // داخل پوسته‌ی نیتیو (APK) نیستیم
    | "PLUGIN_UNAVAILABLE" // پل Capacitor هست ولی پلاگین آلارم ثبت نشده
    | "IN_THE_PAST" // زمان انتخاب‌شده گذشته است
    | "NOTIFICATIONS_OFF" // اعلان‌ها برای اپ خاموش‌اند
    | "SCHEDULE_FAILED"
    | "CANCEL_FAILED"
    | "CALL_FAILED"

export type TaskAlarmFailure = {
    ok: false
    reason: TaskAlarmFailureReason
    message: string
}

/** قابلیت‌های واقعی سیستم — همه از خودِ اندروید پرسیده می‌شوند، نه فرض. */
export type NativeTaskAlarmStatus = {
    /** آیا مجوز آلارم دقیق (`SCHEDULE_EXACT_ALARM`) داده شده است؟ */
    exactAlarm: boolean
    /** آیا اعلانِ تمام‌صفحه اجازه دارد؟ (Android 14+ می‌تواند «نه» باشد) */
    fullScreenIntent: boolean
    /** آیا نمایش اعلان برای این اپ مجاز است؟ */
    notifications: boolean
    /** سطح API اندروید — فقط برای گزارش. */
    sdk: number
}

export type NativeTaskAlarm = {
    id: number
    taskId: number
    title: string
    at: number
    createdAt: number
}

/** پل نیتیو همان‌طور که در `TaskAlarmPlugin.java` پیاده شده است. */
type TaskAlarmBridge = {
    getStatus: () => Promise<NativeTaskAlarmStatus>
    requestNotificationPermission: () => Promise<{ granted: boolean }>
    requestExactAlarmPermission: () => Promise<{ opened: boolean; granted: boolean }>
    requestFullScreenIntentPermission: () => Promise<{ opened: boolean; granted: boolean }>
    schedule: (options: { id: number; taskId: number; title: string; at: number }) => Promise<
        NativeTaskAlarmStatus & { id: number; at: number; exact: boolean }
    >
    cancel: (options: { id: number }) => Promise<void>
    cancelAll: () => Promise<void>
    getPending: () => Promise<{ alarms: NativeTaskAlarm[]; exactAlarm: boolean }>
    stop: (options: { id: number }) => Promise<void>
    snooze: (options: { id: number; minutes: number }) => Promise<NativeTaskAlarmStatus & { at: number }>
}

type CapacitorWindow = {
    Capacitor?: {
        isNativePlatform?: () => boolean
        isPluginAvailable?: (name: string) => boolean
        Plugins?: Record<string, unknown>
    }
}

function capacitor(): CapacitorWindow["Capacitor"] {
    if (typeof window === "undefined") return undefined
    return (window as unknown as CapacitorWindow).Capacitor
}

/** آیا داخل پوسته‌ی نیتیو (APK) اجرا می‌شویم؟ */
export function isNativeTaskAlarmPlatform(): boolean {
    const cap = capacitor()
    return typeof cap?.isNativePlatform === "function" && cap.isNativePlatform()
}

/**
 * آیا پلاگین آلارم در همین APK ثبت شده است؟
 *
 * این تابع عمداً از «نیتیو بودن» جدا نگه داشته شده: اگر روزی `registerPlugin`
 * در `MainActivity` جا بیفتد، گزارش می‌گوید «نیتیو هستیم ولی پلاگین نیست» —
 * دقیقاً همان تفکیکی که برای تشخیص لازم است. هیچ fallback مضاعفی که خرابیِ
 * ثبت پلاگین را پنهان کند اینجا وجود ندارد.
 */
export function isTaskAlarmBridgeAvailable(): boolean {
    const cap = capacitor()
    if (!cap) return false

    try {
        if (typeof cap.isPluginAvailable === "function" && cap.isPluginAvailable(TASK_ALARM_PLUGIN_NAME)) {
            return true
        }
    } catch {
        /* نسخه‌ی قدیمی پل — از راه دوم امتحان می‌کنیم. */
    }

    return Boolean(cap.Plugins && cap.Plugins[TASK_ALARM_PLUGIN_NAME])
}

type BridgeResolution = { ok: true; bridge: TaskAlarmBridge } | TaskAlarmFailure

function resolveBridge(): BridgeResolution {
    if (!isNativeTaskAlarmPlatform()) {
        return {
            ok: false,
            reason: "NOT_NATIVE",
            message: "آلارم نیتیو فقط داخل اپ اندروید کار می‌کند.",
        }
    }

    const bridge = capacitor()?.Plugins?.[TASK_ALARM_PLUGIN_NAME] as TaskAlarmBridge | undefined

    if (!bridge) {
        return {
            ok: false,
            reason: "PLUGIN_UNAVAILABLE",
            message: "پلاگین آلارم در این نسخه از اپ ثبت نشده است (به‌روزرسانی اپ لازم است).",
        }
    }

    return { ok: true, bridge }
}

function describeError(error: unknown): string {
    if (error instanceof Error) return error.message
    if (typeof error === "string") return error
    try {
        return JSON.stringify(error)
    } catch {
        return "خطای ناشناخته"
    }
}

/** ثبت شواهد؛ هرگز throw نمی‌کند و روی نتیجه اثری ندارد. */
function log(input: Parameters<typeof recordNativeDiagnostic>[0]): void {
    try {
        recordNativeDiagnostic(input)
    } catch {
        /* گزارش تشخیصی هرگز نباید مسیر آلارم را بشکند. */
    }
}

/* ------------------------------------------------------------------ */
/* وضعیت سیستم                                                         */
/* ------------------------------------------------------------------ */

export type TaskAlarmStatusOutcome =
    | ({ ok: true } & NativeTaskAlarmStatus)
    | TaskAlarmFailure

/**
 * وضعیت واقعی مجوزها/قابلیت‌ها.
 *
 * ⚠️ «اعلام شدن مجوز در manifest» با «داده شدن مجوز» یکی نیست؛ این تابع همیشه
 * از خودِ سیستم می‌پرسد.
 */
export async function getTaskAlarmNativeStatus(): Promise<TaskAlarmStatusOutcome> {
    const resolved = resolveBridge()
    if (!resolved.ok) return resolved

    try {
        const status = await resolved.bridge.getStatus()

        log({
            event: "EXACT_CAPABILITY",
            kind: "ALARM",
            isExact: status.exactAlarm,
            message: `fullScreen=${status.fullScreenIntent} notifications=${status.notifications} sdk=${status.sdk}`,
        })

        return {
            ok: true,
            exactAlarm: status.exactAlarm,
            fullScreenIntent: status.fullScreenIntent,
            notifications: status.notifications,
            sdk: status.sdk,
        }
    } catch (error) {
        return { ok: false, reason: "CALL_FAILED", message: describeError(error) }
    }
}

export type TaskAlarmPermissionOutcome =
    | { ok: true; granted: boolean; opened?: boolean }
    | TaskAlarmFailure

export async function requestTaskAlarmNotificationPermission(): Promise<TaskAlarmPermissionOutcome> {
    const resolved = resolveBridge()
    if (!resolved.ok) return resolved

    try {
        const result = await resolved.bridge.requestNotificationPermission()

        log({
            event: "PERMISSION_RESULT",
            kind: "ALARM",
            message: `notifications granted=${result.granted}`,
        })

        return { ok: true, granted: result.granted }
    } catch (error) {
        return { ok: false, reason: "CALL_FAILED", message: describeError(error) }
    }
}

/** صفحه‌ی «آلارم‌ها و یادآورها» را باز می‌کند تا کاربر خودش اجازه بدهد. */
export async function requestTaskAlarmExactPermission(): Promise<TaskAlarmPermissionOutcome> {
    const resolved = resolveBridge()
    if (!resolved.ok) return resolved

    try {
        const result = await resolved.bridge.requestExactAlarmPermission()

        log({
            event: "PERMISSION_RESULT",
            kind: "ALARM",
            isExact: result.granted,
            message: `exact alarm settings opened=${result.opened} granted=${result.granted}`,
        })

        return { ok: true, granted: result.granted, opened: result.opened }
    } catch (error) {
        return { ok: false, reason: "CALL_FAILED", message: describeError(error) }
    }
}

/** صفحه‌ی مجوز اعلان تمام‌صفحه (Android 14+). */
export async function requestTaskAlarmFullScreenPermission(): Promise<TaskAlarmPermissionOutcome> {
    const resolved = resolveBridge()
    if (!resolved.ok) return resolved

    try {
        const result = await resolved.bridge.requestFullScreenIntentPermission()

        log({
            event: "PERMISSION_RESULT",
            kind: "ALARM",
            message: `full-screen intent settings opened=${result.opened} granted=${result.granted}`,
        })

        return { ok: true, granted: result.granted, opened: result.opened }
    } catch (error) {
        return { ok: false, reason: "CALL_FAILED", message: describeError(error) }
    }
}

/* ------------------------------------------------------------------ */
/* زمان‌بندی / لغو                                                     */
/* ------------------------------------------------------------------ */

export type ScheduleNativeTaskAlarmOutcome =
    | { ok: true; id: number; at: number; exact: boolean }
    | TaskAlarmFailure

export async function scheduleNativeTaskAlarm(input: {
    id: number
    taskId: number
    title: string
    at: number
}): Promise<ScheduleNativeTaskAlarmOutcome> {
    const resolved = resolveBridge()
    if (!resolved.ok) return resolved

    /* شروع زنجیره — با شواهدِ «پل دیده شد یا نه». */
    log({
        event: "SCHEDULE_START",
        kind: "ALARM",
        id: input.id,
        title: input.title,
        requestedAt: input.at,
        attemptNo: undefined,
        message: `bridge=${TASK_ALARM_PLUGIN_NAME} native=${isNativeTaskAlarmPlatform()}`,
    })

    log({
        event: "SCHEDULE_REQUESTED",
        kind: "ALARM",
        id: input.id,
        title: input.title,
        requestedAt: input.at,
    })

    try {
        const result = await resolved.bridge.schedule(input)

        log({
            event: "SCHEDULE_RESOLVED",
            kind: "ALARM",
            id: result.id,
            title: input.title,
            requestedAt: result.at,
            /* آیا مسیر «آلارم دقیق» رفتیم یا «غیردقیق»؟ */
            isExact: result.exact,
        })

        /* فهرست آلارم‌های ثبت‌شده در خودِ اندروید بعد از ثبت. */
        await snapshotPending(result.id)

        return { ok: true, id: result.id, at: result.at, exact: result.exact }
    } catch (error) {
        const message = describeError(error)

        log({
            event: "SCHEDULE_FAILED",
            kind: "ALARM",
            id: input.id,
            title: input.title,
            requestedAt: input.at,
            message,
        })

        return {
            ok: false,
            reason: /IN_THE_PAST/.test(message) ? "IN_THE_PAST" : "SCHEDULE_FAILED",
            message,
        }
    }
}

export type CancelNativeTaskAlarmOutcome = { ok: true } | TaskAlarmFailure

export async function cancelNativeTaskAlarm(id: number): Promise<CancelNativeTaskAlarmOutcome> {
    const resolved = resolveBridge()
    if (!resolved.ok) return resolved

    log({ event: "CANCEL_REQUESTED", kind: "ALARM", id })

    try {
        await resolved.bridge.cancel({ id })
        log({ event: "CANCEL_DONE", kind: "ALARM", id })
        return { ok: true }
    } catch (error) {
        const message = describeError(error)
        log({ event: "CANCEL_FAILED", kind: "ALARM", id, message })
        return { ok: false, reason: "CANCEL_FAILED", message }
    }
}

export type ListNativeTaskAlarmsOutcome =
    | { ok: true; alarms: NativeTaskAlarm[]; exactAlarm: boolean }
    | TaskAlarmFailure

/** آلارم‌هایی که واقعاً در اندروید ثبت شده‌اند (منبع حقیقت، نه localStorage). */
export async function listNativeTaskAlarms(): Promise<ListNativeTaskAlarmsOutcome> {
    const resolved = resolveBridge()
    if (!resolved.ok) return resolved

    try {
        const result = await resolved.bridge.getPending()
        return { ok: true, alarms: result.alarms ?? [], exactAlarm: result.exactAlarm }
    } catch (error) {
        return { ok: false, reason: "CALL_FAILED", message: describeError(error) }
    }
}

/** توقف زنگ در جریان (اگر کاربر از داخل اپ بخواهد) */
export async function stopNativeTaskAlarm(id: number): Promise<CancelNativeTaskAlarmOutcome> {
    const resolved = resolveBridge()
    if (!resolved.ok) return resolved

    try {
        await resolved.bridge.stop({ id })
        return { ok: true }
    } catch (error) {
        return { ok: false, reason: "CALL_FAILED", message: describeError(error) }
    }
}

export type SnoozeNativeTaskAlarmOutcome = { ok: true; at: number; exact: boolean } | TaskAlarmFailure

export async function snoozeNativeTaskAlarm(id: number, minutes: number): Promise<SnoozeNativeTaskAlarmOutcome> {
    const resolved = resolveBridge()
    if (!resolved.ok) return resolved

    try {
        const result = await resolved.bridge.snooze({ id, minutes })
        return { ok: true, at: result.at, exact: result.exactAlarm }
    } catch (error) {
        return { ok: false, reason: "CALL_FAILED", message: describeError(error) }
    }
}

/** عکس لحظه‌ای از آلارم‌های ثبت‌شده — فقط شواهد. */
async function snapshotPending(focusId: number): Promise<void> {
    const resolved = resolveBridge()
    if (!resolved.ok) return

    try {
        const result = await resolved.bridge.getPending()
        const alarms = result.alarms ?? []

        log({
            event: "PENDING_SNAPSHOT",
            kind: "ALARM",
            id: focusId,
            focusFound: alarms.some((alarm) => alarm.id === focusId),
            pending: alarms.map((alarm) => ({
                id: alarm.id,
                title: alarm.title,
                atIso: new Date(alarm.at).toISOString(),
            })),
        })
    } catch {
        /* snapshot شکست خورد — بی‌اهمیت است و ثبت نمی‌شود. */
    }
}
