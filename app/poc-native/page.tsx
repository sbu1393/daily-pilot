"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
    LOCAL_REMINDER_CHANNEL_ID,
    cancelLocalReminder,
    isNativeLocalNotificationPlatform,
    listPendingLocalReminders,
    requestLocalNotificationPermission,
    scheduleLocalReminder,
    type PendingLocalReminder,
} from "@/app/lib/native/local-notifications"

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

    const logLine = useCallback((level: LogLevel, text: string) => {
        logKey.current += 1
        setLog((prev) => [{ key: logKey.current, level, text }, ...prev].slice(0, 30))
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

    // تشخیص محیط نیتیو + گرفتن مجوز در صورت نیاز (فقط سمت کلاینت).
    useEffect(() => {
        const isNative = isNativeLocalNotificationPlatform()
        setNative(isNative)

        if (!isNative) {
            logLine("warn", "این صفحه داخل اپ نیتیو اجرا نشده؛ اعلان محلی غیرفعال است.")
            return
        }

        logLine("info", `محیط نیتیو تأیید شد · کانال: ${LOCAL_REMINDER_CHANNEL_ID}`)
        void askPermission()
    }, [askPermission, logLine])

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
