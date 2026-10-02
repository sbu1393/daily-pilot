"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { PendingLocalNotificationSchema } from "@capacitor/local-notifications"

/**
 * PoC صفحه — دیباگ «چرا handlerها هیچ اثری ندارند».
 * -----------------------------------------------------------------
 * این نسخه عمداً یک هارنس تشخیصی است. هدف: ثابت کردن اینکه کلیک روی دکمه
 * دقیقاً کجا متوقف می‌شود. هیچ چیزی حدس زده نمی‌شود.
 *
 * نکتهٔ کلیدی که این نسخه می‌سنجد:
 *   `#dp-splash` در `app/components/Splash.css` با `position:fixed; inset:0;
 *   z-index:9999` کل صفحه را می‌پوشاند و فقط با یک **انیمیشن CSS** محو می‌شود.
 *   یعنی محو شدن اسپلش **هیچ چیزی دربارهٔ hydrate شدن React ثابت نمی‌کند**.
 *   اگر React hydrate نشده باشد، کاربر دقیقاً همین صفحه را می‌بیند ولی
 *   هیچ onClickای کار نمی‌کند. این هارنس برای تشخیص همین تفکیک است.
 *
 * قواعد:
 *   - هیچ exceptionای swallow نمی‌شود؛ message + stack در UI نمایش داده می‌شود.
 *   - هیچ پیام موفقیتی بدون شاهد واقعی نشان داده نمی‌شود.
 *   - هیچ وابستگی به DB/Backend/Auth/Payment/Web Push وجود ندارد.
 */

/** وضعیت مشترک بین اسکریپت inline و کامپوننت React. */
type PocProbe = {
    /** آیا جاوااسکریپت اصلاً اجرا شده است؟ (اگر false → اسکریپت‌ها لود نشده‌اند) */
    jsAlive: boolean
    /** تعداد کلیک‌هایی که به DOM رسیده‌اند (مستقل از React) */
    domClicks: number
    lastDomClick: string
    /** آیا React hydrate شده است؟ */
    hydrated: boolean
    /** تعداد onClickهایی که واقعاً در React اجرا شده‌اند */
    reactClicks: number
    lastReactClick: string
    errors: string[]
}

declare global {
    interface Window {
        __pocProbe?: PocProbe
    }
}

/**
 * اسکریپت inline که **پیش از hydrate شدن React** اجرا می‌شود.
 * اگر React هرگز hydrate نشود، این اسکریپت باز هم اجرا می‌شود و به ما می‌گوید
 * (الف) جاوااسکریپت اجرا می‌شود یا نه، (ب) کلیک به DOM می‌رسد یا نه،
 * (ج) خطای سراسری چیست. این سه با هم علت را قطعی می‌کنند.
 *
 * این اسکریپت عمداً بیرون از درخت React یک بنر می‌سازد تا با hydration
 * تداخل نکند.
 */
const PROBE_SCRIPT = `
(function () {
  var p = {
    jsAlive: true,
    domClicks: 0,
    lastDomClick: "(هیچ)",
    hydrated: false,
    reactClicks: 0,
    lastReactClick: "(هیچ)",
    errors: []
  };
  window.__pocProbe = p;

  function el() {
    var d = document.createElement("div");
    d.id = "poc-probe-banner";
    d.setAttribute("dir", "rtl");
    d.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:99999;" +
      "background:#111;color:#0f0;font:12px/1.6 monospace;" +
      "padding:8px;white-space:pre-wrap;word-break:break-word;";
    return d;
  }
  function render(msg) {
    var b = document.getElementById("poc-probe-banner");
    if (!b) { b = el(); document.body.appendChild(b); }
    b.textContent = msg;
  }
  function state() {
    return (
      "[PROBE] jsAlive=" + p.jsAlive +
      " hydrated=" + p.hydrated +
      " domClicks=" + p.domClicks +
      " reactClicks=" + p.reactClicks +
      "\\nlastDOMClick=" + p.lastDomClick +
      " | lastReactClick=" + p.lastReactClick +
      "\\nonLine=" + navigator.onLine +
      " | href=" + location.href +
      "\\nwindow.Capacitor=" + (typeof window.Capacitor) +
      " | bridge.LN=" +
      (window.Capacitor && window.Capacitor.Plugins
        ? typeof window.Capacitor.Plugins.LocalNotifications
        : "no-Plugins") +
      (p.errors.length ? "\\nERRORS:\\n" + p.errors.join("\\n") : "")
    );
  }
  window.__pocProbeRender = render;
  window.__pocProbeState = state;

  render(state());

  // کلیک خام روی DOM — کاملاً مستقل از React.
  document.addEventListener(
    "click",
    function (e) {
      var t = e.target;
      var name =
        (t && (t.getAttribute("data-probe") || (t.closest && t.closest("[data-probe]") &&
          t.closest("[data-probe]").getAttribute("data-probe")))) || (t && t.tagName) || "?";
      p.domClicks++;
      p.lastDomClick = name + " @ " + new Date().toLocaleTimeString("fa-IR");
      render(state());
    },
    true
  );

  // خطاهای سراسری — حتی اگر قبل از hydrate شدن رخ داده باشند.
  window.addEventListener("error", function (e) {
    p.errors.push(
      "window.onerror: " + (e.message || "?") +
      " | " + (e.filename || "?") + ":" + (e.lineno || "?") +
      (e.error && e.error.stack ? "\\n" + e.error.stack : "")
    );
    render(state());
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    p.errors.push(
      "unhandledrejection: " +
      (r && r.message ? r.message : String(r)) +
      (r && r.stack ? "\\n" + r.stack : "")
    );
    render(state());
  });
})();
`

/** کانال اختصاصی PoC با importance بالا. */
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

type LogLevel = "info" | "ok" | "warn" | "error"

type LogEntry = {
    key: number
    level: LogLevel
    text: string
}

type Step =
    | { kind: "idle" }
    | { kind: "working"; label: string; step: string }
    | { kind: "done"; label: string; ids: number[] }
    | { kind: "error"; label: string; message: string; stack: string }

type PermissionSnapshot = {
    checked: boolean
    display: string
    exactAlarm: string
    areEnabled: string
}

type PendingRow = {
    id: number
    title: string
    at: string
}

function describeError(err: unknown): { message: string; stack: string } {
    if (err instanceof Error) {
        return {
            message: `${err.name}: ${err.message}`,
            stack: err.stack ?? "(بدون stack)",
        }
    }
    if (err && typeof err === "object") {
        const e = err as { code?: unknown; message?: unknown; stack?: unknown }
        const code = typeof e.code === "string" ? ` [${e.code}]` : ""
        return {
            message: `${typeof e.message === "string" ? e.message : JSON.stringify(err)}${code}`,
            stack: typeof e.stack === "string" ? e.stack : "(بدون stack)",
        }
    }
    return { message: String(err), stack: "(بدون stack)" }
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

export default function NativePocPage() {
    const [log, setLog] = useState<LogEntry[]>([])
    const [step, setStep] = useState<Step>({ kind: "idle" })
    const [perms, setPerms] = useState<PermissionSnapshot>({
        checked: false,
        display: "—",
        exactAlarm: "—",
        areEnabled: "—",
    })
    const [pending, setPending] = useState<PendingRow[] | null>(null)
    const [hydrated, setHydrated] = useState(false)
    const [reactClicks, setReactClicks] = useState(0)
    const logKey = useRef(0)

    /** هر handler با این شروع می‌شود: قبل از هر await، وضعیت و لاگ را ثبت می‌کند. */
    const begin = useCallback((name: string) => {
        if (typeof window !== "undefined" && window.__pocProbe) {
            window.__pocProbe.reactClicks++
            window.__pocProbe.lastReactClick = name
        }
        setReactClicks((n) => n + 1)
        setStep({ kind: "working", label: name, step: "Handler started" })
        logKey.current += 1
        const entry: LogEntry = {
            key: logKey.current,
            level: "info",
            text: `▶ Handler started: ${name}`,
        }
        setLog((prev) => [entry, ...prev].slice(0, 80))
        // eslint-disable-next-line no-console
        console.log(`[PoC] Handler started: ${name}`)
    }, [])

    /** هر مرحله بین handler و نیتیو. */
    const mark = useCallback((text: string, level: LogLevel = "info") => {
        logKey.current += 1
        const entry: LogEntry = { key: logKey.current, level, text }
        setLog((prev) => [entry, ...prev].slice(0, 80))
        setStep((s) => (s.kind === "working" ? { ...s, step: text } : s))
        // eslint-disable-next-line no-console
        console.log(`[PoC:${level}] ${text}`)
    }, [])

    /** پایان موفق یا خطا — خطا هرگز swallow نمی‌شود. */
    const finish = useCallback((err: unknown | null, okText?: string, ids?: number[]) => {
        if (err) {
            const { message, stack } = describeError(err)
            mark(`Native call failed: ${message}`, "error")
            logKey.current += 1
            setLog((prev) =>
                [
                    { key: logKey.current, level: "info" as LogLevel, text: `STACK:\n${stack}` },
                    ...prev,
                ].slice(0, 80),
            )
            setStep({ kind: "error", label: "—", message, stack })
            return
        }
        mark(okText ?? "Native call returned", "ok")
        setStep({ kind: "done", label: "—", ids: ids ?? [] })
    }, [mark])

    /** import داینامیک پلاگین — جدا شده تا محل توقف دقیقاً مشخص باشد. */
    const loadPlugin = useCallback(async () => {
        mark("Loading @capacitor/local-notifications …")
        const mod = await import("@capacitor/local-notifications")
        mark("Plugin imported OK", "ok")
        return mod.LocalNotifications
    }, [mark])

    useEffect(() => {
        setHydrated(true)
        if (window.__pocProbe) {
            window.__pocProbe.hydrated = true
        }
        logKey.current += 1
        setLog((prev) =>
            [
                {
                    key: logKey.current,
                    level: "ok" as LogLevel,
                    text: "✓ React hydrated — onClick ها فعال‌اند",
                },
                ...prev,
            ].slice(0, 80),
        )
    }, [])

    const refreshPermissions = useCallback(async () => {
        begin("refreshPermissions")
        try {
            const LN = await loadPlugin()
            mark("Native call started: checkPermissions()")
            const display = (await LN.checkPermissions()).display
            mark(`Native call returned: checkPermissions() → ${display}`, "ok")
            setPerms((p) => ({ ...p, checked: true, display }))
            finish(null, "مجوز نمایش خوانده شد")
        } catch (err) {
            finish(err)
        }
    }, [begin, loadPlugin, mark, finish])

    const probeBridge = useCallback(async () => {
        begin("probeBridge")
        try {
            const cap = window.__pocProbe
            const globalCap = (window as unknown as { Capacitor?: Record<string, unknown> })
                .Capacitor
            mark(
                `window.Capacitor = ${typeof globalCap} · onLine=${navigator.onLine} · domClicks=${cap?.domClicks ?? "?"} · href=${window.location.href}`,
            )
            if (globalCap) {
                const plugins = globalCap.Plugins as Record<string, unknown> | undefined
                mark(
                    `bridge plugins: ${plugins ? Object.keys(plugins).join(", ") || "(خالی)" : "بدون Plugins"}`,
                    plugins?.LocalNotifications ? "ok" : "warn",
                )
            } else {
                mark("window.Capacitor تعریف نشده → این WebView بومی نیست", "warn")
            }
            finish(null, "بررسی پل نیتیو تمام شد")
        } catch (err) {
            finish(err)
        }
    }, [begin, mark, finish])

    /**
     * کمترین ممکن: فقط import + یک schedule خام با زمان ۵ ثانیه.
     * هیچ بررسی مجوز، هیچ ساخت کانال. اگر همین fail شود، محل توقف قطعی است.
     */
    const probeRawSchedule = useCallback(async () => {
        begin("probeRawSchedule")
        try {
            const LN = await loadPlugin()
            const id = Math.floor(Math.random() * 1_000_000_000)
            const at = new Date(Date.now() + 5_000)
            mark(`Native call started: schedule() id=${id} at=+5s`)
            const res = await LN.schedule({
                notifications: [
                    { id, title: "PoC probe", body: "raw schedule test", schedule: { at } },
                ],
            })
            mark(`Native call returned: schedule() → ${JSON.stringify(res)}`, "ok")
            finish(null, "schedule() خام موفق بود", res.notifications.map((n) => n.id))
        } catch (err) {
            finish(err)
        }
    }, [begin, loadPlugin, mark, finish])

    const ensureChannel = useCallback(async () => {
        begin("ensureChannel")
        try {
            const LN = await loadPlugin()
            mark("Native call started: createChannel()")
            await LN.createChannel(CHANNEL)
            mark("Native call returned: createChannel()", "ok")
            const res = await LN.listChannels()
            mark(`کانال‌های موجود: ${res.channels.map((c) => c.id).join(", ") || "—"}`, "ok")
            finish(null, "کانال ساخته شد")
        } catch (err) {
            finish(err)
        }
    }, [begin, loadPlugin, mark, finish])

    const listPending = useCallback(async () => {
        begin("listPending")
        try {
            const LN = await loadPlugin()
            mark("Native call started: getPending()")
            const res = await LN.getPending()
            const rows: PendingRow[] = res.notifications.map((n: PendingLocalNotificationSchema) => ({
                id: n.id,
                title: n.title,
                at: n.schedule?.at instanceof Date ? n.schedule.at.toLocaleTimeString("fa-IR") : "—",
            }))
            setPending(rows)
            mark(`Native call returned: getPending() → ${rows.length} مورد`, "ok")
            finish(null, `${rows.length} اعلان در انتظار`)
        } catch (err) {
            finish(err)
        }
    }, [begin, loadPlugin, mark, finish])

    const scheduleReminder = useCallback(
        async (delayMs: number | null, label: string) => {
            begin(`scheduleReminder(${label})`)
            try {
                const LN = await loadPlugin()

                mark("Native call started: checkPermissions()")
                const display = (await LN.checkPermissions()).display
                mark(`Native call returned: ${display}`, display === "granted" ? "ok" : "warn")

                if (display !== "granted") {
                    mark("Native call started: requestPermissions()")
                    const req = await LN.requestPermissions()
                    mark(`Native call returned: ${req.display}`, req.display === "granted" ? "ok" : "error")
                    if (req.display !== "granted") {
                        setStep({
                            kind: "error",
                            label,
                            message: `مجوز داده نشد: ${req.display}`,
                            stack: "(بدون stack — پاسخ نیتیو)",
                        })
                        return
                    }
                }

                await ensureChannel()

                mark("Native call started: checkExactNotificationSetting()")
                try {
                    const exact = await LN.checkExactNotificationSetting()
                    mark(`exact_alarm = ${exact.exact_alarm}`, exact.exact_alarm === "granted" ? "ok" : "warn")
                } catch (e) {
                    mark(`checkExactNotificationSetting() در دسترس نیست: ${describeError(e).message}`, "warn")
                }

                const at = new Date(Date.now() + (delayMs ?? 0))
                const id = Math.floor(Math.random() * 1_000_000_000)

                mark(`Native call started: schedule() id=${id}`)
                const res = await LN.schedule({
                    notifications: [
                        {
                            id,
                            title: "روزساز — تست یادآور",
                            body: "اعلان کاملاً محلی؛ بدون اینترنت.",
                            channelId: CHANNEL_ID,
                            isExactNotification: true,
                            ...(delayMs === null ? {} : { schedule: { at, allowWhileIdle: true } }),
                        },
                    ],
                })
                mark(
                    `Native call returned: ids=[${res.notifications.map((n) => n.id).join(", ")}]` +
                        (res.warning ? ` · WARNING ${res.warning.code}` : ""),
                    res.warning ? "warn" : "ok",
                )
                if (res.warning) {
                    mark(`${res.warning.code}: ${res.warning.message}`, "warn")
                }
                finish(null, "schedule() موفق بود", res.notifications.map((n) => n.id))
            } catch (err) {
                finish(err)
            }
        },
        [begin, loadPlugin, mark, finish, ensureChannel],
    )

    return (
        <main
            dir="rtl"
            style={{
                maxWidth: 640,
                margin: "0 auto",
                padding: "1rem 1rem 3rem",
                fontFamily: "system-ui, sans-serif",
            }}
        >
            {/* اجرا می‌شود حتی اگر React هرگز hydrate نشود. */}
            <script dangerouslySetInnerHTML={{ __html: PROBE_SCRIPT }} />

            <h1 style={{ fontSize: "1.3rem", marginBottom: "0.5rem" }}>
                دیباگ: کجا متوقف می‌شویم؟
            </h1>

            {/* ── نوار تشخیص (باید همیشه بالای صفحه دیده شود) ── */}
            <section
                style={{
                    border: "2px solid #111",
                    borderRadius: 8,
                    padding: "0.75rem",
                    marginBottom: "0.75rem",
                    background: "#f7f7f7",
                    fontFamily: "monospace",
                    fontSize: "0.8rem",
                    lineHeight: 1.8,
                }}
            >
                <div>
                    hydrated = <strong>{String(hydrated)}</strong> · reactClicks ={" "}
                    <strong>{reactClicks}</strong>
                </div>
                <div>
                    window.Capacitor ={" "}
                    <strong>
                        {typeof window === "undefined"
                            ? "—"
                            : typeof (window as unknown as { Capacitor?: unknown })
                                  .Capacitor}
                    </strong>{" "}
                    · onLine ={" "}
                    {typeof navigator === "undefined" ? "—" : String(navigator.onLine)}
                </div>
                <div style={{ marginTop: "0.4rem", color: "#444" }}>
                    بنر سیاه بالای صفحه را نگاه کنید — <code>domClicks</code> با{" "}
                    <code>reactClicks</code> مقایسه می‌شود.
                    <br />
                    اگر <code>jsAlive=false</code> → جاوااسکریپت اجرا نشده (SW/لود chunk).
                    <br />
                    اگر <code>domClicks</code> بالا رفت ولی <code>reactClicks</code> صفر ماند →
                    React hydrate نشده.
                </div>
            </section>

            {/* ── وضعیت لحظه‌ای ── */}
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
                <strong>مرحلهٔ فعلی:</strong>{" "}
                {step.kind === "idle" && "—"}
                {step.kind === "working" && (
                    <span style={{ color: "#b26a00" }}>
                        {step.label} → {step.step}
                    </span>
                )}
                {step.kind === "done" && (
                    <span style={{ color: "#0a7" }}>
                        ✓ تمام · ids=[{step.ids.join(", ") || "—"}]
                    </span>
                )}
                {step.kind === "error" && (
                    <span style={{ color: "#c00", wordBreak: "break-word" }}>
                        ✕ {step.message}
                        <pre
                            style={{
                                whiteSpace: "pre-wrap",
                                fontSize: "0.7rem",
                                background: "#fff",
                                border: "1px solid #eee",
                                padding: "0.5rem",
                                margin: "0.5rem 0 0",
                                direction: "ltr",
                                textAlign: "left",
                            }}
                        >
                            {step.stack}
                        </pre>
                    </span>
                )}
            </section>

            {/* ── دکمه‌ها ── */}
            <section
                style={{
                    border: "1px solid #ddd",
                    borderRadius: 8,
                    padding: "0.75rem",
                    marginBottom: "0.75rem",
                }}
            >
                <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>تست‌ها (به ترتیب تشخیص)</h2>
                <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                    <button
                        type="button"
                        data-probe="refreshPermissions"
                        style={btnPrimary}
                        onClick={() => void refreshPermissions()}
                    >
                        ۱) خواندن مجوزها
                    </button>
                    <button
                        type="button"
                        data-probe="probeBridge"
                        style={btnPrimary}
                        onClick={() => void probeBridge()}
                    >
                        ۲) بررسی پل نیتیو
                    </button>
                    <button
                        type="button"
                        data-probe="probeRawSchedule"
                        style={{ ...btnPrimary, background: "#c00" }}
                        onClick={() => void probeRawSchedule()}
                    >
                        ۳) schedule خام (+۵ ثانیه)
                    </button>
                    <button
                        type="button"
                        data-probe="ensureChannel"
                        style={btnBase}
                        onClick={() => void ensureChannel()}
                    >
                        ۴) ساخت کانال
                    </button>
                    <button
                        type="button"
                        data-probe="listPending"
                        style={btnBase}
                        onClick={() => void listPending()}
                    >
                        ۵) List Pending
                    </button>
                    <button
                        type="button"
                        data-probe="immediate"
                        style={btnBase}
                        onClick={() => void scheduleReminder(null, "فوری")}
                    >
                        ۶) تست فوری
                    </button>
                    <button
                        type="button"
                        data-probe="tenSeconds"
                        style={btnBase}
                        onClick={() => void scheduleReminder(10_000, "۱۰ ثانیه")}
                    >
                        ۷) تست ۱۰ ثانیه
                    </button>
                    <button
                        type="button"
                        data-probe="oneMinute"
                        style={btnPrimary}
                        onClick={() => void scheduleReminder(60_000, "۱ دقیقه")}
                    >
                        ۸) Reminder in 1 minute
                    </button>
                </div>

                <p style={{ fontSize: "0.8rem", color: "#666", marginBottom: 0 }}>
                    مجوز نمایش: <strong>{perms.display}</strong> · exact alarm:{" "}
                    <strong>{perms.exactAlarm}</strong> · فعال: <strong>{perms.areEnabled}</strong>
                </p>
                <p style={{ fontSize: "0.8rem", color: "#666", marginBottom: 0 }}>
                    در انتظار:{" "}
                    {pending === null ? "—" : pending.length === 0 ? "هیچ" : pending.map((r) => `#${r.id} (${r.at})`).join(" · ")}
                </p>
            </section>

            {/* ── لاگ مرحله‌ای، بالای صفحه ── */}
            <section
                style={{
                    border: "1px solid #ddd",
                    borderRadius: 8,
                    padding: "0.75rem",
                    marginBottom: "0.75rem",
                }}
            >
                <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>لاگ (جدیدترین اول)</h2>
                {log.length === 0 ? (
                    <p style={{ fontSize: "0.85rem", color: "#999", margin: 0 }}>
                        روی یکی از دکمه‌ها بزنید.
                    </p>
                ) : (
                    <ul style={{ listStyle: "none", margin: 0, padding: 0, fontSize: "0.78rem" }}>
                        {log.map((e) => (
                            <li
                                key={e.key}
                                style={{
                                    color: LOG_COLOR[e.level],
                                    lineHeight: 1.7,
                                    whiteSpace: "pre-wrap",
                                    wordBreak: "break-word",
                                }}
                            >
                                {e.text}
                            </li>
                        ))}
                    </ul>
                )}
            </section>
        </main>
    )
}