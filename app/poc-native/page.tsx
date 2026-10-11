"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
    LOCAL_REMINDER_CHANNEL_ID,
    cancelLocalReminder,
    checkExactAlarmCapability,
    isNativeLocalNotificationPlatform,
    listPendingLocalReminders,
    requestLocalNotificationPermission,
    scheduleLocalReminder,
    type PendingLocalReminder,
} from "@/app/lib/native/local-notifications"
import {
    clearNativeDiagnostics,
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
}

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

    const logLine = useCallback((level: LogLevel, text: string) => {
        logKey.current += 1
        setLog((prev) => [{ key: logKey.current, level, text }, ...prev].slice(0, 30))
    }, [])

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
        const result = await listPendingLocalReminders()
        setBusy(false)

        if (!result.ok) {
            logLine("error", `خواندن اعلان‌های در انتظار ناموفق بود (${result.reason}): ${result.message}`)
            return
        }

        setPending({ now: result.now, items: result.notifications })
        logLine(
            result.notifications.length === 0 ? "warn" : "ok",
            `اعلان‌های در انتظارِ سیستم‌عامل: ${result.notifications.length} مورد (${result.now.toLocaleString("fa-IR")})`,
        )
    }, [logLine])

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
