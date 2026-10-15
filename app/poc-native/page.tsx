"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
// Feature B — آلارم واقعی تسک (context مستقل از یادآور)
import { useTaskAlarms } from "@/app/hooks/useTaskAlarm"
import {
    LOCAL_REMINDER_CHANNEL_ID,
    cancelLocalReminder,
    checkExactAlarmCapability,
    getLocalNotificationsPluginForDiagnostics,
    isNativeLocalNotificationPlatform,
    listPendingLocalReminders,
    requestLocalNotificationPermission,
    scheduleLocalReminder,
    type PendingLocalReminder,
} from "@/app/lib/native/local-notifications"
import {
    clearNativeDiagnostics,
    describeDiagnosticError,
    getNativeDiagnostics,
    recordDeliverySnapshot,
    subscribeNativeDiagnostics,
    type ExactAlarmDiagnostic,
    type NativeDiagnosticEntry,
    type NativeDiagnosticEvent,
    type ReminderKind,
} from "@/app/lib/native/diagnostics"


/**
 * PoC یادآور محلی نیتیو (Capacitor Local Notifications)
 * ------------------------------------------------------
 * هدف این صفحه فقط تأیید زیرساخت است: تشخیص محیط نیتیو، مجوز اعلان،
 * زمان‌بندی و لغو یک اعلان کاملاً محلی.
 *
 * عمداً به هیچ چیز محصول وصل نیست: نه backend، نه Prisma، نه Auth، نه Push.
 * همه‌ی منطق نیتیو در `app/lib/native/local-notifications.ts` است و این صفحه
 * فقط UI نازکی روی آن است.
 *
 * تنها معیار موفقیت، رسیدن خودِ اعلان روی گوشی است — نه باز شدن این صفحه.
 */

type LogLevel = "info" | "ok" | "warn" | "error"

type LogEntry = {
    key: number
    level: LogLevel
    text: string
}

type ScheduledItem = {
    id: number
    label: string
    at: string
}

/**
 * تشخیص موقت: اعلان‌هایی که سیستم‌عامل واقعاً در صف نگه داشته.
 *
 * جدا از «در انتظار» بالا است، چون آن یک حافظه‌ی محلی از چیزی است که *فکر
 * می‌کنیم* زمان‌بندی کرده‌ایم؛ این یکی از خودِ `getPending()` می‌خواند و
 * تنها راه پاسخ‌دادن به این است که آیا یادآور واقعاً ثبت شده یا نه.
 */
type PendingReport = {
    now: Date
    items: PendingLocalReminder[]
}

/**
 * نتیجهٔ بررسی read-only نشست.
 *
 * این نوع عمداً هیچ مفهومِ «رفع/ورود/خروج» ندارد: فقط وضعیت HTTP را نگه
 * می‌دارد تا هیچ‌کس از این بخش انتظار تغییر نشست نداشته باشد.
 */
type SessionProbe =
    | { phase: "loading"; at: string }
    | { phase: "done"; status: number; ok: boolean; userId?: number; at: string }
    | { phase: "error"; error: string; at: string }

const LOG_COLOR: Record<LogLevel, string> = {
    info: "#555",
    ok: "#0a7",
    warn: "#b26a00",
    error: "#c00",
}

/** برچسب خوانای نوع یادآور در گزارش تشخیصی. */
const KIND_LABEL: Record<ReminderKind, string> = {
    TASK: "تسک",
    DAILY: "روزانه",
    ALARM: "آلارم",
    UNKNOWN: "نامعلوم",
}

/** برچسب خوانای رویدادهای تشخیصی. */
const DIAG_EVENT_LABEL: Record<NativeDiagnosticEvent, string> = {
    SCHEDULE_REQUESTED: "درخواست زمان‌بندی",
    SCHEDULE_RESOLVED: "زمان‌بندی موفق",
    SCHEDULE_FAILED: "زمان‌بندی ناموفق",
    SCHEDULE_UNRESOLVED: "بدون پاسخ (قفل صف)",
    PENDING_SNAPSHOT: "عکس لحظه‌ای Pending",
    QUEUE_RELEASED: "رهاسازی صف نیتیو",
    CANCEL_REQUESTED: "درخواست لغو",
    CANCEL_DONE: "لغو شد",
    CANCEL_FAILED: "لغو ناموفق",
    DELIVERY_SNAPSHOT: "عکس وضعیت تحویل (Read-only)",
    NATIVE_SCHEDULE_START: "شروع زمان‌بندی در پل",
    NATIVE_SCHEDULE_RESOLVED: "زمان‌بندی با پل حل شد",
    NATIVE_SCHEDULE_REJECTED: "زمان‌بندی با پل رد شد",
    CHANNEL_RESULT: "نتیجه‌ی عملیات کانال",
    UNRESOLVED_GUARDED: "نگه‌بان قفل شدن فعلاً فقط ثبت شد",
    CANCEL_ATTEMPT_FOR_UNRESOLVED: "تلاش قفل‌شده با cancel لغو شد",
    CANCEL_FAILED_FOR_UNRESOLVED: "لغو قفل‌شده ناموفق بود",
    SCHEDULE_START: "شروع تلاش زمان‌بندی",
    PERMISSION_RESULT: "نتیجه‌ی مجوز اعلان",
    EXACT_CAPABILITY: "نتیجه‌ی capability آلارم دقیق",
}

/** برچسب خوانای وضعیت مجوز آلارم دقیق — همان سه حالتی که تصمیم را می‌سازند. */
const EXACT_SETTING_LABEL: Record<ExactAlarmDiagnostic["exactAlarmSetting"], string> = {
    granted: "GRANTED",
    denied: "NOT_GRANTED",
    unknown: "UNKNOWN",
}

/** رنگ هر رویداد — قرمز = شکست/قفل، سبز = موفق. */
const DIAG_EVENT_COLOR: Record<NativeDiagnosticEvent, string> = {
    SCHEDULE_REQUESTED: "#555",
    SCHEDULE_RESOLVED: "#0a7",
    SCHEDULE_FAILED: "#c00",
    SCHEDULE_UNRESOLVED: "#c00",
    PENDING_SNAPSHOT: "#3b5bdb",
    QUEUE_RELEASED: "#c00",
    CANCEL_REQUESTED: "#b26a00",
    CANCEL_DONE: "#b26a00",
    CANCEL_FAILED: "#c00",
    DELIVERY_SNAPSHOT: "#3b5bdb",
    NATIVE_SCHEDULE_START: "#555",
    NATIVE_SCHEDULE_RESOLVED: "#0a7",
    NATIVE_SCHEDULE_REJECTED: "#c00",
    CHANNEL_RESULT: "#0a7",
    UNRESOLVED_GUARDED: "#c00",
    CANCEL_ATTEMPT_FOR_UNRESOLVED: "#b26a00",
    CANCEL_FAILED_FOR_UNRESOLVED: "#c00",
    SCHEDULE_START: "#555",
    PERMISSION_RESULT: "#3b5bdb",
    EXACT_CAPABILITY: "#3b5bdb",
}

/**
 * ترتیب ثابت رویدادهای یک «تلاشِ» زمان‌بندی.
 *
 * این‌ها دقیقاً همان رویدادهایی هستند که `attemptNo` را حمل می‌کنند، پس
 * فیلترکردن گزارش با آخرین `attemptNo` فقط همین‌ها را برمی‌گرداند و ترتیب
 * زیر همان ترتیب واقعی اجراست. نمایش ثابت باعث می‌شود مرحلهٔ «ثبت‌نشده»
 * هم صراحتاً دیده شود (بدون حدس).
 */
const ATTEMPT_EVENT_ORDER: NativeDiagnosticEvent[] = [
    "SCHEDULE_START",
    "PERMISSION_RESULT",
    "EXACT_CAPABILITY",
    "CHANNEL_RESULT",
    "NATIVE_SCHEDULE_START",
    "NATIVE_SCHEDULE_RESOLVED",
    "NATIVE_SCHEDULE_REJECTED",
    "SCHEDULE_UNRESOLVED",
]

const monoStyle: React.CSSProperties = {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "0.72rem",
    direction: "ltr",
    textAlign: "left",
    wordBreak: "break-word",
}

const btnBase: React.CSSProperties = {
    padding: "0.6rem 1rem",
    borderRadius: 8,
    border: "1px solid #ccc",
    background: "#fff",
    cursor: "pointer",
    fontFamily: "inherit",
}

const btnPrimary: React.CSSProperties = {
    ...btnBase,
    border: "none",
    background: "#3b5bdb",
    color: "#fff",
    fontWeight: 600,
}

function addSeconds(seconds: number): Date {
    return new Date(Date.now() + seconds * 1000)
}

export default function NativePocPage() {
    /** `null` یعنی هنوز بررسی نشده (برای هم‌خوانی SSR و کلاینت). */
    const [native, setNative] = useState<boolean | null>(null)
    const [permission, setPermission] = useState("—")
    const [scheduled, setScheduled] = useState<ScheduledItem[]>([])
    const [pending, setPending] = useState<PendingReport | null>(null)
    const [busy, setBusy] = useState(false)
    const [log, setLog] = useState<LogEntry[]>([])
    const logKey = useRef(0)

    /* گزارش تشخیصی — از localStorage خوانده می‌شود و زنده به‌روز می‌شود. */
    const [diag, setDiag] = useState<NativeDiagnosticEntry[]>([])
    const [diagClock, setDiagClock] = useState<Date | null>(null)
    const [exactAlarmDiag, setExactAlarmDiag] = useState<ExactAlarmDiagnostic | null>(null)
    /** نسخه‌ی اندروید از UA وب‌ویو — تنها راه بدون افزودن پلاگین Device. */
    const [osLabel, setOsLabel] = useState("—")
    const [pendingDeliverySnapshot, setPendingDeliverySnapshot] = useState<{
        pendingCount: number
        deliveredCount: number
        deliveryFocusFound: boolean | undefined
    } | null>(null)

    type DeliveryProbePhase = "idle" | "loading" | "done" | "error"
    const [deliveryProbe, setDeliveryProbe] = useState<{
        phase: DeliveryProbePhase
        focusId?: number
        pendingCount?: number
        deliveredCount?: number
        deliveryFocusFound?: boolean
        error?: string
        at?: string
    } | null>(null)

    const [pendingError, setPendingError] = useState<string | null>(null)

    /* نتیجهٔ بررسی read-only نشست — فقط نمایش وضعیت HTTP. */
    const [sessionProbe, setSessionProbe] = useState<SessionProbe | null>(null)
    const [sessionBusy, setSessionBusy] = useState(false)

    /*
     * Feature B — آلارم واقعی تسک.
     *
     * این بخش فقط «رابط آزمایش روی دستگاه» است: از همان context واقعیِ آلارم
     * استفاده می‌کند (نه یک مسیر موازی)، تا آنچه اینجا آزمایش می‌شود دقیقاً همان
     * چیزی باشد که از کارت تسک ثبت می‌شود.
     */
    const {
        nativePlatform: alarmPlatform,
        bridgeAvailable: alarmBridge,
        nativeStatus: alarmStatus,
        alarms: alarmList,
        setAlarm: setProbeAlarm,
        removeAlarm: removeProbeAlarm,
        refreshNativeStatus,
        requestExactPermission,
        requestNotificationPermission,
        requestFullScreenPermission,
    } = useTaskAlarms()
    const [alarmProbe, setAlarmProbe] = useState("—")
    const [alarmBusy, setAlarmBusy] = useState(false)

    const logLine = useCallback((level: LogLevel, text: string) => {
        logKey.current += 1
        setLog((prev) => [{ key: logKey.current, level, text }, ...prev].slice(0, 30))
    }, [])

    /**
     * ثبت آلارم آزمایشی ۱ دقیقه‌ای — از همان مسیر واقعی کارت تسک.
     * شناسه‌ی تسک ثابت است تا اجرای دوباره همان آلارم را جایگزین کند.
     */
    const POC_ALARM_TASK_ID = 1_199_001

    const probeAlarmOneMinute = useCallback(async () => {
        setAlarmBusy(true)
        setAlarmProbe("در حال ثبت…")
        try {
            const result = await setProbeAlarm(
                { id: POC_ALARM_TASK_ID, title: "آزمایش آلارم (PoC)" },
                Date.now() + 60_000,
            )
            setAlarmProbe(
                result.ok
                    ? `ثبت شد · exact=${String(result.exact)} · ${new Date(Date.now() + 60_000).toLocaleTimeString("fa-IR")}`
                    : `ناموفق: ${result.reason} · ${result.message}`,
            )
            logLine(result.ok ? "ok" : "error", `آلارم آزمایشی: ${result.ok ? "ok" : result.reason}`)
        } catch (error) {
            setAlarmProbe(`خطا: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
            setAlarmBusy(false)
        }
    }, [setProbeAlarm, logLine])

    const probeAlarmCancel = useCallback(async () => {
        setAlarmBusy(true)
        try {
            const result = await removeProbeAlarm(POC_ALARM_TASK_ID)
            setAlarmProbe(result.ok ? "لغو شد" : `لغو ناموفق: ${result.reason}`)
        } finally {
            setAlarmBusy(false)
        }
    }, [removeProbeAlarm])

    /*
     * بررسی read-only نشست.
     *
     * عمداً هیچ کاری جز یک GET نمی‌کند: نه logout، نه redirect، نه تغییر کوکی.
     * `credentials: "same-origin"` یعنی کوکی نشست همراه درخواست می‌رود (همان‌طور
     * که در ناوبری عادی می‌رفت) و نتیجه فقط خوانده می‌شود. هدف این است که بدون
     * DevTools مشخص شود «آیا کوکی نشست روی دستگاه زنده است یا نه» — چون تنها
     * مسیر خودکار به صفحهٔ ورود، همین ۴۰۱ در سمت سرور است.
     */
    const readSession = useCallback(async () => {
        setSessionBusy(true)
        setSessionProbe({ phase: "loading", at: new Date().toISOString() })

        try {
            const res = await fetch("/api/auth/profile", {
                method: "GET",
                credentials: "same-origin",
                cache: "no-store",
            })

            let userId: number | undefined
            try {
                const body = (await res.json()) as { data?: { id?: unknown } }
                const id = body?.data?.id
                if (res.ok && typeof id === "number" && Number.isInteger(id)) userId = id
            } catch {
                /* بدنهٔ غیر-JSON — وضعیت HTTP تنها چیزی است که لازم داریم */
            }

            setSessionProbe({ phase: "done", status: res.status, ok: res.ok, userId, at: new Date().toISOString() })
            logLine(
                res.ok ? "ok" : "warn",
                `session · HTTP ${res.status}${userId !== undefined ? ` · userId=${userId}` : ""}`,
            )
        } catch (err) {
            const message = describeDiagnosticError(err)
            setSessionProbe({ phase: "error", error: message, at: new Date().toISOString() })
            logLine("error", `session · درخواست انجام نشد — ${message}`)
        } finally {
            setSessionBusy(false)
        }
    }, [logLine])

    /*
     * اشتراک روی حلقه‌ی گزارش تشخیصی.
     *
     * چرا اینجا هم مهم است: گزارش در `localStorage` می‌ماند، پس بعد از اینکه
     * اپ کاملاً بسته/کشته شد و دوباره باز شد، همین بخش نشان می‌دهد *قبل از مرگ*
     * چه چیزی به اندروید داده شده بود و آیا لغو شده بود یا نه. این تفاوت
     * میان «زمان‌بندی نشد» و «زمان‌بندی شد ولی لغو شد» را قطعی می‌کند.
     */
    useEffect(() => subscribeNativeDiagnostics(setDiag), [])

    /* ساعت زنده‌ی دستگاه — برای مقایسه با `requestedAt` گزارش. */
    useEffect(() => {
        setDiagClock(new Date())
        const id = window.setInterval(() => setDiagClock(new Date()), 1000)
        return () => window.clearInterval(id)
    }, [])

    /*
     * آخرین «تلاش» زمان‌بندی، از روی همان گزارش تشخیصی موجود.
     *
     * هیچ رویداد جدیدی ثبت نمی‌شود و هیچ تابعی از لایهٔ نیتیو صدا زده نمی‌شود؛
     * فقط گزارشِ ذخیره‌شده فیلتر می‌شود. بزرگ‌ترین `attemptNo` = آخرین اجرا، و
     * برای آن اجرا هر رویداد با زمان و پیامش (یا «ثبت‌نشده») نمایش داده می‌شود.
     */
    const attemptReport = useMemo(() => {
        const withAttempt = diag.filter(
            (entry): entry is NativeDiagnosticEntry & { attemptNo: number } =>
                typeof entry.attemptNo === "number",
        )

        if (withAttempt.length === 0) return null

        const latestAttemptNo = withAttempt.reduce(
            (max, entry) => (entry.attemptNo > max ? entry.attemptNo : max),
            withAttempt[0].attemptNo,
        )

        const events = withAttempt
            .filter((entry) => entry.attemptNo === latestAttemptNo)
            .sort((a, b) => a.seq - b.seq)

        const byEvent = new Map<NativeDiagnosticEvent, NativeDiagnosticEntry>()
        for (const entry of events) byEvent.set(entry.event, entry)

        return {
            latestAttemptNo,
            events,
            byEvent,
            last: events[events.length - 1],
            notificationId: events.find((entry) => entry.id !== undefined)?.id,
        }
    }, [diag])

    const askPermission = useCallback(async () => {
        const result = await requestLocalNotificationPermission()

        if (!result.ok) {
            logLine("error", `مجوز اعلان گرفته نشد (${result.reason}): ${result.message}`)
            return
        }

        setPermission(result.display)
        logLine("ok", `مجوز اعلان: ${result.display}`)
    }, [logLine])

    // تشخیص محیط نیتیو + گذاشتن exact alarm diagnostic در آنجا
    useEffect(() => {
        const isNative = isNativeLocalNotificationPlatform()
        setNative(isNative)

        /* در effect ست می‌شود تا HTML اولیه و کلاینت یکسان بمانند (بدون hydration mismatch). */
        const android = /Android\s+([\d.]+)/.exec(navigator.userAgent)
        setOsLabel(android ? `Android ${android[1]}` : "نامعلوم")

        if (!isNative) {
            logLine("warn", "این صفحه داخل اپ نیتیو اجرا نشده؛ اعلان محلی غیرفعال است.")
            return
        }

        logLine("info", `محیط نیتیو تأیید شد · کانال: ${LOCAL_REMINDER_CHANNEL_ID}`)
        void askPermission()
    }, [askPermission, logLine])

    /*
     * Exact Alarm Diagnostic — فقط read-only.
     *
     * از خودِ لایه‌ی نیتیو می‌پرسیم (نه از `window.Capacitor` مستقیم): آن global
     * پلاگین‌ها را روی `Capacitor.Plugins` ثبت می‌کند، نه روی `Capacitor` اش؛
     * پس خواندن مستقیم `window.Capacitor.LocalNotifications` روی دستگاه `undefined`
     * است و بخش تشخیص همیشه «خوانده نشد» نشان می‌داد.
     */
    useEffect(() => {
        if (!native) return

        let disposed = false

        void checkExactAlarmCapability().then((diag) => {
            if (disposed) return
            setExactAlarmDiag(diag)
            logLine(
                diag.exactAlarmSetting === "granted" ? "ok" : "warn",
                `وضعیت مجوز آلارم دقیق: ${diag.exactAlarmSetting} (خوانده‌شده: ${diag.canReadExactSetting})`,
            )
        })

        return () => {
            disposed = true
        }
    }, [native, logLine])

    const schedule = useCallback(
        async (seconds: number) => {
            setBusy(true)
            const result = await scheduleLocalReminder({
                title: "روزساز — یادآور آزمایشی",
                body: `این اعلان ${seconds} ثانیه پیش زمان‌بندی شد.`,
                delayMs: seconds * 1000,
            })
            setBusy(false)

            if (!result.ok) {
                logLine("error", `زمان‌بندی نشد (${result.reason}): ${result.message}`)
                return
            }

            // یک‌بار حساب می‌شود تا زمان نمایش‌داده‌شده در فهرست و لاگ همیشه یکی باشد.
            const targetAt = addSeconds(seconds)
            const targetLabel = targetAt.toLocaleTimeString("fa-IR")

            setScheduled((prev) =>
                [{ id: result.id, label: `${seconds} ثانیه`, at: targetLabel }, ...prev].slice(0, 10),
            )
            logLine("ok", `زمان‌بندی شد · id=${result.id} · ساعت ${targetLabel}`)

            if (result.warning) {
                logLine("warn", `هشدار زمان‌بندی ${result.warning.code}: ${result.warning.message}`)
            }
        },
        [logLine],
    )

    const cancel = useCallback(
        async (id: number) => {
            setBusy(true)
            const result = await cancelLocalReminder(id)
            setBusy(false)

            if (!result.ok) {
                logLine("error", `لغو نشد (${result.reason}): ${result.message}`)
                return
            }

            setScheduled((prev) => prev.filter((item) => item.id !== id))
            logLine("ok", `لغو شد · id=${id}`)
        },
        [logLine],
    )

    const readPending = useCallback(async () => {
        setBusy(true)
        setPendingError(null)

        try {
            const result = await listPendingLocalReminders()

            if (!result.ok) {
                logLine("error", `خواندن اعلان‌های در انتظار ناموفق بود (${result.reason}): ${result.message}`)
                setPendingError(`خواندن pending ناموفق: ${result.message}`)
                return
            }

            setPending({ now: result.now, items: result.notifications })
            setPendingError(null)
            logLine(
                result.notifications.length === 0 ? "warn" : "ok",
                `اعلان‌های در انتظارِ سیستم‌عامل: ${result.notifications.length} مورد (${result.now.toLocaleString("fa-IR")})`,
            )
        } catch (err) {
            const error = `خواندن pending ناگهانی شکست خورد: ${describeDiagnosticError(err)}`
            logLine("error", error)
            setPendingError(error)
        } finally {
            setBusy(false)
        }
    }, [logLine])

    const readDeliverySnapshot = useCallback(async () => {
        logLine("info", `شروع بررسی وضعیت تحویل — کلیک روی دکمه دریافت شد.`)
        setBusy(true)
        setDeliveryProbe({ phase: "loading", focusId: scheduled[0]?.id })

        function finish(phase: "done" | "error", payload?: { error?: string }) {
            setBusy(false)
            setDeliveryProbe((prev) => {
                if (!prev) return null
                return { ...prev, phase, error: payload?.error }
            })
        }

        try {
            const pluginRes = await getLocalNotificationsPluginForDiagnostics()

            if (!pluginRes.ok) {
                const error = `پلاگین تشخیصی در دسترس نیست (${pluginRes.reason}): ${pluginRes.message}`
                logLine("error", error)
                setDeliveryProbe((prev) => (prev ? { ...prev, phase: "error", error } : null))
                finish("error", { error })
                return
            }

            const latestScheduled = scheduled[0]
            if (!latestScheduled) {
                const error = `برای بررسی وضعیت تحویل، اول یک یادآور زمان‌بندی کنید؛ هرگز از صفحه‌ی تنظیمات اندروید استفاده نکنید.`
                logLine("warn", error)
                setDeliveryProbe((prev) => (prev ? { ...prev, phase: "error", error } : null))
                finish("error", { error })
                return
            }

            await recordDeliverySnapshot(pluginRes.plugin, latestScheduled.id, "TASK", "روزساز — یادآور آزمایشی")

            logLine("info", `دستور وضعیت تحویل ثبت شد — خواندن گزارش تشخیصی.`)

            const after = getNativeDiagnostics()
            const last = after.slice().reverse().find((e) => e.event === "DELIVERY_SNAPSHOT")

            if (last) {
                const atIso = last.iso ?? "—"
                setPendingDeliverySnapshot({
                    pendingCount: last.pending?.length ?? 0,
                    deliveredCount: last.delivered?.length ?? 0,
                    deliveryFocusFound: last.deliveryFocusFound,
                })
                setDeliveryProbe({
                    phase: "done",
                    focusId: last.id,
                    pendingCount: last.pending?.length ?? 0,
                    deliveredCount: last.delivered?.length ?? 0,
                    deliveryFocusFound: last.deliveryFocusFound,
                    at: atIso,
                })
                logLine("ok", `وضعیت تحویل ثبت شد (id=${last.id}, pending=${last.pending?.length ?? 0}, delivered=${last.delivered?.length ?? 0}, focusInDelivered=${last.deliveryFocusFound ?? false}, at=${atIso})`)
            } else {
                const error = `يقینی نیست: هیچ رویداد DELIVERY_SNAPSHOT در گزارش تشخیصی یافت نشد؛ یا پل پاسخ نداد یا ذخیره‌ی گزارش شکست خورد.`
                logLine("error", error)
                setDeliveryProbe((prev) => (prev ? { ...prev, phase: "error", error } : null))
                finish("error", { error })
                return
            }

            finish("done")
        } catch (err) {
            const error = `ثبت وضعیت تحویل ناگهانی شکست خورد: ${describeDiagnosticError(err)}`
            logLine("error", error)
            setDeliveryProbe((prev) => (prev ? { ...prev, phase: "error", error } : null))
            finish("error", { error })
        }
    }, [logLine, scheduled])

    return (
        <main
            dir="rtl"
            style={{
                maxWidth: 560,
                margin: "0 auto",
                padding: "1.25rem 1rem 3rem",
                fontFamily: "system-ui, sans-serif",
            }}
        >
            <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>یادآور محلی (PoC)</h1>
            <p style={{ fontSize: "0.85rem", color: "#555", marginTop: 0, lineHeight: 1.8 }}>
                تست اعلان کاملاً محلی روی اندروید. اعلان بدون اینترنت و بدون سرور می‌رسد؛
                معیار موفقیت، رسیدن خودِ اعلان است.
            </p>

            {/* ── وضعیت ── */}
            <section
                style={{
                    border: "1px solid #ddd",
                    borderRadius: 8,
                    padding: "0.75rem",
                    marginBottom: "0.75rem",
                    fontSize: "0.85rem",
                    lineHeight: 2,
                }}
            >
                <div>
                    محیط:{" "}
                    <strong>
                        {native === null ? "در حال بررسی…" : native ? "نیتیو (APK)" : "مرورگر"}
                    </strong>
                </div>
                <div>
                    مجوز اعلان: <strong>{permission}</strong>
                </div>
            </section>

            {/* ── تشخیص: وضعیت نشست (Read-only) ── */}
            <section
                style={{
                    border: "1px solid #6b7280",
                    borderRadius: 8,
                    padding: "0.75rem",
                    marginBottom: "0.75rem",
                    fontSize: "0.85rem",
                }}
            >
                <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.4rem" }}>
                    وضعیت نشست (Read-only)
                </h2>

                <div style={{ lineHeight: 1.9 }}>
                    <div>
                        endpoint: <strong style={monoStyle}>GET /api/auth/profile</strong>
                    </div>
                    {sessionProbe === null && (
                        <div style={{ color: "#777" }}>
                            بررسی نشده — روی «بررسی session (Read-only)» بزن.
                        </div>
                    )}
                    {sessionProbe !== null && sessionProbe.phase === "loading" && (
                        <div>در حال بررسی…</div>
                    )}
                    {sessionProbe !== null && sessionProbe.phase === "done" && (
                        <>
                            <div>
                                HTTP:{" "}
                                <strong style={{ color: sessionProbe.ok ? "#0a7" : "#c00" }}>
                                    {sessionProbe.status}
                                </strong>
                                {" · "}
                                {sessionProbe.status === 200 ? (
                                    <span style={{ color: "#0a7" }}>Session معتبر است</span>
                                ) : sessionProbe.status === 401 ? (
                                    <span style={{ color: "#c00" }}>
                                        Session وجود ندارد/نامعتبر است
                                    </span>
                                ) : (
                                    <span style={{ color: "#c00" }}>پاسخ نامنتظره از سرور</span>
                                )}
                            </div>
                            {sessionProbe.userId !== undefined && (
                                <div>
                                    userId: <strong>{sessionProbe.userId}</strong>
                                </div>
                            )}
                            <div style={{ color: "#777", fontSize: "0.78rem" }}>
                                در {new Date(sessionProbe.at).toLocaleTimeString("fa-IR")}
                            </div>
                        </>
                    )}
                    {sessionProbe !== null && sessionProbe.phase === "error" && (
                        <>
                            <div style={{ color: "#c00" }}>
                                درخواست قابل انجام نیست (network/error)
                            </div>
                            <div style={{ ...monoStyle, color: "#c00" }}>{sessionProbe.error}</div>
                            <div style={{ color: "#777", fontSize: "0.78rem" }}>
                                در {new Date(sessionProbe.at).toLocaleTimeString("fa-IR")} ·
                                navigator.onLine={
                                    typeof navigator !== "undefined" ? String(navigator.onLine) : "—"
                                }
                            </div>
                        </>
                    )}
                </div>

                <p
                    style={{
                        color: "#555",
                        margin: "0.5rem 0 0",
                        lineHeight: 1.8,
                        fontSize: "0.78rem",
                    }}
                >
                    این بخش فقط یک GET می‌زند: نه logout، نه redirect، نه تغییر نشست. ۴۰۱ اینجا
                    روشن می‌کند که همان redirect سمت سرور به /auth/login چرا رخ داده است.
                </p>
            </section>

            {native === false && (
                <p
                    style={{
                        border: "1px solid #b26a00",
                        borderRadius: 8,
                        padding: "0.6rem 0.75rem",
                        fontSize: "0.8rem",
                        color: "#b26a00",
                        lineHeight: 1.8,
                    }}
                >
                    اعلان محلی فقط داخل APK کار می‌کند؛ در مرورگر فقط پیام «محیط نیتیو نیست»
                    ثبت می‌شود.
                </p>
            )}

            {/* ── دکمه‌ها ── */}
            <section
                style={{
                    border: "1px solid #ddd",
                    borderRadius: 8,
                    padding: "0.75rem",
                    marginBottom: "0.75rem",
                    display: "flex",
                    gap: "0.4rem",
                    flexWrap: "wrap",
                }}
            >
                <button type="button" style={btnBase} disabled={busy} onClick={() => void askPermission()}>
                    درخواست مجوز
                </button>
                <button
                    type="button"
                    style={btnBase}
                    disabled={sessionBusy}
                    onClick={() => void readSession()}
                >
                    بررسی session (Read-only)
                </button>
                <button
                    type="button"
                    style={btnPrimary}
                    disabled={busy}
                    onClick={() => void schedule(10)}
                >
                    یادآور ۱۰ ثانیه
                </button>
                <button
                    type="button"
                    style={btnPrimary}
                    disabled={busy}
                    onClick={() => void schedule(60)}
                >
                    یادآور ۱ دقیقه
                </button>
                <button
                    type="button"
                    style={btnPrimary}
                    disabled={busy}
                    onClick={() => void readPending()}
                >
                بررسی اعلان‌های Pending
            </button>
            <button
                type="button"
                style={btnPrimary}
                disabled={busy}
                onClick={() => void readDeliverySnapshot()}
            >
                وضعیت تحویل (Read-only)
            </button>
        </section>

            {/* ── Exact Alarm Diagnostic ── Only readout; no behavioral change. ── */}
            {native === true && (
                <section
                    style={{
                        border: "1px solid #b26a00",
                        borderRadius: 8,
                        padding: "0.75rem",
                        marginBottom: "0.75rem",
                        fontSize: "0.85rem",
                    }}
                >
                    <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.4rem" }}>
                        Exact Alarm Diagnostic
                    </h2>
                    <div style={{ lineHeight: 1.9 }}>
                        <div>
                            OS: <strong>{osLabel}</strong>
                        </div>
                        <div>
                            channel: <strong>{LOCAL_REMINDER_CHANNEL_ID}</strong>
                        </div>
                        <div>
                            isExactNotification (خواسته‌شده): <strong>true</strong>
                        </div>
                        <div>
                            isExactNotification (واقعاً اعمال‌شده):{" "}
                            <strong>
                                {exactAlarmDiag
                                    ? String(exactAlarmDiag.exactAlarmSetting === "granted")
                                    : "نامعلوم"}
                            </strong>
                        </div>
                        <div>
                            allowWhileIdle: <strong>true</strong>
                        </div>
                        <div>
                            SCHEDULE_EXACT_ALARM در manifest (از خود پلاگین):{" "}
                            <strong>true</strong>
                        </div>
                        <div>
                            canScheduleExactAlarms():{" "}
                            <strong>
                                {exactAlarmDiag
                                    ? exactAlarmDiag.canReadExactSetting
                                        ? String(exactAlarmDiag.exactAlarmSetting === "granted")
                                        : "نامعلوم (خواندن ممکن نشد)"
                                    : "—"}
                            </strong>
                        </div>
                        <div>
                            وضعیت مجوز:{" "}
                            <strong style={{ color: "#c00" }}>
                                {exactAlarmDiag
                                    ? EXACT_SETTING_LABEL[exactAlarmDiag.exactAlarmSetting]
                                    : "UNKNOWN"}
                            </strong>
                        </div>
                    </div>
                    <p style={{ color: "#555", margin: "0.5rem 0 0", lineHeight: 1.8, fontSize: "0.78rem" }}>
                        این بخش فقط می‌خواند. GRANTED ⇒ آلارم دقیق؛ در غیر این صورت اعلان با
                        آلارم غیردقیقِ Doze-safe ثبت می‌شود. معیار نهایی، دیده‌شدن عبارت در
                        «اعلان‌های Pending» است — نه صرفاً موفق بودن زمان‌بندی.
                    </p>
                </section>
            )}

            {/* ── تشخیص: اعلان‌های ثبت‌شده در سیستم‌عامل ── */}
            {pending !== null && (
                <section
                    style={{
                        border: "1px solid #3b5bdb",
                        borderRadius: 8,
                        padding: "0.75rem",
                        marginBottom: "0.75rem",
                        fontSize: "0.85rem",
                    }}
                >
                    <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.4rem" }}>
                        اعلان‌های Pending (از خودِ اندروید)
                    </h2>
                    <div style={{ lineHeight: 1.9 }}>
                        <div>
                            زمان فعلی دستگاه:{" "}
                            <strong>{pending.now.toLocaleString("fa-IR")}</strong>
                        </div>
                        <div>
                            تعداد: <strong>{pending.items.length}</strong>
                        </div>
                    </div>
                    {pending.items.length === 0 ? (
                        <p style={{ color: "#c00", margin: "0.4rem 0 0", lineHeight: 1.8 }}>
                            هیچ اعلانی در صف سیستم‌عامل ثبت نشده است.
                        </p>
                    ) : (
                        <ul style={{ listStyle: "none", margin: "0.4rem 0 0", padding: 0, lineHeight: 2 }}>
                            {pending.items.map((item) => {
                                const delta = item.at
                                    ? Math.round((item.at.getTime() - pending.now.getTime()) / 60000)
                                    : null

                                return (
                                    <li key={item.id}>
                                        #{item.id} · {item.title} ·{" "}
                                        {item.at ? item.at.toLocaleString("fa-IR") : "بدون زمان‌بندی"}
                                        {delta !== null && ` (${delta} دقیقه دیگر)`}
                                    </li>
                                )
                            })}
                        </ul>
                    )}
                </section>
            )}

            {/* ── خطای خواندن pending ── */}
            {pending === null && pendingError !== null && (
                <section
                    style={{
                        border: "1px solid #c00",
                        borderRadius: 8,
                        padding: "0.75rem",
                        marginBottom: "0.75rem",
                        fontSize: "0.85rem",
                        lineHeight: 1.9,
                    }}
                >
                    <strong style={{ color: "#c00" }}>خطا در بررسی pending:</strong>
                    <p style={{ margin: "0.4rem 0 0" }}>{pendingError}</p>
                </section>
            )}

            {/* ── زمان‌بندی‌شده‌ها ── */}
            <section
                style={{
                    border: "1px solid #ddd",
                    borderRadius: 8,
                    padding: "0.75rem",
                    marginBottom: "0.75rem",
                    fontSize: "0.85rem",
                }}
            >
                <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.5rem" }}>در انتظار</h2>
                {scheduled.length === 0 ? (
                    <p style={{ color: "#999", margin: 0 }}>چیزی زمان‌بندی نشده است.</p>
                ) : (
                    <ul style={{ listStyle: "none", margin: 0, padding: 0, lineHeight: 2 }}>
                        {scheduled.map((item) => (
                            <li
                                key={item.id}
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "space-between",
                                    gap: "0.5rem",
                                }}
                            >
                                <span>
                                    #{item.id} · {item.label} · {item.at}
                                </span>
                                <button
                                    type="button"
                                    style={{ ...btnBase, padding: "0.25rem 0.6rem", fontSize: "0.75rem" }}
                                    disabled={busy}
                                    onClick={() => void cancel(item.id)}
                                >
                                    لغو
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            {/* ── Feature B: آلارم واقعی تسک ── */}
            <section
                style={{
                    border: "1px solid #b26a00",
                    borderRadius: 8,
                    padding: "0.75rem",
                    marginBottom: "0.75rem",
                    fontSize: "0.85rem",
                }}
            >
                <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.5rem" }}>
                    آلارم واقعی تسک (TaskAlarm)
                </h2>
                <div style={{ lineHeight: 1.9 }}>
                    <div>
                        پلتفرم:{" "}
                        <strong>
                            {alarmPlatform === null
                                ? "در حال بررسی…"
                                : alarmPlatform
                                  ? "نیتیو (APK)"
                                  : "مرورگر"}
                        </strong>
                    </div>
                    <div>
                        پلاگین TaskAlarm:{" "}
                        <strong>{alarmBridge ? "ثبت شده" : "ثبت نشده"}</strong>
                    </div>
                    <div>
                        آلارم دقیق:{" "}
                        <strong>
                            {alarmStatus == null ? "—" : String(alarmStatus.exactAlarm)}
                        </strong>{" "}
                        · تمام‌صفحه:{" "}
                        <strong>
                            {alarmStatus == null ? "—" : String(alarmStatus.fullScreenIntent)}
                        </strong>{" "}
                        · اعلان:{" "}
                        <strong>
                            {alarmStatus == null ? "—" : String(alarmStatus.notifications)}
                        </strong>
                    </div>
                    <div>
                        آلارم‌های آینه‌ی محلی: <strong>{alarmList.length}</strong>
                    </div>
                    <div>
                        نتیجه: <strong>{alarmProbe}</strong>
                    </div>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "0.5rem" }}>
                    <button
                        type="button"
                        style={btnBase}
                        disabled={alarmBusy}
                        onClick={() => void probeAlarmOneMinute()}
                    >
                        آلارم ۱ دقیقه
                    </button>
                    <button
                        type="button"
                        style={btnBase}
                        disabled={alarmBusy}
                        onClick={() => void probeAlarmCancel()}
                    >
                        لغو آلارم آزمایشی
                    </button>
                    <button
                        type="button"
                        style={btnBase}
                        disabled={alarmBusy}
                        onClick={() => void refreshNativeStatus()}
                    >
                        تازه‌سازی وضعیت
                    </button>
                    <button
                        type="button"
                        style={btnBase}
                        disabled={alarmBusy}
                        onClick={() => void requestNotificationPermission()}
                    >
                        اجازه اعلان
                    </button>
                    <button
                        type="button"
                        style={btnBase}
                        disabled={alarmBusy}
                        onClick={() => void requestExactPermission()}
                    >
                        اجازه آلارم دقیق
                    </button>
                    <button
                        type="button"
                        style={btnBase}
                        disabled={alarmBusy}
                        onClick={() => void requestFullScreenPermission()}
                    >
                        اجازه تمام‌صفحه
                    </button>
                </div>
                <p style={{ color: "#555", margin: "0.5rem 0 0", lineHeight: 1.8, fontSize: "0.78rem" }}>
                    مراحل تست روی دستگاه: «آلارم ۱ دقیقه» → اپ را ببند/صفحه را خاموش کن → صدا +
                    صفحه‌ی آلارم با توقف/تعویق باید بیاید.
                </p>
            </section>

            {/* ── گزارش تشخیصی زمان‌بندی نیتیو ── */}
            <section
                style={{
                    border: "1px solid #3b5bdb",
                    borderRadius: 8,
                    padding: "0.75rem",
                    marginBottom: "0.75rem",
                    fontSize: "0.85rem",
                }}
            >
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "0.5rem",
                        marginBottom: "0.4rem",
                    }}
                >
                    <h2 style={{ fontSize: "0.95rem", margin: 0 }}>
                        گزارش زمان‌بندی نیتیو ({diag.length})
                    </h2>
                    <button
                        type="button"
                        style={{ ...btnBase, padding: "0.25rem 0.6rem", fontSize: "0.75rem" }}
                        onClick={() => clearNativeDiagnostics()}
                    >
                        پاک‌کردن گزارش
                    </button>
                </div>

                <div style={{ lineHeight: 1.9 }}>
                    <div>
                        زمان فعلی دستگاه:{" "}
                        <strong>{diagClock ? diagClock.toLocaleString("fa-IR") : "—"}</strong>
                    </div>
                    <div style={{ fontSize: "0.78rem", color: "#555" }}>
                        این گزارش در حافظه‌ی دستگاه می‌ماند؛ بعد از بسته‌شدن کامل اپ هم قابل
                        خواندن است.
                    </div>
                </div>

                {diag.length === 0 ? (
                    <p style={{ color: "#999", margin: "0.4rem 0 0" }}>هنوز چیزی ثبت نشده است.</p>
                ) : (
                    <ul
                        style={{
                            listStyle: "none",
                            margin: "0.4rem 0 0",
                            padding: 0,
                            lineHeight: 1.8,
                        }}
                    >
                        {[...diag].reverse().map((entry) => (
                            <li
                                key={entry.seq}
                                style={{
                                    borderTop: "1px dashed #ddd",
                                    paddingTop: "0.35rem",
                                    marginTop: "0.35rem",
                                }}
                            >
                                <div style={{ color: DIAG_EVENT_COLOR[entry.event], fontWeight: 600 }}>
                                    {DIAG_EVENT_LABEL[entry.event]} · {KIND_LABEL[entry.kind]} ·{" "}
                                    {new Date(entry.at).toLocaleTimeString("fa-IR")}
                                </div>
                                <div style={monoStyle}>
                                    {entry.id !== undefined && <div>id={entry.id}</div>}
                                    {entry.title && <div>title={entry.title}</div>}
                                    {entry.requestedAtIso && (
                                        <div>
                                            at={entry.requestedAtIso}
                                            {entry.delayMs !== undefined &&
                                                ` (${Math.round(entry.delayMs / 1000)}s)`}
                                        </div>
                                    )}
                                    {(entry.isExact !== undefined ||
                                        entry.allowWhileIdle !== undefined) && (
                                        <div>
                                            exact={String(entry.isExact)} whileIdle={
                                                String(entry.allowWhileIdle)
                                            }{" "}
                                            channel={entry.channelId}
                                        </div>
                                    )}
                                    {entry.focusFound !== undefined && (
                                        <div>
                                            focusInPending={String(entry.focusFound)} · pending={
                                                entry.pending?.length ?? 0
                                            }
                                        </div>
                                    )}
                                    {entry.warning && (
                                        <div>warning={entry.warning.code}</div>
                                    )}
                                    {entry.message && <div>message={entry.message}</div>}
                                    {entry.stack && <div>stack={entry.stack}</div>}
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            {/* ── تشخیص: آخرین تلاش زمان‌بندی (attemptNo) ── */}
            <section
                style={{
                    border: "1px solid #3b5bdb",
                    borderRadius: 8,
                    padding: "0.75rem",
                    marginBottom: "0.75rem",
                    fontSize: "0.85rem",
                }}
            >
                <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.4rem" }}>
                    آخرین تلاش زمان‌بندی (attemptNo)
                </h2>

                {attemptReport === null ? (
                    <p style={{ color: "#999", margin: "0.4rem 0 0", lineHeight: 1.8 }}>
                        هیچ eventی ثبت نشده است.
                    </p>
                ) : (
                    <>
                        <div style={{ lineHeight: 1.9 }}>
                            <div>
                                attemptNo: <strong>{attemptReport.latestAttemptNo}</strong>
                            </div>
                            <div>
                                notification id:{" "}
                                <strong>{attemptReport.notificationId ?? "—"}</strong>
                            </div>
                            <div>
                                تعداد event: <strong>{attemptReport.events.length}</strong>
                            </div>
                            <div>
                                آخرین event:{" "}
                                <strong
                                    style={{ color: DIAG_EVENT_COLOR[attemptReport.last.event] }}
                                >
                                    {DIAG_EVENT_LABEL[attemptReport.last.event]}
                                </strong>{" "}
                                ·{" "}
                                <span style={{ color: "#555" }}>
                                    {new Date(attemptReport.last.at).toLocaleTimeString("fa-IR")}
                                </span>
                            </div>
                        </div>

                        <ul
                            style={{
                                listStyle: "none",
                                margin: "0.4rem 0 0",
                                padding: 0,
                                lineHeight: 1.8,
                            }}
                        >
                            {ATTEMPT_EVENT_ORDER.map((event) => {
                                const entry = attemptReport.byEvent.get(event)

                                return (
                                    <li
                                        key={event}
                                        style={{
                                            borderTop: "1px dashed #ddd",
                                            paddingTop: "0.3rem",
                                            marginTop: "0.3rem",
                                        }}
                                    >
                                        <div
                                            style={{
                                                color: entry ? DIAG_EVENT_COLOR[event] : "#999",
                                                fontWeight: 600,
                                            }}
                                        >
                                            {DIAG_EVENT_LABEL[event]}
                                        </div>
                                        {entry ? (
                                            <div style={monoStyle}>
                                                <div>
                                                    ثبت شد ·{" "}
                                                    {new Date(entry.at).toLocaleTimeString("fa-IR")}
                                                    {entry.id !== undefined && ` · id=${entry.id}`}
                                                </div>
                                                {(entry.isExact !== undefined ||
                                                    entry.allowWhileIdle !== undefined) && (
                                                    <div>
                                                        exact={String(entry.isExact)} whileIdle={
                                                            String(entry.allowWhileIdle)
                                                        }
                                                    </div>
                                                )}
                                                {entry.message && <div>message={entry.message}</div>}
                                                {entry.warning && (
                                                    <div>warning={entry.warning.code}</div>
                                                )}
                                            </div>
                                        ) : (
                                            <div style={{ color: "#999", fontSize: "0.78rem" }}>
                                                ثبت نشده
                                            </div>
                                        )}
                                    </li>
                                )
                            })}
                        </ul>

                        <p
                            style={{
                                color: "#555",
                                margin: "0.5rem 0 0",
                                lineHeight: 1.8,
                                fontSize: "0.78rem",
                            }}
                        >
                            فقط خوانده‌شده از گزارش موجود است؛ هیچ schedule/cancel/permission/exact/queue
                            تغییر نمی‌کند. اگر «هیچ eventی ثبت نشده است» دیده شود، یعنی برای این یادآور
                            اصلاً به لایهٔ نیتیو نرسیده‌ایم.
                        </p>
                    </>
                )}
            </section>

            {/* ── وضعیت تشخیص تحویل ── */}
            {deliveryProbe !== null && (
                <section
                    style={{
                        border: "1px solid #3b5bdb",
                        borderRadius: 8,
                        padding: "0.75rem",
                        marginBottom: "0.75rem",
                        fontSize: "0.85rem",
                    }}
                >
                    <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.4rem" }}>
                        وضعیت تحویل (Read-only)
                    </h2>
                    <div style={{ lineHeight: 1.9 }}>
                        <div>
                            {deliveryProbe.phase === "loading" && (
                                <strong>در حال بررسی…</strong>
                            )}
                            {deliveryProbe.phase === "done" && (
                                <>
                                    <strong>مشاهده شد · شناسه: {deliveryProbe.focusId}</strong>
                                    {" "}
                                    <span style={{ color: "#555" }}>
                                        در {deliveryProbe.at ? new Date(deliveryProbe.at).toLocaleString("fa-IR") : "—"}
                                    </span>
                                </>
                            )}
                            {deliveryProbe.phase === "error" && (
                                <>
                                    <strong style={{ color: "#c00" }}>خطا یا ناامید</strong>
                                    {" "}
                                    <span style={{ color: "#555", fontSize: "0.78rem" }}>
                                        در گزارش یا لاگ عبارت مربوطه قابل مطالعه است
                                    </span>
                                </>
                            )}
                        </div>
                        {deliveryProbe.phase === "done" && (
                            <>
                                <div>
                                    pending: <strong>{deliveryProbe.pendingCount ?? 0}</strong>
                                </div>
                                <div>
                                    delivered (visible in shade/notification-list):
                                    <strong>{deliveryProbe.deliveredCount ?? 0}</strong>
                                </div>
                                <div>
                                    focusFound در delivered:{" "}
                                    <strong>
                                        {deliveryProbe.deliveryFocusFound === undefined
                                            ? "—"
                                            : String(deliveryProbe.deliveryFocusFound)}
                                    </strong>
                                </div>
                            </>
                        )}
                        {deliveryProbe.phase === "error" && deliveryProbe.error && (
                            <div style={{ color: "#c00", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                                {deliveryProbe.error}
                            </div>
                        )}
                    </div>
                    <p style={{ color: "#555", margin: "0.5rem 0 0", lineHeight: 1.8, fontSize: "0.78rem" }}>
                        این بخش فقط خوانی است و هیچ schedule/cancel/permission/exact/queue تغییر نمی‌کند.
                    </p>
                </section>
            )}

            {/* ── لاگ ── */}
            <section
                style={{
                    border: "1px solid #ddd",
                    borderRadius: 8,
                    padding: "0.75rem",
                }}
            >
                <h2 style={{ fontSize: "0.95rem", margin: "0 0 0.5rem" }}>لاگ (جدیدترین اول)</h2>
                {log.length === 0 ? (
                    <p style={{ fontSize: "0.85rem", color: "#999", margin: 0 }}>—</p>
                ) : (
                    <ul style={{ listStyle: "none", margin: 0, padding: 0, fontSize: "0.78rem" }}>
                        {log.map((entry) => (
                            <li
                                key={entry.key}
                                style={{
                                    color: LOG_COLOR[entry.level],
                                    lineHeight: 1.7,
                                    whiteSpace: "pre-wrap",
                                    wordBreak: "break-word",
                                }}
                            >
                                {entry.text}
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </main>
    )
}
