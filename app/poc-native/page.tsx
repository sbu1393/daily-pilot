"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { PermissionState } from "@capacitor/core"
import type { PendingLocalNotificationSchema, ScheduleResult } from "@capacitor/local-notifications"

/**
 * PoC صفحه — مخصوص تست Capacitor (بخش ۶ و reminder آفلاین PoC).
 * -----------------------------------------------------------------
 * این صفحه **فقط برای اثبات مفهومی** است و هیچ business logic ای را تغییر نمی‌دهد:
 *   • تشخیص «Web Browser» در برابر «Capacitor Native» با API رسمی Capacitor.
 *   • Reminder PoC: Native Local Notification واقعی که کاملاً مستقل از
 *     Next.js API / Prisma / Neon / Web Push / VAPID / اینترنت است.
 *
 * قواعد رعایت‌شده:
 *   - هیچ ارجاعی به payment/auth/business logic اضافه نشده.
 *   - هیچ اتصالی به DB یا Backend ساخته نشده.
 *   - reminder فعلی پروژه (cron سروری + web-push) دست‌نخورده است.
 *   - imports نوعی (type-only) در سطح فایل و imports سنگین به‌صورت dynamic
 *     و فقط داخل هندلرها انجام می‌شود تا SSR/Next build نشکند.
 *
 * این نسخه «صادق» است: هیچ پیام موفقیتی بدون شاهد واقعی نشان داده نمی‌شود.
 * هر مقداری که در UI نمایش داده می‌شود مستقیماً از پاسخ نیتیو گرفته شده است.
 */

/** کانال اختصاصی PoC با importance بالا (۵ = IMPORTANCE_HIGH). */
const CHANNEL_ID = "poc_reminders"
const CHANNEL = {
    id: CHANNEL_ID,
    name: "Reminders (PoC)",
    description: "کانال تست یادآور محلی — اهمیت بالا",
    importance: 5 as const,
    vibration: true,
    lights: true,
    lightColor: "#3b5bdb",
    visibility: 1 as const,
}

type PlatformInfo = {
    isNative: boolean
    platform: string
    ready: boolean
}

/** وضعیت واقعی مجوزها که از خود نیتیو خوانده می‌شود (نه حدس ما). */
type PermissionSnapshot = {
    checked: boolean
    /** POST_NOTIFICATIONS روی Android 13+ */
    display: PermissionState | "unknown"
    /** SCHEDULE_EXACT_ALARM — فقط Android 12+ معنی دارد */
    exactAlarm: PermissionState | "unknown"
    /** آیا کاربر اجازه نمایش اعلان داده است (areEnabled) */
    areEnabled: boolean | "unknown"
}

type PendingRow = {
    id: number
    title: string
    body: string
    at: string
    isExactNotification: boolean
}

type LogLevel = "info" | "ok" | "warn" | "error"

type LogEntry = {
    key: number
    time: string
    level: LogLevel
    text: string
}

/** نتیجه‌ی واقعی آخرین schedule؛ فقط بر اساس پاسخ نیتیو پر می‌شود. */
type ScheduleState =
    | { kind: "idle" }
    | { kind: "working"; label: string }
    | {
          kind: "result"
          /** زمانی که در UI خواسته شد */
          requestedAt: string
          /** شناسه‌هایی که نیتیو واقعاً برگرداند (نه شناسه‌ی محاسبه‌شده در JS) */
          returnedIds: number[]
          /** هشدار نیتیو، مثلاً OS-PLUG-LNOT-0017 برای exact alarm */
          warning?: { code: string; message: string }
      }
    | { kind: "error"; message: string }

function describeError(err: unknown): string {
    if (err && typeof err === "object") {
        const e = err as { code?: unknown; message?: unknown }
        const code = typeof e.code === "string" ? e.code : null
        const message = typeof e.message === "string" ? e.message : String(err)
        return code ? `${code} — ${message}` : message
    }
    return String(err)
}

function fmtTime(value: unknown): string {
    if (value instanceof Date) return value.toLocaleTimeString("fa-IR")
    if (typeof value === "string" || typeof value === "number") {
        const d = new Date(value)
        if (!Number.isNaN(d.getTime())) return d.toLocaleTimeString("fa-IR")
        return String(value)
    }
    return "—"
}

const LOG_LEVEL_STYLE: Record<LogLevel, { color: string; prefix: string }> = {
    info: { color: "#555", prefix: "•" },
    ok: { color: "#0a7", prefix: "✓" },
    warn: { color: "#b26a00", prefix: "!" },
    error: { color: "#c00", prefix: "✕" },
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

export default function NativePocPage() {
    const [platform, setPlatform] = useState<PlatformInfo>({
        isNative: false,
        platform: "web",
        ready: false,
    })
    const [perms, setPerms] = useState<PermissionSnapshot>({
        checked: false,
        display: "unknown",
        exactAlarm: "unknown",
        areEnabled: "unknown",
    })
    const [schedule, setSchedule] = useState<ScheduleState>({ kind: "idle" })
    const [pending, setPending] = useState<PendingRow[] | null>(null)
    const [log, setLog] = useState<LogEntry[]>([])
    const logKey = useRef(0)

    /** لاگ واقعی: هم در UI و هم در console (قابل بررسی با chrome://inspect). */
    const push = useCallback((level: LogLevel, text: string) => {
        logKey.current += 1
        const entry: LogEntry = {
            key: logKey.current,
            time: new Date().toLocaleTimeString("fa-IR"),
            level,
            text,
        }
        setLog((prev) => [entry, ...prev].slice(0, 60))
        // eslint-disable-next-line no-console
        console.log(`[PoC:${level}] ${text}`)
    }, [])

    /** import داینامیک تا SSR/Next build نشکند. */
    const loadPlugin = useCallback(async () => {
        const { LocalNotifications } = await import("@capacitor/local-notifications")
        return LocalNotifications
    }, [])

    // تشخیص پلتفرم با API رسمی Capacitor. در مرورگر معمولی مقدار web برمی‌گردد.
    useEffect(() => {
        let cancelled = false
        ;(async () => {
            try {
                const { Capacitor } = await import("@capacitor/core")
                if (cancelled) return
                setPlatform({
                    isNative: Capacitor.isNativePlatform(),
                    platform: Capacitor.getPlatform(),
                    ready: true,
                })
            } catch {
                if (cancelled) return
                setPlatform({ isNative: false, platform: "web", ready: true })
            }
        })()
        return () => {
            cancelled = true
        }
    }, [])

    /**
     * خواندن وضعیت واقعی مجوزها.
     * نکتهٔ کلیدی: `requestPermissions()` فقط POST_NOTIFICATIONS را مدیریت می‌کند؛
     * SCHEDULE_EXACT_ALARM یک «مجوز تنظیمات» جداگانه است و باید خودمان بخوانیم.
     */
    const refreshPermissions = useCallback(async (): Promise<PermissionSnapshot> => {
        try {
            const LN = await loadPlugin()

            const display = (await LN.checkPermissions()).display

            // فقط روی Android معنا دارد؛ در وب/غیراندروید خطا می‌دهد.
            let exactAlarm: PermissionState | "unknown" = "unknown"
            try {
                exactAlarm = (await LN.checkExactNotificationSetting()).exact_alarm
            } catch {
                exactAlarm = "unknown"
            }

            let areEnabled: boolean | "unknown" = "unknown"
            try {
                areEnabled = (await LN.areEnabled()).value
            } catch {
                areEnabled = "unknown"
            }

            const snapshot: PermissionSnapshot = { checked: true, display, exactAlarm, areEnabled }
            setPerms(snapshot)
            push(
                "info",
                `مجوزها — نمایش: ${display} · exact alarm: ${exactAlarm} · اعلان‌ها فعال: ${String(areEnabled)}`,
            )
            return snapshot
        } catch (err) {
            const snapshot: PermissionSnapshot = {
                checked: false,
                display: "unknown",
                exactAlarm: "unknown",
                areEnabled: "unknown",
            }
            setPerms(snapshot)
            push("error", `خواندن مجوزها ناموفق بود: ${describeError(err)}`)
            return snapshot
        }
    }, [loadPlugin, push])

    const ensureChannel = useCallback(async (): Promise<boolean> => {
        try {
            const LN = await loadPlugin()
            await LN.createChannel(CHANNEL)
            const channels = await LN.listChannels()
            const ids = channels.channels.map((c) => c.id)
            const found = ids.includes(CHANNEL_ID)
            push(
                found ? "ok" : "warn",
                `کانال «${CHANNEL_ID}» ساخته/بررسی شد. کانال‌های موجود: ${ids.join(", ") || "—"}`,
            )
            return found
        } catch (err) {
            push("error", `ساخت کانال ناموفق بود: ${describeError(err)}`)
            return false
        }
    }, [loadPlugin, push])

    /** درخواست مجوز نمایش (POST_NOTIFICATIONS روی Android 13+). */
    const requestDisplayPermission = useCallback(async () => {
        try {
            const LN = await loadPlugin()
            const before = await LN.checkPermissions()
            push("info", `مجوز نمایش قبل از درخواست: ${before.display}`)
            if (before.display !== "granted") {
                const after = await LN.requestPermissions()
                push(
                    after.display === "granted" ? "ok" : "warn",
                    `نتیجهٔ requestPermissions(): ${after.display}`,
                )
            } else {
                push("ok", "مجوز نمایش از قبل granted بود؛ نیازی به درخواست نبود.")
            }
            await refreshPermissions()
        } catch (err) {
            push("error", `درخواست مجوز ناموفق بود: ${describeError(err)}`)
        }
    }, [loadPlugin, push, refreshPermissions])

    /** باز کردن صفحهٔ «Alarms & reminders» برای اعطای SCHEDULE_EXACT_ALARM. */
    const openExactAlarmSettings = useCallback(async () => {
        try {
            const LN = await loadPlugin()
            const res = await LN.changeExactNotificationSetting()
            push(
                res.exact_alarm === "granted" ? "ok" : "warn",
                `نتیجهٔ changeExactNotificationSetting(): exact_alarm = ${res.exact_alarm}`,
            )
            await refreshPermissions()
        } catch (err) {
            push("error", `باز کردن تنظیمات exact alarm ناموفق بود: ${describeError(err)}`)
        }
    }, [loadPlugin, push, refreshPermissions])

    /**
     * لیست اعلان‌های در انتظار.
     * منبع حقیقت سمت نیتیو است (SharedPreferences داخل اپ) — نه حافظهٔ JS.
     */
    const listPending = useCallback(async () => {
        try {
            const LN = await loadPlugin()
            const res = await LN.getPending()
            const rows: PendingRow[] = res.notifications.map((n: PendingLocalNotificationSchema) => ({
                id: n.id,
                title: n.title,
                body: n.body,
                at: fmtTime(n.schedule?.at),
                isExactNotification: n.schedule ? n.schedule.at != null : false,
            }))
            setPending(rows)
            push(
                rows.length ? "ok" : "warn",
                `${rows.length} اعلان در انتظار ثبت شده است.`,
            )
        } catch (err) {
            setPending([])
            push("error", `خواندن لیست در انتظار ناموفق بود: ${describeError(err)}`)
        }
    }, [loadPlugin, push])

    const cancelAll = useCallback(async () => {
        try {
            const LN = await loadPlugin()
            const res = await LN.getPending()
            if (res.notifications.length > 0) {
                await LN.cancel({ notifications: res.notifications })
                push("ok", `${res.notifications.length} اعلان لغو شد.`)
            } else {
                await LN.cancelAll()
                push("info", "اعلان در انتظاری وجود نداشت؛ cancelAll() صدا زد شد.")
            }
            setSchedule({ kind: "idle" })
            await listPending()
        } catch (err) {
            push("error", `لغو ناموفق بود: ${describeError(err)}`)
        }
    }, [loadPlugin, push, listPending])

    /**
     * زمان‌بندی واقعی اعلان.
     * هیچ چیزی حدس زده نمی‌شود: شناسه از `ScheduleResult.notifications` خوانده
     * می‌شود و هشدار `warning` (مثلاً downgrade به inexact alarm) نمایش داده می‌شود.
     *
     * delayMs === null → بدون `schedule` → اعلان فوری (تست کنترل مسیر نمایش).
     */
    const scheduleReminder = useCallback(
        async (delayMs: number | null, label: string) => {
            setSchedule({ kind: "working", label })
            try {
                const LN = await loadPlugin()

                // ۱) مجوز نمایش
                const display = (await LN.checkPermissions()).display
                if (display !== "granted") {
                    const req = await LN.requestPermissions()
                    push(
                        req.display === "granted" ? "ok" : "error",
                        `مجوز نمایش: ${req.display}`,
                    )
                    if (req.display !== "granted") {
                        setSchedule({
                            kind: "error",
                            message: `مجوز نمایش اعلان داده نشد (${req.display}).`,
                        })
                        return
                    }
                } else {
                    push("ok", "مجوز نمایش: granted")
                }

                // ۲) کانال (اگر نباشد اعلان روی کانالِ ناموجود اصلاً نمایش داده نمی‌شود)
                await ensureChannel()

                // ۳) وضعیت exact alarm — روی targetSdk 33+ به‌صورت پیش‌فرض «-denied» است
                let exactAlarm: PermissionState | "unknown" = "unknown"
                try {
                    exactAlarm = (await LN.checkExactNotificationSetting()).exact_alarm
                } catch {
                    exactAlarm = "unknown"
                }
                push(
                    exactAlarm === "granted" ? "ok" : "warn",
                    `SCHEDULE_EXACT_ALARM: ${exactAlarm}` +
                        (exactAlarm === "denied"
                            ? " ← اعلان به‌جای exact، به‌صورت inexact زمان‌بندی می‌شود و ممکن است دیرتر از ۱ دقیقه برسد."
                            : ""),
                )

                const at = new Date(Date.now() + (delayMs ?? 0))
                const localId = Math.floor(Date.now() % 2_000_000_000)

                const res: ScheduleResult = await LN.schedule({
                    notifications: [
                        {
                            id: localId,
                            title: "روزساز — تست یادآور",
                            body:
                                delayMs === null
                                    ? "اعلان فوری: مسیر نمایش (کانال/مجوز/آیکن) تست می‌شود."
                                    : "این اعلان کاملاً محلی است؛ بدون اینترنت و بدون سرور.",
                            channelId: CHANNEL_ID,
                            // true یعنی دقیقاً سرِ وقت؛ اگر مجوزش نباشد نیتیو هشدار می‌دهد.
                            isExactNotification: true,
                            ...(delayMs === null
                                ? {}
                                : { schedule: { at, allowWhileIdle: true } }),
                        },
                    ],
                })

                const returnedIds = res.notifications.map((n) => n.id)
                push(
                    "ok",
                    `schedule() resolve شد — شناسهٔ برگشتی نیتیو: [${returnedIds.join(", ")}] (شناسهٔ ارسالی: ${localId})` +
                        (res.warning ? ` — هشدار ${res.warning.code}` : " — بدون هشدار"),
                )
                if (res.warning) {
                    push("warn", `${res.warning.code}: ${res.warning.message}`)
                }

                setSchedule({
                    kind: "result",
                    requestedAt: fmtTime(at),
                    returnedIds,
                    warning: res.warning,
                })
                await listPending()
            } catch (err) {
                const message = describeError(err)
                push("error", `schedule() رد شد: ${message}`)
                setSchedule({ kind: "error", message })
            }
        },
        [loadPlugin, push, ensureChannel, listPending],
    )

    const platformLabel = !platform.ready
        ? "…"
        : platform.isNative
          ? "Capacitor Native"
          : "Web Browser"

    const busy = schedule.kind === "working"

    return (
        <main
            dir="rtl"
            style={{
                maxWidth: 640,
                margin: "0 auto",
                padding: "2rem 1rem",
                fontFamily: "system-ui, sans-serif",
            }}
        >
            <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>PoC بومی‌سازی (Capacitor)</h1>
            <p style={{ color: "#666", marginBottom: "1.5rem", lineHeight: 1.8 }}>
                این صفحه صرفاً برای اثبات مفهوم است و هیچ بخشی از منطق برنامه را تغییر نمی‌دهد.
                همهٔ مقادیر نمایش‌داده‌شده مستقیماً از پاسخ نیتیو خوانده می‌شوند.
            </p>

            <section
                style={{
                    border: "1px solid #ddd",
                    borderRadius: 12,
                    padding: "1rem",
                    marginBottom: "1rem",
                }}
            >
                <h2 style={{ fontSize: "1.1rem", marginBottom: "0.75rem" }}>۱) محیط اجرا</h2>
                <p style={{ margin: 0, lineHeight: 2 }}>
                    <strong>نتیجه:</strong>{" "}
                    <span
                        style={{
                            fontWeight: 700,
                            color: platform.isNative ? "#0a7" : "#a60",
                        }}
                    >
                        {platformLabel}
                    </span>
                    <br />
                    <span style={{ color: "#666", fontSize: "0.875rem" }}>
                        platform = {platform.platform} · isNativePlatform ={" "}
                        {String(platform.isNative)}
                    </span>
                </p>
            </section>

            <section
                style={{
                    border: "1px solid #ddd",
                    borderRadius: 12,
                    padding: "1rem",
                    marginBottom: "1rem",
                }}
            >
                <h2 style={{ fontSize: "1.1rem", marginBottom: "0.75rem" }}>
                    ۲) وضعیت واقعی مجوزها
                </h2>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
                    <tbody>
                        <tr>
                            <td style={{ padding: "0.35rem 0" }}>
                                POST_NOTIFICATIONS (نمایش)
                            </td>
                            <td
                                style={{
                                    padding: "0.35rem 0",
                                    textAlign: "left",
                                    fontWeight: 700,
                                    color:
                                        perms.display === "granted"
                                            ? "#0a7"
                                            : perms.display === "unknown"
                                              ? "#999"
                                              : "#c00",
                                }}
                            >
                                {perms.checked ? perms.display : "—"}
                            </td>
                        </tr>
                        <tr>
                            <td style={{ padding: "0.35rem 0" }}>
                                SCHEDULE_EXACT_ALARM (زمان‌بندی دقیق)
                            </td>
                            <td
                                style={{
                                    padding: "0.35rem 0",
                                    textAlign: "left",
                                    fontWeight: 700,
                                    color:
                                        perms.exactAlarm === "granted"
                                            ? "#0a7"
                                            : perms.exactAlarm === "unknown"
                                              ? "#999"
                                              : "#c00",
                                }}
                            >
                                {perms.checked ? perms.exactAlarm : "—"}
                            </td>
                        </tr>
                        <tr>
                            <td style={{ padding: "0.35rem 0" }}>areEnabled()</td>
                            <td style={{ padding: "0.35rem 0", textAlign: "left", fontWeight: 700 }}>
                                {perms.checked ? String(perms.areEnabled) : "—"}
                            </td>
                        </tr>
                    </tbody>
                </table>

                <div
                    style={{
                        display: "flex",
                        gap: "0.5rem",
                        flexWrap: "wrap",
                        marginTop: "0.75rem",
                    }}
                >
                    <button style={btnBase} onClick={() => void refreshPermissions()}>
                        خواندن مجوزها
                    </button>
                    <button style={btnBase} onClick={() => void requestDisplayPermission()}>
                        درخواست مجوز نمایش
                    </button>
                    <button style={btnBase} onClick={() => void openExactAlarmSettings()}>
                        باز کردن Alarms &amp; reminders
                    </button>
                    <button style={btnBase} onClick={() => void ensureChannel()}>
                        ساخت کانال
                    </button>
                </div>

                {perms.checked && perms.exactAlarm === "denied" ? (
                    <p style={{ color: "#b26a00", fontSize: "0.875rem", lineHeight: 1.9 }}>
                        ⚠️ SCHEDULE_EXACT_ALARM داده نشده است. روی Android 13+ و targetSdk بالای ۳۲
                        این مجوز به‌صورت پیش‌فرض denied نصب می‌شود. در این حالت نیتیو اعلان را با
                        AlarmManager غیردقیق (inexact) زمان‌بندی می‌کند و سیستم‌عامل می‌تواند اجرای آن
                        را به‌تعویق بیندازد یا تا باز شدن اپ نگه دارد. برای زمان‌بندی دقیق، دکمهٔ
                        «باز کردن Alarms &amp; reminders» را بزنید و دسترسی را فعال کنید.
                    </p>
                ) : null}
            </section>

            <section
                style={{
                    border: "1px solid #ddd",
                    borderRadius: 12,
                    padding: "1rem",
                    marginBottom: "1rem",
                }}
            >
                <h2 style={{ fontSize: "1.1rem", marginBottom: "0.75rem" }}>۳) یادآور محلی</h2>
                <p style={{ color: "#666", fontSize: "0.875rem", lineHeight: 1.9, marginTop: 0 }}>
                    تست کامل: اعلان را بساز، اپ را کامل ببند، اینترنت را قطع کن و منتظر بمان.
                    اگر «تست فوری» کار کرد ولی زمان‌بندی‌دار کار نکرد، مشکل از مسیر AlarmManager
                    است نه از نمایش اعلان.
                </p>

                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    <button
                        style={btnPrimary}
                        disabled={busy}
                        onClick={() => void scheduleReminder(60_000, "۱ دقیقه")}
                    >
                        Reminder in 1 minute
                    </button>
                    <button
                        style={btnPrimary}
                        disabled={busy}
                        onClick={() => void scheduleReminder(10_000, "۱۰ ثانیه")}
                    >
                        تست ۱۰ ثانیه
                    </button>
                    <button
                        style={{ ...btnPrimary, background: "#0a7" }}
                        disabled={busy}
                        onClick={() => void scheduleReminder(null, "فوری")}
                    >
                        تست فوری (بدون زمان‌بندی)
                    </button>
                    <button style={btnBase} onClick={() => void listPending()}>
                        List Pending Notifications
                    </button>
                    <button style={btnBase} onClick={() => void cancelAll()}>
                        لغو اعلان‌های در انتظار
                    </button>
                </div>

                <p
                    style={{
                        marginTop: "0.75rem",
                        lineHeight: 2,
                        fontSize: "0.9rem",
                        wordBreak: "break-word",
                    }}
                >
                    {schedule.kind === "idle" && (
                        <span style={{ color: "#666" }}>هنوز اعلانی زمان‌بندی نشده است.</span>
                    )}
                    {schedule.kind === "working" && (
                        <span style={{ color: "#666" }}>
                            در حال تماس با API بومی… ({schedule.label})
                        </span>
                    )}
                    {schedule.kind === "result" && (
                        <span style={{ color: schedule.warning ? "#b26a00" : "#0a7" }}>
                            {schedule.warning
                                ? `⚠️ ثبت شد اما دقیق نیست — ${schedule.warning.code}: ${schedule.warning.message}`
                                : "✓ ثبت شد (دقیق)"}
                            <br />
                            زمان درخواستی: {schedule.requestedAt} · شناسهٔ برگشتی نیتیو: [
                            {schedule.returnedIds.join(", ") || "—"}]
                        </span>
                    )}
                    {schedule.kind === "error" && (
                        <span style={{ color: "#c00" }}>✕ {schedule.message}</span>
                    )}
                </p>

                <div style={{ marginTop: "0.75rem" }}>
                    <strong style={{ fontSize: "0.9rem" }}>اعلان‌های در انتظار (از نیتیو):</strong>
                    {pending === null ? (
                        <p style={{ color: "#999", fontSize: "0.875rem", margin: "0.25rem 0 0" }}>
                            هنوز خوانده نشده — دکمهٔ «List Pending Notifications» را بزنید.
                        </p>
                    ) : pending.length === 0 ? (
                        <p style={{ color: "#666", fontSize: "0.875rem", margin: "0.25rem 0 0" }}>
                            هیچ اعلانی در انتظار نیست.
                        </p>
                    ) : (
                        <ul style={{ margin: "0.25rem 0 0", paddingRight: "1.25rem", fontSize: "0.875rem" }}>
                            {pending.map((row) => (
                                <li key={row.id} style={{ marginBottom: "0.25rem" }}>
                                    <code>#{row.id}</code> — {row.title} · ساعت {row.at}
                                    {row.isExactNotification ? "" : " (بدون زمان‌بندی)"}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>

                <p style={{ color: "#999", fontSize: "0.8rem", marginBottom: 0 }}>
                    توجه: این اعلان هیچ‌جا ذخیره یا sync نمی‌شود؛ صرفاً روی خود دستگاه زمان‌بندی می‌شود.
                </p>
            </section>

            <section style={{ border: "1px solid #ddd", borderRadius: 12, padding: "1rem" }}>
                <h2 style={{ fontSize: "1.1rem", marginBottom: "0.5rem" }}>۴) گزارش زنده</h2>
                <p style={{ color: "#666", fontSize: "0.8rem", marginTop: 0 }}>
                    همین داده‌ها در console مرورگر هم چاپ می‌شوند (قابل مشاهده با chrome://inspect).
                </p>
                {log.length === 0 ? (
                    <p style={{ color: "#999", fontSize: "0.875rem", margin: 0 }}>
                        رویدادی ثبت نشده است.
                    </p>
                ) : (
                    <ul style={{ listStyle: "none", margin: 0, padding: 0, fontSize: "0.8rem" }}>
                        {log.map((entry) => {
                            const style = LOG_LEVEL_STYLE[entry.level]
                            return (
                                <li
                                    key={entry.key}
                                    style={{
                                        color: style.color,
                                        lineHeight: 1.8,
                                        wordBreak: "break-word",
                                    }}
                                >
                                    <span style={{ color: "#aaa" }}>{entry.time}</span>{" "}
                                    <span>{style.prefix}</span> {entry.text}
                                </li>
                            )
                        })}
                    </ul>
                )}
            </section>
        </main>
    )
}