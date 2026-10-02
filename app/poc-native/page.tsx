"use client"

import { useEffect, useState } from "react"

/**
 * PoC صفحه — مخصوص تست Capacitor (بخش ۶ و reminder آفلاین PoC).
 * -----------------------------------------------------------------
 * این صفحه **فقط برای اثبات مفهومی** است و هیچ business logic ای را تغییر نمی‌دهد:
 *   • بخش ۶: تشخیص «Web Browser» در برابر «Capacitor Native» با API رسمی Capacitor.
 *   • Reminder PoC: یک Native Local Notification آزمایشی («۱ دقیقه بعد») که
 *     کاملاً مستقل از Next.js API / Prisma / Neon / Web Push / VAPID / اینترنت است.
 *
 * قواعد رعایت‌شده:
 *   - هیچ ارجاعی به payment/auth/business logic اضافه نشده.
 *   - هیچ اتصالی به DB یا Backend ساخته نشده.
 *   - reminder فعلی پروژه (cron سروری + web-push) دست‌نخورده است.
 *   - imports سنگین/مرورگر-وابسته به‌صورت dynamic و فقط داخل هندلرها انجام می‌شود
 *     تا SSR/Next build نشکند.
 *
 * ⚠️ برای دیده‌شدن درون APK، این صفحه باید روی همان URL ای که در
 * `capacitor.config.ts` به‌عنوان `server.url` ست شده (production) موجود باشد.
 */

type PlatformInfo = {
    isNative: boolean
    platform: string
    ready: boolean
}

/** نتیجه‌ی آخرین عملیات schedule برای نمایش در UI. */
type ScheduleState =
    | { kind: "idle" }
    | { kind: "working" }
    | { kind: "scheduled"; at: string; id: number }
    | { kind: "error"; message: string }

export default function NativePocPage() {
    const [platform, setPlatform] = useState<PlatformInfo>({
        isNative: false,
        platform: "web",
        ready: false,
    })
    const [schedule, setSchedule] = useState<ScheduleState>({ kind: "idle" })

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

    async function scheduleInOneMinute() {
        setSchedule({ kind: "working" })
        try {
            const { LocalNotifications } = await import("@capacitor/local-notifications")

            // مجوز اعلان (Android 13+ نیازمند POST_NOTIFICATIONS).
            const perm = await LocalNotifications.checkPermissions()
            if (perm.display !== "granted") {
                const req = await LocalNotifications.requestPermissions()
                if (req.display !== "granted") {
                    setSchedule({ kind: "error", message: "مجوز اعلان داده نشد" })
                    return
                }
            }

            const at = new Date(Date.now() + 60_000)
            const id = Math.floor(Date.now() % 1_000_000)

            await LocalNotifications.schedule({
                notifications: [
                    {
                        id,
                        title: "روزساز — تست یادآور",
                        body: "این اعلان کاملاً محلی است؛ بدون اینترنت و بدون سرور.",
                        schedule: { at, allowWhileIdle: true },
                    },
                ],
            })

            setSchedule({ kind: "scheduled", at: at.toLocaleTimeString("fa-IR"), id })
        } catch (err) {
            setSchedule({
                kind: "error",
                message: err instanceof Error ? err.message : "خطای نامشخص در زمان‌بندی",
            })
        }
    }

    async function cancelAll() {
        try {
            const { LocalNotifications } = await import("@capacitor/local-notifications")
            const pending = await LocalNotifications.getPending()
            if (pending.notifications.length > 0) {
                await LocalNotifications.cancel({ notifications: pending.notifications })
            }
            setSchedule({ kind: "idle" })
        } catch (err) {
            setSchedule({
                kind: "error",
                message: err instanceof Error ? err.message : "لغو ناموفق بود",
            })
        }
    }

    const platformLabel = !platform.ready
        ? "…"
        : platform.isNative
          ? "Capacitor Native"
          : "Web Browser"

    return (
        <main dir="rtl" style={{ maxWidth: 640, margin: "0 auto", padding: "2rem 1rem", fontFamily: "system-ui, sans-serif" }}>
            <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>PoC بومی‌سازی (Capacitor)</h1>
            <p style={{ color: "#666", marginBottom: "1.5rem", lineHeight: 1.8 }}>
                این صفحه صرفاً برای اثبات مفهوم است و هیچ بخشی از منطق برنامه را تغییر نمی‌دهد.
            </p>

            <section style={{ border: "1px solid #ddd", borderRadius: 12, padding: "1rem", marginBottom: "1rem" }}>
                <h2 style={{ fontSize: "1.1rem", marginBottom: "0.75rem" }}>۱) محیط اجرا</h2>
                <p style={{ margin: 0, lineHeight: 2 }}>
                    <strong>نتیجه:</strong>{" "}
                    <span style={{ fontWeight: 700, color: platform.isNative ? "#0a7" : "#a60" }}>
                        {platformLabel}
                    </span>
                    <br />
                    <span style={{ color: "#666", fontSize: "0.875rem" }}>
                        platform = {platform.platform} · isNativePlatform = {String(platform.isNative)}
                    </span>
                </p>
            </section>

            <section style={{ border: "1px solid #ddd", borderRadius: 12, padding: "1rem" }}>
                <h2 style={{ fontSize: "1.1rem", marginBottom: "0.75rem" }}>۲) یادآور محلی (PoC)</h2>
                <p style={{ color: "#666", fontSize: "0.875rem", lineHeight: 1.9, marginTop: 0 }}>
                    یک Native Local Notification واقعی زمان‌بندی می‌شود. برای تست کامل: اعلان را بساز،
                    اپ را کامل ببند، اینترنت را قطع کن و منتظر بمان.
                </p>

                <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                    <button
                        onClick={scheduleInOneMinute}
                        disabled={schedule.kind === "working"}
                        style={{
                            padding: "0.6rem 1rem",
                            borderRadius: 8,
                            border: "none",
                            background: "#3b5bdb",
                            color: "#fff",
                            cursor: schedule.kind === "working" ? "wait" : "pointer",
                            fontWeight: 600,
                        }}
                    >
                        {schedule.kind === "working" ? "در حال زمان‌بندی…" : "Reminder in 1 minute"}
                    </button>

                    <button
                        onClick={cancelAll}
                        style={{
                            padding: "0.6rem 1rem",
                            borderRadius: 8,
                            border: "1px solid #ccc",
                            background: "#fff",
                            cursor: "pointer",
                        }}
                    >
                        لغو اعلان‌های در انتظار
                    </button>
                </div>

                <p style={{ marginTop: "0.75rem", lineHeight: 2, fontSize: "0.9rem" }}>
                    {schedule.kind === "idle" && <span style={{ color: "#666" }}>هنوز اعلانی زمان‌بندی نشده است.</span>}
                    {schedule.kind === "working" && <span style={{ color: "#666" }}>در حال تماس با API بومی…</span>}
                    {schedule.kind === "scheduled" && (
                        <span style={{ color: "#0a7" }}>
                            ✅ زمان‌بندی شد — ساعت {schedule.at} (id={schedule.id})
                        </span>
                    )}
                    {schedule.kind === "error" && (
                        <span style={{ color: "#c00" }}>⚠️ {schedule.message}</span>
                    )}
                </p>

                <p style={{ color: "#999", fontSize: "0.8rem", marginBottom: 0 }}>
                    توجه: این اعلان هیچ‌جا ذخیره یا sync نمی‌شود؛ صرفاً روی خود دستگاه زمان‌بندی می‌شود.
                </p>
            </section>
        </main>
    )
}
