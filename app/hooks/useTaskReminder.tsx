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
import { getOfflineUserId, OFFLINE_SCOPE_EVENT } from "@/app/lib/offline"
import {
    isNativeLocalNotificationPlatform,
    requestLocalNotificationPermission,
} from "@/app/lib/native/local-notifications"
import {
    authorizeTaskReminder,
    cancelTaskReminder,
    cancelTaskReminders,
    scheduleTaskReminder,
    type TaskReminderAuthorizeOutcome,
} from "@/app/lib/native/task-reminder"
import ReminderAlarmBanner from "@/app/components/task/ReminderAlarmBanner"
import {
    clearLegacyRemindersKey,
    markDueReminders,
    readReminders,
    removeReminder,
    upsertReminder,
    writeReminders,
    REMINDER_TICK_MS,
    type TaskReminder,
} from "@/app/lib/taskReminder"

/*
 * یادآوری تسک — «تنظیم زمان» با آلارم صوتی.
 *
 * ## دو مسیر تحویل، یک منبع حقیقت
 * --------------------------------
 * لیست یادآورها (localStorage، کلیدِ user-scoped) **تنها** منبع حقیقت است و
 * همان است که هر دو مسیر از آن می‌خوانند:
 *
 *  - **مرورگر** — دقیقاً رفتار قبلی: تایمر ۵ ثانیه‌ای، بنر درون‌برنامه‌ای، بوق و
 *    snooze. دست‌نخورده.
 *  - **Android native** — یک effect واکنشی روی همین لیست، هر یادآورِ
 *    «هنوز fired نشده» را با `scheduleTaskReminder` می‌دهد به سیستم‌عامل؛ پس
 *    حتی با اپ بسته و اینترنت خاموش هم اعلان می‌رسد.
 *
 * چرا فقط یک جا زمان‌بندی می‌کند؟ اگر هم `setReminder` و هم effect زمان‌بندی
 * می‌کردند، هر ثبت دو بار از پل عبور می‌کرد. با شناسه‌ی قطعی duplicate ساخته
 * نمی‌شد، ولی کار بی‌جهت و شکننده می‌شد.
 *
 * ## بدون اعلان تکراری
 * --------------------
 * روی native، لایه‌ی مرورگری (بنر + بوق) کلاً اجرا نمی‌شود؛ اعلان سیستم‌عامل
 * تنها راه تحویل است. تا وقتی پلتفرم قطعی نشده (`null`) هر دو لایه بسته‌اند تا
 * پنجره‌ی هم‌پوشانی باز نشود — همان قاعده‌ی `SettingsContext`.
 *
 * ## چرخه‌ی عمر
 * -------------
 * ثبت/تغییر ⇒ effect زمان‌بندی می‌کند (همان شناسه ⇒ جایگزینی، نه duplicate) ·
 * حذف یادآور / حذف تسک / انجام تسک / تعویض کاربر ⇒ لغو. چون لیست
 * user-scoped است، تعویض نشست هم لیست را عوض می‌کند هم اعلان‌های کاربر قبلی را
 * لغو می‌کند.
 */

type ReminderContextType = {
    /** آیا localStorage خوانده شده است؟ (قبل از آن هیچ یادآوری نمایش داده نمی‌شود) */
    ready: boolean
    reminders: TaskReminder[]
    getReminder: (taskId: number) => TaskReminder | undefined
    setReminder: (task: { id: number; title: string }, dueAt: number) => Promise<ReminderSetOutcome>
    removeTaskReminder: (taskId: number) => Promise<void>
    snoozeReminder: (alarm: TaskReminder, minutes: number) => void
    /** آلارم‌هایی که همین حالا در حال پخش هستند */
    activeAlarms: TaskReminder[]
    stopAlarm: (taskId?: number) => void
}

/** نتیجه‌ی ثبت یادآور — رابط کاربری بر اساس آن راستی‌آزمایی می‌کند. */
export type ReminderSetOutcome =
    | { ok: true }
    | { ok: false; reason: string; message: string }

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

    /* یادآورها از کدام نشست خوانده شده‌اند (`u<id>` یا `anon`) */
    const [scopeUserId, setScopeUserId] = useState<number | null>(null)
    const [hydratedScope, setHydratedScope] = useState<string | null>(null)

    /*
     * آیا داخل پوسته‌ی نیتیو هستیم؟ `null` یعنی هنوز معلوم نیست و عمداً مبهم
     * می‌ماند تا هیچ تصمیمی درباره‌ی delivery روی رندر اول گرفته نشود.
     */
    const [nativePlatform, setNativePlatform] = useState<boolean | null>(null)

    // منبع حقیقتِ همیشه‌به‌روز برای منطق تایمر (بدون وابستگی به closure کهنه)
    const listRef = useRef<TaskReminder[]>([])

    /* taskIdهایی که همین حالا اعلان نیتیوِ زمان‌بندی‌شده دارند */
    const scheduledNativeRef = useRef<Set<number>>(new Set())

    const applyList = useCallback((next: TaskReminder[]) => {
        listRef.current = next
        setReminders(next)
    }, [])

    // 0) نشست + پاک‌سازی کلیدِ قدیمیِ بدون scope (خروج/ورود)
    useEffect(() => {
        const userId = getOfflineUserId()
        if (userId != null) {
            clearLegacyRemindersKey(getStorage())
        }
        setScopeUserId(userId)

        const onScopeChange = () => setScopeUserId(getOfflineUserId())
        window.addEventListener(OFFLINE_SCOPE_EVENT, onScopeChange)

        return () => {
            window.removeEventListener(OFFLINE_SCOPE_EVENT, onScopeChange)
        }
    }, [])

    // 1) تشخیص پلتفرم — فقط بعد از mount
    useEffect(() => {
        setNativePlatform(isNativeLocalNotificationPlatform())
    }, [])

    // 2) خواندن یادآورهای همان scope — فقط بعد از mount (بدون خطای hydration)
    useEffect(() => {
        const scope = scopeUserId == null ? "anon" : `u${scopeUserId}`
        applyList(readReminders(getStorage(), Date.now(), scopeUserId))
        setHydratedScope(scope)
        setReady(true)
    }, [applyList, scopeUserId])

    // 3) ذخیره‌ی هر تغییر — فقط وقتی به scope جاری تعلق دارد
    useEffect(() => {
        if (!ready || hydratedScope == null) return
        writeReminders(getStorage(), reminders, scopeUserId)
    }, [ready, reminders, scopeUserId, hydratedScope])

    /*
     * 4) Android native — زمان‌بندی/لغو واکنشی.
     *
     * تنها جایی که `scheduleTaskReminder` صدا زده می‌شود. هر یادآورِ «هنوز
     * fired نشده» زمان‌بندی می‌شود و هر چیزی که دیگر در لیست نیست لغو می‌شود.
     * چون شناسه قطعی است، «تغییر زمان» اعلان قبلی را جایگزین می‌کند.
     */
    useEffect(() => {
        if (hydratedScope == null || !nativePlatform) return

        let disposed = false

        const wanted = new Set<number>()
        for (const reminder of reminders) {
            if (reminder.firedAt === null) wanted.add(reminder.taskId)
        }

        const stale = Array.from(scheduledNativeRef.current).filter((taskId) => !wanted.has(taskId))
        for (const taskId of stale) {
            scheduledNativeRef.current.delete(taskId)
        }

        const run = async () => {
            for (const taskId of stale) {
                await cancelTaskReminder(taskId)
                if (disposed) return
            }

            for (const reminder of reminders) {
                if (reminder.firedAt !== null) continue

                const result = await scheduleTaskReminder({
                    taskId: reminder.taskId,
                    title: reminder.title,
                    dueAt: reminder.dueAt,
                })
                if (disposed) return

                if (result.ok) {
                    scheduledNativeRef.current.add(reminder.taskId)

                    if (result.warning) {
                        console.warn(
                            `[task-reminder] اعلان تسک «${reminder.title}» زمان‌بندی شد ولی هشدار دارد:`,
                            result.warning,
                        )
                    } else {
                        console.info(
                            `[task-reminder] اعلان تسک «${reminder.title}» زمان‌بندی شد: id=${result.id} · ${result.at.toLocaleString()}`,
                        )
                    }
                } else {
                    scheduledNativeRef.current.delete(reminder.taskId)
                    console.error(
                        `[task-reminder] زمان‌بندی تسک «${reminder.title}» ناموفق بود:`,
                        result.reason,
                        result.message,
                    )
                }
            }
        }

        void run()
    }, [reminders, nativePlatform, hydratedScope])

    /*
     * 5) تعویض نشست — اعلان‌های کاربر قبلی نباید باقی بمانند و به حساب جدید
     * نسبت داده شوند. لیست هم user-scoped است، پس هر دو با هم پاک می‌شوند.
     */
    useEffect(() => {
        if (!nativePlatform) return

        const previous = Array.from(scheduledNativeRef.current)
        if (previous.length === 0) return

        scheduledNativeRef.current = new Set()
        void cancelTaskReminders(previous)
    }, [scopeUserId, nativePlatform])

    // 6) رسیدن زمان → علامت‌گذاری (+ بنر/بوق فقط در مرورگر)
    const check = useCallback(() => {
        const result = markDueReminders(listRef.current, Date.now())

        if (result.newlyFired.length === 0) return

        applyList(result.list)

        /*
         * روی native اعلان سیستم‌عامل خودش را رسانده است؛ بنر و بوق درون‌برنامه‌ای
         * همان لحظه تکرار همان اعلان‌اند، پس کلاً اجرا نمی‌شوند.
         */
        if (nativePlatform === false) {
            if (result.ring) playBeep()
            setActiveAlarms((prev) => [...prev, ...result.newlyFired])
        }
    }, [applyList, playBeep, nativePlatform])

    useEffect(() => {
        if (!ready) return
        if (nativePlatform !== false) return

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
    }, [ready, check, nativePlatform])

    // 7) تکرار زنگ تا وقتی آلارمِ فعالی هست (فقط مرورگر)
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
        async (task: { id: number; title: string }, dueAt: number): Promise<ReminderSetOutcome> => {
            /*
             * مرورگر — دقیقاً رفتار قبلی، بدون هیچ دروازه‌ی اضافه.
             */
            if (nativePlatform !== true) {
                applyList(upsertReminder(listRef.current, task, dueAt))
                setActiveAlarms((prev) => prev.filter((a) => a.taskId !== task.id))
                return { ok: true }
            }

            /*
             * Android native — مجوز پیش از ذخیره/زمان‌بندی. اگر مجوز داده نشود،
             * اصلاً ثبت نمی‌کنیم تا UI وانمود نکند که یادآور نیتیو ساخته شده است.
             */
            const outcome: TaskReminderAuthorizeOutcome = await authorizeTaskReminder({
                taskId: task.id,
                dueAt,
                requestPermission: requestLocalNotificationPermission,
            })

            if (!outcome.ok) {
                return { ok: false, reason: outcome.reason, message: outcome.message }
            }

            applyList(upsertReminder(listRef.current, task, dueAt))
            setActiveAlarms((prev) => prev.filter((a) => a.taskId !== task.id))

            return { ok: true }
        },
        [applyList, nativePlatform],
    )

    const removeTaskReminder = useCallback(async (taskId: number) => {
        applyList(removeReminder(listRef.current, taskId))
        setActiveAlarms((prev) => prev.filter((a) => a.taskId !== taskId))

        if (nativePlatform !== true) return

        /* لغو اعلان نیتیو با همان شناسه‌ی قطعی — اپ بسته هم باشد اثر دارد. */
        scheduledNativeRef.current.delete(taskId)

        const result = await cancelTaskReminder(taskId)
        if (!result.ok) {
            console.error("[task-reminder] لغو اعلان تسک ناموفق بود:", result.reason, result.message)
        }
    }, [applyList, nativePlatform])

    const snoozeReminder = useCallback((alarm: TaskReminder, minutes: number) => {
        void setReminder(
            { id: alarm.taskId, title: alarm.title },
            Date.now() + minutes * 60_000,
        )
    }, [setReminder])

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
