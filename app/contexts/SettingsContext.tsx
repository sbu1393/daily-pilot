"use client"

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react"
import { getOfflineUserId, OFFLINE_SCOPE_EVENT } from "@/app/lib/offline"
import { isNativeLocalNotificationPlatform } from "@/app/lib/native/local-notifications"
import { cancelDailyReminder, isSameLocalDay, scheduleDailyReminder } from "@/app/lib/native/daily-reminder"
import {
    DEFAULT_SETTINGS,
    REMINDER_CHECK_INTERVAL_MS,
    REMINDER_TARGET_URL,
    clearLegacySettingsKeys,
    isReminderDue,
    readFiredKey,
    readStoredSettings,
    reminderFireKey,
    saveStoredSettings,
    scopeToken,
    showSystemNotification,
    writeFiredKey,
    type Settings,
    type ThemePreference,
} from "@/app/lib/reminder"

/*
 * تنظیمات کاربر + یادآور روزانه
 * ---------------------------------------------------------------
 * - تنظیمات و کلید `fired` الان user-scoped هستند (`dp:settings:u<id>` /
 *   `dp:reminder-fired:u<id>`، و `:anon` برای بازدیدکننده‌ی ناشناس). کلیدهای
 *   بدون scope (سازگاری قدیمی) هرگز خوانده نمی‌شوند و هنگام برقراری نشست
 *   پاک می‌شوند — همان تصمیم H2 لایه‌ی آفلاین.
 * - یادآور با منطق آستانه‌ای کار می‌کند (نه تطابق دقیق دقیقه) و کلید fired
 *   فقط پس از **نمایش موفق** اعلان ثبت می‌شود.
 * - اعلان با `registration.showNotification` (Service Worker) نمایش داده
 *   می‌شود؛ `new Notification()` روی اندروید پشتیبانی نمی‌شود و حذف شده است.
 */

export type { Settings, ThemePreference }
export { DEFAULT_SETTINGS }

type SettingsContextType = {
    settings: Settings
    update: (patch: Partial<Settings>) => void
    playBeep: () => void
    requestNotificationPermission: () => Promise<boolean>
}

const SettingsContext = createContext<SettingsContextType | null>(null)

/*
 * بودجه‌ی تلاش مجدد برای زمان‌بندی نیتیو.
 * عمداً کوچک و متناهی: تنها وقتی دوباره تلاش می‌شود که شکست تنها دلیلش
 * `PERMISSION_PROMPT` باشد (مجوز در لحظه‌ی زمان‌بندی هنوز قطعی نبوده).
 */
const NATIVE_SCHEDULE_MAX_ATTEMPTS = 3
const NATIVE_SCHEDULE_RETRY_DELAY_MS = 1_500

function resolveTheme(pref: ThemePreference): "light" | "dark" {
    if (pref === "system") {
        return window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light"
    }

    return pref
}

function applyTheme(pref: ThemePreference) {
    const theme = resolveTheme(pref)
    document.documentElement.setAttribute("data-theme", theme)
}

function beep() {
    try {
        const AudioContextClass =
            window.AudioContext ||
            (
                window as unknown as {
                    webkitAudioContext: typeof AudioContext
                }
            ).webkitAudioContext

        const ctx = new AudioContextClass()
        const now = ctx.currentTime

        const play = (freq: number, start: number, duration: number) => {
            const oscillator = ctx.createOscillator()
            const gain = ctx.createGain()

            oscillator.type = "sine"
            oscillator.frequency.value = freq

            gain.gain.setValueAtTime(0.0001, start)
            gain.gain.exponentialRampToValueAtTime(
                0.22,
                start + 0.02,
            )
            gain.gain.exponentialRampToValueAtTime(
                0.0001,
                start + duration,
            )

            oscillator.connect(gain).connect(ctx.destination)
            oscillator.start(start)
            oscillator.stop(start + duration + 0.05)
        }

        play(660, now, 0.18)
        play(880, now + 0.16, 0.28)

        window.setTimeout(() => {
            ctx.close().catch(() => undefined)
        }, 900)
    } catch {
        // Web Audio در دسترس نیست.
    }
}

export function SettingsProvider({
    children,
}: {
    children: React.ReactNode
}) {
    /*
     * سرور و اولین رندر مرورگر باید دقیقاً مقدار یکسانی داشته باشند، بنابراین
     * نه اینجا و نه در رندر اول localStorage خوانده نمی‌شود: scope و تنظیمات
     * فقط پس از mount (و تغییر نشست) خوانده می‌شوند.
     */
    const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
    const [scopeUserId, setScopeUserId] = useState<number | null>(null)

    /*
     * آیا داخل پوسته‌ی نیتیو (APK) هستیم؟
     *
     * `null` یعنی هنوز تشخیص داده نشده — و عمداً همین‌قدر مبهم باقی می‌ماند تا
     * تصمیم‌های مربوط به notification هیچ‌وقت روی SSR یا رندر اول گرفته نشوند.
     * تشخیص فقط بعد از mount (سمت کلاینت) انجام می‌شود.
     */
    const [nativePlatform, setNativePlatform] = useState<boolean | null>(null)

    /*
     * scopeای که `settings` فعلی برای آن خوانده شده است. تا وقتی با scope
     * جاری یکی نشود، نه تم اعمال می‌شود و نه چیزی ذخیره — تا تنظیماتِ یک
     * حساب هرگز زیر کلید حساب دیگر نوشته نشود.
     */
    const [hydratedScope, setHydratedScope] = useState<string | null>(null)

    const scope = scopeToken(scopeUserId)

    /* کلید fired که واقعاً «نمایش داده شد» را ثبت می‌کند */
    const firedRef = useRef<string | null>(null)
    /* تلاش نمایش در همین نشست (جلوگیری از حلقه‌ی ۲۰ ثانیه‌ای) */
    const attemptedRef = useRef<string | null>(null)
    /* بوق fallback — حداکثر یک‌بار در هر (روز|زمان) در همین نشست */
    const beepedRef = useRef<string | null>(null)

    // scope نشست + پاک‌سازی کلیدهای قدیمیِ بدون scope (H2)
    useEffect(() => {
        const userId = getOfflineUserId()
        if (userId != null) {
            // کلیدهای بدون scope ممکن است داده‌ی حساب قبلی باشند → فقط پاک می‌شوند
            clearLegacySettingsKeys()
        }
        setScopeUserId(userId)

        // نشست عوض شد (ورود/خروج) → دوباره از localStorage خوانده می‌شود
        const onScopeChange = () => setScopeUserId(getOfflineUserId())
        window.addEventListener(OFFLINE_SCOPE_EVENT, onScopeChange)

        return () => {
            window.removeEventListener(OFFLINE_SCOPE_EVENT, onScopeChange)
        }
    }, [])

    // خواندن تنظیمات همان scope
    useEffect(() => {
        setSettings(readStoredSettings(scopeUserId))
        setHydratedScope(scopeToken(scopeUserId))
    }, [scopeUserId])

    // تشخیص پلتفرم — فقط بعد از mount، پس SSR هیچ‌وقت به window/Capacitor نمی‌رسد.
    useEffect(() => {
        setNativePlatform(isNativeLocalNotificationPlatform())
    }, [])

    // اعمال تم + ذخیره — فقط وقتی تنظیمات به scope جاری تعلق دارند
    useEffect(() => {
        if (hydratedScope !== scope) {
            return
        }

        applyTheme(settings.theme)
        saveStoredSettings(scopeUserId, settings)
    }, [settings, scope, scopeUserId, hydratedScope])

    // دنبال کردن تغییر تم سیستم در حالت system
    useEffect(() => {
        if (hydratedScope !== scope || settings.theme !== "system") {
            return
        }

        const mediaQuery = window.matchMedia(
            "(prefers-color-scheme: dark)",
        )

        const handleChange = () => {
            applyTheme("system")
        }

        mediaQuery.addEventListener("change", handleChange)

        return () => {
            mediaQuery.removeEventListener("change", handleChange)
        }
    }, [settings.theme, scope, hydratedScope])

    // یادآور روزانه (لایه‌ی اول: تایمر صفحه — فقط در مرورگر)
    useEffect(() => {
        if (hydratedScope !== scope) {
            return
        }
        /*
         * روی Android native این لایه کلاً اجرا نمی‌شود: اعلان همان لحظه با
         * Capacitor زمان‌بندی شده است و اجرای اینجا یعنی دو اعلان برای یک یادآور.
         * تا وقتی تشخیص پلتفرم قطعی نشده (`null`)، هم مسدود می‌مانیم تا هیچ
         * پنجره‌ی هم‌پوشانی بین دو مسیر باز نشود.
         */
        if (nativePlatform !== false) {
            return
        }
        if (!settings.reminderEnabled) {
            return
        }

        firedRef.current = readFiredKey(scopeUserId)
        attemptedRef.current = null
        beepedRef.current = null

        let disposed = false

        const check = async () => {
            const now = new Date()

            if (
                !isReminderDue({
                    now,
                    reminderTime: settings.reminderTime,
                    firedKey: firedRef.current,
                })
            ) {
                return
            }

            const fireKey = reminderFireKey(now, settings.reminderTime)

            // بوق fallback (وقتی اعلان ممکن نیست) — یک‌بار در هر (روز|زمان)
            if (beepedRef.current !== fireKey) {
                beepedRef.current = fireKey
                if (settings.sound) {
                    beep()
                }
            }

            if (attemptedRef.current === fireKey) {
                return
            }
            attemptedRef.current = fireKey

            const shown = await showSystemNotification({
                title: "یادآور روزساز",
                body: "وقت برنامه‌ریزی روزت رسیده است ✨",
                url: REMINDER_TARGET_URL,
                tag: `dp-reminder-${fireKey}`,
            })

            /*
             * کلید fired فقط پس از نمایش موفق اعلان ثبت می‌شود. اگر نمایش
             * شکست بخورد، چیزی «نمی‌سوزد» و در visibilitychange بعدی
             * (بیدار شدن دستگاه) دوباره تلاش می‌شود.
             */
            if (!disposed && shown) {
                firedRef.current = fireKey
                writeFiredKey(scopeUserId, fireKey)
            }
        }

        // همان ابتدا نیز بررسی شود (جبران یادآور ازدست‌رفته‌ی همین امروز).
        void check()

        const intervalId = window.setInterval(() => void check(), REMINDER_CHECK_INTERVAL_MS)

        // بیدار شدن تب/دستگاه → یک تلاش دوباره برای یادآورِ جبران‌نشده
        const onVisibilityChange = () => {
            if (document.visibilityState !== "visible") {
                return
            }

            attemptedRef.current = null
            void check()
        }
        document.addEventListener("visibilitychange", onVisibilityChange)

        return () => {
            disposed = true
            window.clearInterval(intervalId)
            document.removeEventListener("visibilitychange", onVisibilityChange)
        }
    }, [
        hydratedScope,
        scope,
        scopeUserId,
        nativePlatform,
        settings.reminderEnabled,
        settings.reminderTime,
        settings.sound,
    ])

    /*
     * یادآور روزانه روی Android native
     * ---------------------------------
     * همان تنظیمات روزانه، اما زمان‌بندی‌شده توسط سیستم‌عامل (Capacitor) — بدون
     * سرور، بدون اینترنت، و مستقل از باز بودن اپ.
     *
     * ترتیب هر تغییر (غیر کردن ساعت / خاموش کردن / خروج و ورود):
     *   cleanup یک effect همیشه **قبل** از اجرای effect بعدی است، پس «لغوِ قبلی»
     *   زمان‌بندیِ جدید پیش‌روی می‌افتد. شناسه‌ی اعلان از scope مشتق می‌شود،
     *   بنابراین لغو/زمان‌بندیِ مکرر روی همان شناسه اتفاق می‌افتد و اعلان تکراری
     *   ساخته نمی‌شود.
     *
     * نتیجه‌ی schedule دیگر دور ریخته نمی‌شود: موفقیت، هشدار و خطا همه ثبت
     * می‌شوند. اگر تنها دلیل شکست `PERMISSION_PROMPT` باشد (مثلاً اپ با یادآور
     * روشن باز شده ولی کاربر مجوز را تازه عوض کرده)، چند تلاش محدود و با فاصله
     * انجام می‌شود — نه polling و نه حلقه‌ی بی‌نهایت. چون شناسه قطعی است،
     * تلاش مجدد روی همان شناسه انجام می‌شود و **اعلان تکراری نمی‌سازد**.
     */
    useEffect(() => {
        if (hydratedScope !== scope) return
        if (!nativePlatform) return

        /* پس از cleanup این effect دیگر نباید چیزی را زمان‌بندی یا تلاش کند. */
        let disposed = false

        if (!settings.reminderEnabled) {
            void cancelDailyReminder(scopeUserId)
            return
        }

        const wait = (ms: number) =>
            new Promise<void>((resolve) => window.setTimeout(resolve, ms))

        const scheduleWithRetry = async () => {
            for (let attempt = 1; attempt <= NATIVE_SCHEDULE_MAX_ATTEMPTS; attempt += 1) {
                const result = await scheduleDailyReminder({
                    userId: scopeUserId,
                    reminderTime: settings.reminderTime,
                })

                /* اگر در همین فاصله cleanup اجرا شده، دیگر دنبالش نمی‌رویم. */
                if (disposed) return

                if (result.ok) {
                    if (result.warning) {
                        /*
                         * هشدار exact-alarm: اعلان به‌جای آلارم دقیق، inexact
                         * زمان‌بندی می‌شود یعنی ممکن است کمی دیرتر برسد — ولی
                         * لغو نمی‌شود. برای تست چنددقیقه‌ای blocker نیست.
                         */
                        console.warn(
                            `[daily-reminder] اعلان زمان‌بندی شد (id=${result.id}) ولی هشدار دارد:`,
                            result.warning,
                        )
                    } else {
                        console.info(
                            `[daily-reminder] اعلان زمان‌بندی شد: id=${result.id} · ${result.at.toLocaleString()}`,
                        )
                    }

                    if (!isSameLocalDay(result.at, new Date())) {
                        console.info(
                            "[daily-reminder] ساعت امروز گذشته بود؛ اولین اعلان برای فردا در همان ساعت زمان‌بندی شد.",
                        )
                    }

                    return
                }

                console.error(
                    `[daily-reminder] زمان‌بندی ناموفق بود (تلاش ${attempt}/${NATIVE_SCHEDULE_MAX_ATTEMPTS}):`,
                    result.reason,
                    result.message,
                )

                if (result.reason !== "PERMISSION_PROMPT") return
                if (attempt === NATIVE_SCHEDULE_MAX_ATTEMPTS) return

                await wait(NATIVE_SCHEDULE_RETRY_DELAY_MS)
                if (disposed) return
            }
        }

        void scheduleWithRetry()

        return () => {
            disposed = true
            void cancelDailyReminder(scopeUserId)
        }
    }, [
        hydratedScope,
        scope,
        scopeUserId,
        nativePlatform,
        settings.reminderEnabled,
        settings.reminderTime,
    ])

    const update = useCallback((patch: Partial<Settings>) => {
        setSettings((previous) => ({
            ...previous,
            ...patch,
        }))
    }, [])

    const playBeep = useCallback(() => {
        if (settings.sound) {
            beep()
        }
    }, [settings.sound])

    const requestNotificationPermission =
        useCallback(async (): Promise<boolean> => {
            if (!("Notification" in window)) {
                return false
            }

            if (Notification.permission === "granted") {
                return true
            }

            const result =
                await Notification.requestPermission()

            return result === "granted"
        }, [])

    const value = useMemo(
        () => ({
            settings,
            update,
            playBeep,
            requestNotificationPermission,
        }),
        [settings, update, playBeep, requestNotificationPermission],
    )

    return (
        <SettingsContext.Provider value={value}>
            {children}
        </SettingsContext.Provider>
    )
}

export function useSettings() {
    const context = useContext(SettingsContext)

    if (!context) {
        throw new Error(
            "useSettings must be used inside SettingsProvider",
        )
    }

    return context
}
