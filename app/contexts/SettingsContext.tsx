"use client"

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"

export type ThemePreference = "light" | "dark" | "system"

export type Settings = {
    theme: ThemePreference
    sound: boolean
    reminderEnabled: boolean
    reminderTime: string // "HH:MM" به وقت محلی
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
    if (typeof window === "undefined") return DEFAULT_SETTINGS
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY)
        if (!raw) return DEFAULT_SETTINGS
        return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
    } catch {
        return DEFAULT_SETTINGS
    }
}

function resolveTheme(pref: ThemePreference): "light" | "dark" {
    if (pref === "system") {
        return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light"
    }
    return pref
}

function applyTheme(pref: ThemePreference) {
    const theme = resolveTheme(pref)
    document.documentElement.setAttribute("data-theme", theme)
}

// بوق کوتاه و لطیف با Web Audio — بدون نیاز به فایل صوتی
function beep() {
    try {
        const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        const ctx = new Ctx()
        const now = ctx.currentTime

        const play = (freq: number, start: number, dur: number) => {
            const osc = ctx.createOscillator()
            const gain = ctx.createGain()
            osc.type = "sine"
            osc.frequency.value = freq
            gain.gain.setValueAtTime(0.0001, start)
            gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02)
            gain.gain.exponentialRampToValueAtTime(0.0001, start + dur)
            osc.connect(gain).connect(ctx.destination)
            osc.start(start)
            osc.stop(start + dur + 0.05)
        }

        play(660, now, 0.18)
        play(880, now + 0.16, 0.28)
        setTimeout(() => ctx.close().catch(() => undefined), 900)
    } catch {
        /* بی‌صدا در مرورگرهای قدیمی */
    }
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
    const [settings, setSettings] = useState<Settings>(loadSettings)
    const firedRef = useRef<string | null>(null)

    // اعمال تم روی <html> + ذخیره‌سازی
    useEffect(() => {
        applyTheme(settings.theme)
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
        } catch { /* ذخیره‌سازی غیرفعال */ }
    }, [settings])

    // دنبال کردن تغییر تم سیستم وقتی حالت «سیستم» انتخاب شده
    useEffect(() => {
        if (settings.theme !== "system") return
        const mq = window.matchMedia("(prefers-color-scheme: dark)")
        const handler = () => applyTheme("system")
        mq.addEventListener("change", handler)
        return () => mq.removeEventListener("change", handler)
    }, [settings.theme])

    // یادآور: هر ۲۰ ثانیه بررسی می‌کند ساعت به زمان تعیین‌شده رسیده یا نه
    useEffect(() => {
        if (!settings.reminderEnabled) return

        const check = () => {
            const now = new Date()
            const hh = String(now.getHours()).padStart(2, "0")
            const mm = String(now.getMinutes()).padStart(2, "0")
            const key = `${hh}:${mm}`
            if (key !== settings.reminderTime) return

            // فقط یک بار در هر دقیقه
            const todayKey = new Date().toDateString()
            const fired = `${todayKey}|${key}`
            if (firedRef.current === fired) return
            firedRef.current = fired
            try {
                window.localStorage.setItem(REMINDER_KEYS_FIRED, fired)
            } catch { /* ignore */ }

            if (settings.sound) beep()

            if ("Notification" in window && Notification.permission === "granted") {
                new Notification("یادآور Daily Pilot", {
                    body: "وقت برنامه‌ریزی روزت رسیده است ✨",
                })
            }
        }

        // اگر تب باز بوده و دقیقه‌ی یادآور رد شده، از آخرین حالت ذخیره‌شده رد نشویم
        try {
            firedRef.current = window.localStorage.getItem(REMINDER_KEYS_FIRED)
        } catch { /* ignore */ }

        const id = window.setInterval(check, 20_000)
        return () => window.clearInterval(id)
    }, [settings.reminderEnabled, settings.reminderTime, settings.sound])

    const update = useCallback((patch: Partial<Settings>) => {
        setSettings((prev) => ({ ...prev, ...patch }))
    }, [])

    const playBeep = useCallback(() => {
        if (settings.sound) beep()
    }, [settings.sound])

    const requestNotificationPermission = useCallback(async () => {
        if (!("Notification" in window)) return false
        if (Notification.permission === "granted") return true
        const result = await Notification.requestPermission()
        return result === "granted"
    }, [])

    return (
        <SettingsContext.Provider value={{ settings, update, playBeep, requestNotificationPermission }}>
            {children}
        </SettingsContext.Provider>
    )
}

export function useSettings() {
    const context = useContext(SettingsContext)
    if (!context) throw new Error("useSettings must be used inside SettingsProvider")
    return context
}