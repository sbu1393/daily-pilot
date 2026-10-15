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
import {
    cancelNativeTaskAlarm,
    getTaskAlarmNativeStatus,
    isNativeTaskAlarmPlatform,
    isTaskAlarmBridgeAvailable,
    listNativeTaskAlarms,
    requestTaskAlarmExactPermission,
    requestTaskAlarmFullScreenPermission,
    requestTaskAlarmNotificationPermission,
    scheduleNativeTaskAlarm,
    type NativeTaskAlarmStatus,
    type TaskAlarmPermissionOutcome,
} from "@/app/lib/native/task-alarm"
import {
    findTaskAlarm,
    pruneTaskAlarms,
    readTaskAlarms,
    removeTaskAlarm as removeAlarmFromList,
    taskAlarmId,
    upsertTaskAlarm,
    validateTaskAlarmTime,
    writeTaskAlarms,
    type TaskAlarm,
} from "@/app/lib/taskAlarm"

/*
 * آلارم تسک — context و چرخه‌ی عمر
 * -----------------------------------------------------------------
 * این Provider **جدا از `ReminderProvider`** است و هیچ کاری با اعلان‌های یادآور
 * نمی‌کند. آلارم یک قابلیت مستقل است:
 *
 *  - زمان‌بندی واقعی در خودِ اندروید انجام می‌شود (`TaskAlarmPlugin`)، پس آلارم
 *    با اپ بسته، صفحه‌ی قفل، بی‌اینترنتی و بدون نشستِ ورود هم زنگ می‌زند.
 *  - این Provider فقط (۱) آینه‌ی localStorage برای نمایش UI است، (۲) دستور
 *    زمان‌بندی/لغو را می‌فرستد، و (۳) قابلیت‌های واقعی سیستم را برای کاربر
 *    شفاف می‌کند.
 *
 * «آینه» یعنی: هر جا localStorage و اندروید اختلاف داشته باشند، **اندروید
 * درست است** و در `syncFromNative` آشتی داده می‌شود (مثلاً بعد از تعویق از
 * صفحه‌ی آلارم یا بعد از reboot).
 *
 * در مرورگر هیچ آلارمی ساخته نمی‌شود و این صریح به کاربر گفته می‌شود؛ جایگزینِ
 * «صادقانه» این است که همان قابلیتِ یادآور (اعلان + بنر) را استفاده کند، نه
 * اینکه آلارمِ قلابی ساخته شود.
 */

/** نتیجه‌ی ثبت/حذف آلارم — رابط کاربری بر اساس آن راستی‌آزمایی می‌کند. */
export type TaskAlarmSetOutcome =
    | { ok: true; exact?: boolean }
    | { ok: false; reason: string; message: string }

type TaskAlarmContextType = {
    /** آیا localStorage خوانده شده است؟ */
    ready: boolean
    alarms: TaskAlarm[]
    getAlarm: (taskId: number) => TaskAlarm | undefined
    setAlarm: (task: { id: number; title: string }, at: number) => Promise<TaskAlarmSetOutcome>
    removeAlarm: (taskId: number) => Promise<TaskAlarmSetOutcome>
    /** `null` یعنی هنوز معلوم نیست و عمداً هیچ تصمیمی گرفته نمی‌شود. */
    nativePlatform: boolean | null
    /** آیا پلاگین آلارم در همین APK ثبت شده است؟ */
    bridgeAvailable: boolean
    /** وضعیت واقعی مجوزها/قابلیت‌های سیستم (از خودِ اندروید) */
    nativeStatus: NativeTaskAlarmStatus | null
    refreshNativeStatus: () => Promise<void>
    requestExactPermission: () => Promise<TaskAlarmPermissionOutcome>
    requestFullScreenPermission: () => Promise<TaskAlarmPermissionOutcome>
    requestNotificationPermission: () => Promise<TaskAlarmPermissionOutcome>
}

const TaskAlarmContext = createContext<TaskAlarmContextType | null>(null)

/** دسترسی امن به localStorage (حالت خصوصی مرورگر می‌تواند throw کند) */
function getStorage(): Storage | null {
    try {
        if (typeof window === "undefined") return null
        return window.localStorage
    } catch {
        return null
    }
}

export function TaskAlarmProvider({ children }: { children: React.ReactNode }) {
    const [alarms, setAlarms] = useState<TaskAlarm[]>([])
    const [ready, setReady] = useState(false)
    const [scopeUserId, setScopeUserId] = useState<number | null>(null)
    const [hydratedScope, setHydratedScope] = useState<string | null>(null)

    const [nativePlatform, setNativePlatform] = useState<boolean | null>(null)
    const [bridgeAvailable, setBridgeAvailable] = useState(false)
    const [nativeStatus, setNativeStatus] = useState<NativeTaskAlarmStatus | null>(null)

    /* منبع حقیقتِ همیشه‌به‌روز برای async (بدون closure کهنه) */
    const listRef = useRef<TaskAlarm[]>([])

    const applyList = useCallback((next: TaskAlarm[]) => {
        listRef.current = next
        setAlarms(next)
    }, [])

    /* 0) نشست جاری (scope) — مثل یادآورها */
    useEffect(() => {
        setScopeUserId(getOfflineUserId())

        const onScopeChange = () => setScopeUserId(getOfflineUserId())
        window.addEventListener(OFFLINE_SCOPE_EVENT, onScopeChange)

        return () => window.removeEventListener(OFFLINE_SCOPE_EVENT, onScopeChange)
    }, [])

    /* 1) تشخیص پلتفرم و «ثبت‌شدن پلاگین» — دو چیز جدا، بعد از mount */
    useEffect(() => {
        setNativePlatform(isNativeTaskAlarmPlatform())
        setBridgeAvailable(isTaskAlarmBridgeAvailable())
    }, [])

    /* 2) خواندن آینه‌ی محلی همان scope */
    useEffect(() => {
        const scope = scopeUserId == null ? "anon" : `u${scopeUserId}`
        applyList(readTaskAlarms(getStorage(), Date.now(), scopeUserId))
        setHydratedScope(scope)
        setReady(true)
    }, [applyList, scopeUserId])

    /* 3) ذخیره‌ی هر تغییر */
    useEffect(() => {
        if (!ready || hydratedScope == null) return
        writeTaskAlarms(getStorage(), alarms, scopeUserId)
    }, [ready, alarms, scopeUserId, hydratedScope])

    /**
     * آشتی‌دادن آینه با واقعیتِ اندروید.
     *
     * مرجع همیشه `getPending` نیتیو است:
     *  - آلارمی که در اندروید هست ولی اینجا نیست ⇒ اضافه می‌شود (مثلاً بعد از
     *    تعویق از صفحه‌ی آلارم، که کاملاً نیتیو اتفاق می‌افتد).
     *  - آلارمی که اینجا هست ولی در اندروید نیست ⇒ اگر در آینده باشد دوباره
     *    ثبت می‌شود (پوششِ پاک شدن ذخیره‌ی نیتیو)، وگرنه رها می‌شود.
     */
    const syncFromNative = useCallback(async () => {
        const listed = await listNativeTaskAlarms()
        if (!listed.ok) return

        const now = Date.now()
        const nativeByTask = new Map(listed.alarms.map((alarm) => [alarm.taskId, alarm]))
        const reconciled: TaskAlarm[] = []

        for (const alarm of listRef.current) {
            const native = nativeByTask.get(alarm.taskId)

            if (native) {
                /* زمانِ نیتیو مرجع است (مثلاً تعویقخورده). */
                nativeByTask.delete(alarm.taskId)
                reconciled.push({ ...alarm, title: native.title || alarm.title, at: native.at })
                continue
            }

            if (alarm.at > now) {
                const outcome = await scheduleNativeTaskAlarm({
                    id: taskAlarmId(alarm.taskId),
                    taskId: alarm.taskId,
                    title: alarm.title,
                    at: alarm.at,
                })
                if (outcome.ok) reconciled.push(alarm)
                continue
            }
            /* گذشته و در اندروید هم نیست ⇒ تمام‌شده؛ رهایش می‌کنیم. */
        }

        for (const native of nativeByTask.values()) {
            reconciled.push({
                taskId: native.taskId,
                title: native.title,
                at: native.at,
                createdAt: native.createdAt,
            })
        }

        applyList(pruneTaskAlarms(reconciled, now))
    }, [applyList])

    /** خواندن وضعیت واقعی سیستم + آشتی‌دادن */
    const refreshNativeStatus = useCallback(async () => {
        if (nativePlatform !== true) return

        const status = await getTaskAlarmNativeStatus()
        if (status.ok) {
            setNativeStatus({
                exactAlarm: status.exactAlarm,
                fullScreenIntent: status.fullScreenIntent,
                notifications: status.notifications,
                sdk: status.sdk,
            })
        }

        setBridgeAvailable(isTaskAlarmBridgeAvailable())
        await syncFromNative()
    }, [nativePlatform, syncFromNative])

    /*
     * 4) تازه‌سازی وقتی کاربر برمی‌گردد (مثلاً از صفحه‌ی «آلارم‌ها و یادآورها»)
     *    یا وقتی صفحه دوباره visible می‌شود. بدون هیچ تایمر دوره‌ای — آلارم به
     *    این تازه‌سازی وابسته نیست و این فقط برای صداقتِ UI است.
     */
    useEffect(() => {
        if (!ready || nativePlatform !== true) return

        void refreshNativeStatus()

        const refresh = () => void refreshNativeStatus()
        const onVisible = () => {
            if (document.visibilityState === "visible") refresh()
        }

        document.addEventListener("visibilitychange", onVisible)
        window.addEventListener("focus", refresh)

        return () => {
            document.removeEventListener("visibilitychange", onVisible)
            window.removeEventListener("focus", refresh)
        }
    }, [ready, nativePlatform, refreshNativeStatus])

    const getAlarm = useCallback((taskId: number) => findTaskAlarm(alarms, taskId), [alarms])

    const setAlarm = useCallback(
        async (task: { id: number; title: string }, at: number): Promise<TaskAlarmSetOutcome> => {
            const validation = validateTaskAlarmTime(at)
            if (!validation.ok) {
                return {
                    ok: false,
                    reason: "IN_THE_PAST",
                    message: "زمان آلارم باید جلوتر از الآن باشد.",
                }
            }

            if (nativePlatform !== true) {
                return {
                    ok: false,
                    reason: "NOT_NATIVE",
                    message: "آلارم واقعی فقط داخل اپ اندروید ثبت می‌شود.",
                }
            }

            const outcome = await scheduleNativeTaskAlarm({
                id: taskAlarmId(task.id),
                taskId: task.id,
                title: task.title,
                at,
            })

            if (!outcome.ok) {
                return { ok: false, reason: outcome.reason, message: outcome.message }
            }

            applyList(upsertTaskAlarm(listRef.current, task, at))

            return { ok: true, exact: outcome.exact }
        },
        [applyList, nativePlatform],
    )

    const removeAlarm = useCallback(
        async (taskId: number): Promise<TaskAlarmSetOutcome> => {
            if (nativePlatform === true) {
                const outcome = await cancelNativeTaskAlarm(taskAlarmId(taskId))

                if (!outcome.ok) {
                    /* لغو نشد ⇒ از لیست هم برنمی‌داریم تا UI دروغ نگوید. */
                    return { ok: false, reason: outcome.reason, message: outcome.message }
                }
            }

            applyList(removeAlarmFromList(listRef.current, taskId))

            return { ok: true }
        },
        [applyList, nativePlatform],
    )

    const requestExactPermission = useCallback(async () => {
        const outcome = await requestTaskAlarmExactPermission()
        await refreshNativeStatus()
        return outcome
    }, [refreshNativeStatus])

    const requestFullScreenPermission = useCallback(async () => {
        const outcome = await requestTaskAlarmFullScreenPermission()
        await refreshNativeStatus()
        return outcome
    }, [refreshNativeStatus])

    const requestNotificationPermission = useCallback(async () => {
        const outcome = await requestTaskAlarmNotificationPermission()
        await refreshNativeStatus()
        return outcome
    }, [refreshNativeStatus])

    const value = useMemo<TaskAlarmContextType>(
        () => ({
            ready,
            alarms,
            getAlarm,
            setAlarm,
            removeAlarm,
            nativePlatform,
            bridgeAvailable,
            nativeStatus,
            refreshNativeStatus,
            requestExactPermission,
            requestFullScreenPermission,
            requestNotificationPermission,
        }),
        [
            ready,
            alarms,
            getAlarm,
            setAlarm,
            removeAlarm,
            nativePlatform,
            bridgeAvailable,
            nativeStatus,
            refreshNativeStatus,
            requestExactPermission,
            requestFullScreenPermission,
            requestNotificationPermission,
        ],
    )

    return <TaskAlarmContext.Provider value={value}>{children}</TaskAlarmContext.Provider>
}

export function useTaskAlarms() {
    const context = useContext(TaskAlarmContext)

    if (!context) {
        throw new Error("useTaskAlarms must be used inside TaskAlarmProvider")
    }

    return context
}
