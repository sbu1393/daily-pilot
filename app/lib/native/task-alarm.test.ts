import { afterEach, describe, expect, it, vi } from "vitest"

import {
    cancelNativeTaskAlarm,
    getTaskAlarmNativeStatus,
    isNativeTaskAlarmPlatform,
    isTaskAlarmBridgeAvailable,
    listNativeTaskAlarms,
    scheduleNativeTaskAlarm,
    TASK_ALARM_PLUGIN_NAME,
} from "@/app/lib/native/task-alarm"

/*
 * پل آلارم نیتیو (`TaskAlarm`) — قراردادها
 * ---------------------------------------
 * محیط تست node است (بدون window)، پس سه حالت پوشش داده می‌شود:
 *  ۱) بدون window ⇒ NOT_NATIVE (مرورگر/SSR)؛
 *  ۲) window نیتیو بدون پلاگین ⇒ PLUGIN_UNAVAILABLE (تفکیکِ «ثبت‌نشدن پلاگین»
 *     از «نیتیو نبودن» — همان چیزی که گزارش PoC باید نشان بدهد)؛
 *  ۳) پل ساختگی ⇒ موفقیت‌ها با همان شکل واقعی (`exact` صریح، لیست آلارم‌ها).
 *
 * صدا/صفحه‌ی تمام‌عرض/بازیابی پس از reboot فقط روی دستگاه اثبات می‌شوند؛ اینجا
 * فقط قرارداد JS↔پل قفل می‌شود تا رگرسیونِ «آلارمِ قلابیِ همیشه-موفق» ممکن نباشد.
 */

function setWindow(cap: unknown) {
    ;(globalThis as Record<string, unknown>).window = { Capacitor: cap }
}

afterEach(() => {
    delete (globalThis as Record<string, unknown>).window
    vi.unstubAllGlobals()
})

describe("isNativeTaskAlarmPlatform", () => {
    it("بدون window ⇒ false", () => {
        expect(isNativeTaskAlarmPlatform()).toBe(false)
    })

    it("window نیتیو ⇒ true", () => {
        setWindow({ isNativePlatform: () => true, Plugins: {} })
        expect(isNativeTaskAlarmPlatform()).toBe(true)
    })

    it("window مرورگر ⇒ false", () => {
        setWindow({ isNativePlatform: () => false, Plugins: {} })
        expect(isNativeTaskAlarmPlatform()).toBe(false)
    })
})

describe("resolveBridge", () => {
    it("بدون window ⇒ NOT_NATIVE و هرگز به پل نمی‌رسد", async () => {
        const status = await getTaskAlarmNativeStatus()
        expect(status.ok).toBe(false)
        if (status.ok) throw new Error("انتظار NOT_NATIVE داشتیم")
        expect(status.reason).toBe("NOT_NATIVE")

        const scheduled = await scheduleNativeTaskAlarm({ id: 1, taskId: 2, title: "t", at: 1 })
        expect(scheduled.ok).toBe(false)
        if (scheduled.ok) throw new Error("انتظار NOT_NATIVE داشتیم")
        expect(scheduled.reason).toBe("NOT_NATIVE")
    })

    it("نیتیو ولی بدون پلاگین ⇒ PLUGIN_UNAVAILABLE (نه NOT_NATIVE)", async () => {
        setWindow({ isNativePlatform: () => true, Plugins: {} })

        expect(isTaskAlarmBridgeAvailable()).toBe(false)

        const status = await getTaskAlarmNativeStatus()
        expect(status.ok).toBe(false)
        if (status.ok) throw new Error("انتظار PLUGIN_UNAVAILABLE داشتیم")
        expect(status.reason).toBe("PLUGIN_UNAVAILABLE")
    })

    it("isPluginAvailable=true ولی Plugins خالی ⇒ هنوز در دسترس نیست", () => {
        setWindow({ isNativePlatform: () => true, isPluginAvailable: () => false, Plugins: {} })
        expect(isTaskAlarmBridgeAvailable()).toBe(false)
    })
})

describe("با پل ساختگی", () => {
    function setFakeBridge() {
        const bridge = {
            getStatus: async () => ({
                exactAlarm: true,
                fullScreenIntent: true,
                notifications: true,
                sdk: 34,
            }),
            schedule: async (input: { id: number; at: number }) => ({
                exactAlarm: true,
                fullScreenIntent: true,
                notifications: true,
                sdk: 34,
                id: input.id,
                at: input.at,
                exact: true,
            }),
            cancel: async () => undefined,
            getPending: async () => ({
                alarms: [{ id: 9, taskId: 3, title: "کار", at: 123, createdAt: 100 }],
                exactAlarm: true,
            }),
        }

        setWindow({
            isNativePlatform: () => true,
            isPluginAvailable: (name: string) => name === TASK_ALARM_PLUGIN_NAME,
            Plugins: { [TASK_ALARM_PLUGIN_NAME]: bridge },
        })

        return bridge
    }

    it("وضعیت واقعی گزارش می‌شود (exact صریح)", async () => {
        setFakeBridge()

        const status = await getTaskAlarmNativeStatus()
        expect(status).toMatchObject({
            ok: true,
            exactAlarm: true,
            fullScreenIntent: true,
            notifications: true,
            sdk: 34,
        })
    })

    it("schedule موفق ⇒ exact برمی‌گردد و throw نمی‌کند", async () => {
        setFakeBridge()

        const outcome = await scheduleNativeTaskAlarm({ id: 9, taskId: 3, title: "کار", at: 999 })
        expect(outcome).toEqual({ ok: true, id: 9, at: 999, exact: true })
    })

    it("مسیر غیردقیق هم صادقانه گزارش می‌شود (exact=false)", async () => {
        const bridge = setFakeBridge()
        bridge.schedule = async (input: { id: number; at: number }) => ({
            exactAlarm: false,
            fullScreenIntent: true,
            notifications: true,
            sdk: 34,
            id: input.id,
            at: input.at,
            exact: false,
        })

        const outcome = await scheduleNativeTaskAlarm({ id: 9, taskId: 3, title: "کار", at: 999 })
        expect(outcome).toEqual({ ok: true, id: 9, at: 999, exact: false })
    })

    it("لغو و فهرست نیتیو کار می‌کنند", async () => {
        setFakeBridge()

        await expect(cancelNativeTaskAlarm(9)).resolves.toEqual({ ok: true })

        const listed = await listNativeTaskAlarms()
        expect(listed.ok).toBe(true)
        if (!listed.ok) throw new Error("انتظار موفقیت داشتیم")
        expect(listed.alarms).toHaveLength(1)
        expect(listed.exactAlarm).toBe(true)
    })

    it("خطای نیتیوِ IN_THE_PAST به reason ساختاریافته تبدیل می‌شود", async () => {
        const bridge = setFakeBridge()
        bridge.schedule = async () => {
            throw new Error("IN_THE_PAST: زمان آلارم گذشته است")
        }

        const outcome = await scheduleNativeTaskAlarm({ id: 9, taskId: 3, title: "کار", at: 1 })
        expect(outcome.ok).toBe(false)
        if (outcome.ok) throw new Error("انتظار شکست داشتیم")
        expect(outcome.reason).toBe("IN_THE_PAST")
    })
})
