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
import { useCalendar } from "@/app/contexts/CalenderContext"
import { useSettings } from "@/app/contexts/SettingsContext"
import ReminderAlarmBanner from "@/app/components/task/ReminderAlarmBanner"
import {
    markDueReminders,
    readReminders,
    removeReminder,
    upsertReminder,
    writeReminders,
    REMINDER_TICK_MS,
    type TaskReminder,
} from "@/app/lib/taskReminder"

/**
 * یادآوری تسک‌ها — «تنظیم زمان» با آلارم صوتی.
 *
 * معماری (کاملاً additive):
 * - منبع داده فقط `localStorage` است (`dp:task-reminders`)؛ هیچ ستون/جدول/route‌ای
 *   اضافه یا تغییر نکرده و قرارداد API دست‌نخورده است.
 * - این Provider فقط یک تایمر و یک لایه‌ی هشدار است؛ هیچ‌کدام از جریان‌های موجود
 *   تسک (ساخت/ویرایش/انجام/حذف/فیلتر) را لمس نمی‌کند.
 * - صدا از همان `playBeep` موجود در SettingsContext می‌آید تا تنظیم «صدا»
 *   در تنظیمات کاربر محترم بماند و کد صوتی تکراری ساخته نشود.
 */

type ReminderContextType = {
    /** آیا localStorage خوانده شده است؟ (قبل از آن هیچ یادآوری‌ای نمایش داده نمی‌شود) */
    ready: boolean
    reminders: TaskReminder[]
    getReminder: (taskId: number) => TaskReminder | undefined
    setReminder: (task: { id: number; title: string }, dueAt: number) => void
    removeTaskReminder: (taskId: number) => void
    snoozeReminder: (alarm: TaskReminder, minutes: number) => void
    /** آلارم‌هایی که همین حالا در حال پخش هستند */
    activeAlarms: TaskReminder[]
    stopAlarm: (taskId?: number) => void
}

const ReminderContext = createContext<ReminderContextType | null>(null)

/** دسترسی امن به localStorage (حالت خصوصی مرورگر می‌تواند throw کند) */
function getStorage(): Storage | null {
    try {
        if (typeof window === "undefined") return null
        return window.localStorage
    } catch {
        return null
    }
}

/** فاصله‌ی تکرار زنگ آلارم */
const ALARM_RING_INTERVAL_MS = 1600

export function ReminderProvider({ children }: { children: React.ReactNode }) {
    const { timezone } = useCalendar()
    const { playBeep } = useSettings()

    const [reminders, setReminders] = useState<TaskReminder[]>([])
    const [ready, setReady] = useState(false)
    const [activeAlarms, setActiveAlarms] = useState<TaskReminder[]>([])

    // منبع حقیقتِ همیشه‌به‌روز برای منطق تایمر (بدون وابستگی به closure کهنه)
    const listRef = useRef<TaskReminder[]>([])

    const applyList = useCallback((next: TaskReminder[]) => {
        listRef.current = next
        setReminders(next)
    }, [])

    // ۱) خواندن از localStorage فقط بعد از mount (هم‌الگو با SettingsProvider؛
    //    رندر سرور و اولین رندر مرورگر یکسان می‌مانند → بدون خطای hydration)
    useEffect(() => {
        applyList(readReminders(getStorage()))
        setReady(true)
    }, [applyList])

    // ۲) ذخیره‌ی هر تغییر
    useEffect(() => {
        if (!ready) return
        writeReminders(getStorage(), reminders)
    }, [ready, reminders])

    // ۳) رسیدن زمان → علامت‌گذاری + صدا + نمایش هشدار
    const check = useCallback(() => {
        const result = markDueReminders(listRef.current, Date.now())

        if (result.newlyFired.length === 0) return

        applyList(result.list)

        if (result.ring) playBeep()

        setActiveAlarms((prev) => [...prev, ...result.newlyFired])
    }, [applyList, playBeep])

    useEffect(() => {
        if (!ready) return

        check() // همان لحظه‌ی بارگذاری (بدون انتظار یک تیک)

        const id = window.setInterval(check, REMINDER_TICK_MS)

        // تب پس‌زمینه تایمر را throttle می‌کند؛ برگشتن به صفحه فوراً بررسی می‌شود
        const onVisible = () => {
            if (document.visibilityState === "visible") check()
        }
        document.addEventListener("visibilitychange", onVisible)

        return () => {
            window.clearInterval(id)
            document.removeEventListener("visibilitychange", onVisible)
        }
    }, [ready, check])

    // ۴) تکرار زنگ تا وقتی آلارمِ فعالی هست
    useEffect(() => {
        if (activeAlarms.length === 0) return

        playBeep()
        const id = window.setInterval(() => playBeep(), ALARM_RING_INTERVAL_MS)

        return () => window.clearInterval(id)
    }, [activeAlarms.length, playBeep])

    const reminderMap = useMemo(() => {
        const map = new Map<number, TaskReminder>()
        for (const r of reminders) map.set(r.taskId, r)
        return map
    }, [reminders])

    const getReminder = useCallback((taskId: number) => reminderMap.get(taskId), [reminderMap])

    const setReminder = useCallback(
        (task: { id: number; title: string }, dueAt: number) => {
            applyList(upsertReminder(listRef.current, task, dueAt))
            // یادآوری تازه → هر آلارمِ بازِ همان تسک بسته می‌شود
            setActiveAlarms((prev) => prev.filter((a) => a.taskId !== task.id))
        },
        [applyList],
    )

    const removeTaskReminder = useCallback(
        (taskId: number) => {
            applyList(removeReminder(listRef.current, taskId))
            setActiveAlarms((prev) => prev.filter((a) => a.taskId !== taskId))
        },
        [applyList],
    )

    const snoozeReminder = useCallback(
        (alarm: TaskReminder, minutes: number) => {
            setReminder({ id: alarm.taskId, title: alarm.title }, Date.now() + minutes * 60_000)
        },
        [setReminder],
    )

    const stopAlarm = useCallback((taskId?: number) => {
        setActiveAlarms((prev) => (taskId == null ? [] : prev.filter((a) => a.taskId !== taskId)))
    }, [])

    const value = useMemo<ReminderContextType>(
        () => ({
            ready,
            reminders,
            getReminder,
            setReminder,
            removeTaskReminder,
            snoozeReminder,
            activeAlarms,
            stopAlarm,
        }),
        [
            ready,
            reminders,
            getReminder,
            setReminder,
            removeTaskReminder,
            snoozeReminder,
            activeAlarms,
            stopAlarm,
        ],
    )

    return (
        <ReminderContext.Provider value={value}>
            {children}
            <ReminderAlarmBanner
                alarms={activeAlarms}
                timezone={timezone}
                onDismiss={stopAlarm}
                onSnooze={snoozeReminder}
            />
        </ReminderContext.Provider>
    )
}

export function useTaskReminders() {
    const context = useContext(ReminderContext)

    if (!context) {
        throw new Error("useTaskReminders must be used inside ReminderProvider")
    }

    return context
}
