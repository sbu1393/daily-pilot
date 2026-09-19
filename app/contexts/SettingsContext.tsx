"use client"

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
} from "react"

export type ThemePreference = "light" | "dark" | "system"

export type Settings = {
    theme: ThemePreference
    sound: boolean
    reminderEnabled: boolean
    reminderTime: string
}

export const DEFAULT_SETTINGS: Settings = {
    theme: "system",
    sound: true,
    reminderEnabled: false,
    reminderTime: "09:00",
}

const STORAGE_KEY = "dp:settings"
const REMINDER_KEYS_FIRED = "dp:reminder-fired"

type SettingsContextType = {
    settings: Settings
    update: (patch: Partial<Settings>) => void
    playBeep: () => void
    requestNotificationPermission: () => Promise<boolean>
}

const SettingsContext = createContext<SettingsContextType | null>(null)

function loadSettings(): Settings {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY)

        if (!raw) {
            return DEFAULT_SETTINGS
        }

        const saved = JSON.parse(raw) as Partial<Settings>

        return {
            ...DEFAULT_SETTINGS,
            ...saved,
        }
    } catch {
        return DEFAULT_SETTINGS
    }
}

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
     * سرور و اولین رندر مرورگر باید دقیقاً مقدار یکسانی داشته باشند.
     * بنابراین اینجا مستقیماً localStorage را نمی‌خوانیم.
     */
    const [settings, setSettings] =
        useState<Settings>(DEFAULT_SETTINGS)

    /*
     * مشخص می‌کند خواندن localStorage تمام شده است.
     * این متغیر مانع بازنویسی زودهنگام تنظیمات ذخیره‌شده می‌شود.
     */
    const [settingsLoaded, setSettingsLoaded] = useState(false)

    const firedRef = useRef<string | null>(null)

    // تنظیمات فقط پس از mount از localStorage خوانده می‌شوند.
    useEffect(() => {
        const savedSettings = loadSettings()

        setSettings(savedSettings)
        setSettingsLoaded(true)
    }, [])

    // پس از بارگذاری تنظیمات، تم را اعمال و تغییرات را ذخیره می‌کنیم.
    useEffect(() => {
        if (!settingsLoaded) {
            return
        }

        applyTheme(settings.theme)

        try {
            window.localStorage.setItem(
                STORAGE_KEY,
                JSON.stringify(settings),
            )
        } catch {
            // localStorage در دسترس نیست.
        }
    }, [settings, settingsLoaded])

    // دنبال کردن تغییر تم سیستم در حالت system
    useEffect(() => {
        if (!settingsLoaded || settings.theme !== "system") {
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
    }, [settings.theme, settingsLoaded])

    // یادآور
    useEffect(() => {
        if (!settingsLoaded || !settings.reminderEnabled) {
            return
        }

        const check = () => {
            const now = new Date()
            const hours = String(now.getHours()).padStart(2, "0")
            const minutes = String(now.getMinutes()).padStart(2, "0")
            const timeKey = `${hours}:${minutes}`

            if (timeKey !== settings.reminderTime) {
                return
            }

            const dateStamp = now.toDateString()
            const firedKey = `${dateStamp}|${timeKey}`

            if (firedRef.current === firedKey) {
                return
            }

            firedRef.current = firedKey

            try {
                window.localStorage.setItem(
                    REMINDER_KEYS_FIRED,
                    firedKey,
                )
            } catch {
                // localStorage در دسترس نیست.
            }

            if (settings.sound) {
                beep()
            }

            if (
                "Notification" in window &&
                Notification.permission === "granted"
            ) {
                new Notification("یادآور روزساز", {
                    body: "وقت برنامه‌ریزی روزت رسیده است ✨",
                })
            }
        }

        try {
            firedRef.current = window.localStorage.getItem(
                REMINDER_KEYS_FIRED,
            )
        } catch {
            // localStorage در دسترس نیست.
        }

        // همان ابتدا نیز بررسی شود؛ لازم نیست ۲۰ ثانیه صبر کند.
        check()

        const intervalId = window.setInterval(check, 20_000)

        return () => {
            window.clearInterval(intervalId)
        }
    }, [
        settingsLoaded,
        settings.reminderEnabled,
        settings.reminderTime,
        settings.sound,
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

    return (
        <SettingsContext.Provider
            value={{
                settings,
                update,
                playBeep,
                requestNotificationPermission,
            }}
        >
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
