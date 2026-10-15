import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
    scheduleLocalReminder,
    SCHEDULE_UNRESOLVED_WARN_MS,
} from "@/app/lib/native/local-notifications"
import { clearNativeDiagnostics, getNativeDiagnostics } from "@/app/lib/native/diagnostics"

/*
 * گزارش تشخیصی در scope ماژول نگه‌داری می‌شود، پس اگر بین تست‌ها پاک نشود،
 * رویدادهای تست قبلی روی ادعاهای این تست سوار می‌شوند. پاک‌کردن در
 * `beforeEach` همان چیزی است که روی دستگاه هم کاربر با دکمه‌ی «پاک‌کردن گزارش»
 * انجام می‌دهد.
 */

/*
 * دروازه‌ی آلارم دقیق در `scheduleLocalReminder()`
 * ----------------------------------------------
 * این تست دقیقاً همان چیزی را قفل می‌کند که روی دستگاه اعلان را از کار انداخته
 * بود: پلاگین Capacitor با `isExactNotification: true` و مجوزِ نداشته‌ی
 * «آلارم و یادآور»، زمان‌بندی نمی‌کند؛ صفحه‌ی تنظیمات را باز می‌کند و `call`
 * را resolve نمی‌کند.
 *
 * شاهد (سورس پلاگین نصب‌شده):
 *   node_modules/@capacitor/local-notifications/android/.../LocalNotificationsPlugin.kt
 *   `doSchedule()` → شاخه‌ی `ACTION_REQUEST_SCHEDULE_EXACT_ALARM` (بدون resolve)
 *   `performScheduleNow()` → فقط بعد از برگشت از آن صفحه اجرا می‌شود
 *
 * پس قرارداد این ماژول این است: پرچم `isExactNotification` **فقط** وقتی `true`
 * می‌شود که `checkExactNotificationSetting()` خودش بگوید `granted`. اگر مجوز
 * نباشد، اعلان با آلارم غیردقیق ولی **ثبت‌شده** (`allowWhileIdle: true`) برود تا
 * صفحه‌ی خاموش/اپ بسته هم کار کند.
 *
 * Capacitor mock می‌شود چون در محیط `node` پل نیتیو وجود ندارد؛ اما منطق
 * تصمیم‌گیری همین ماژول است، نه mock.
 */

const mocks = vi.hoisted(() => {
    return {
        createChannel: vi.fn(async () => undefined),
        schedule: vi.fn(async (options: { notifications: { id: number }[] }) => ({
            notifications: options.notifications.map((notification) => ({ id: notification.id })),
        })),
        getPending: vi.fn(async () => ({ notifications: [] as unknown[] })),
        checkPermissions: vi.fn(async () => ({ display: "granted" })),
        requestPermissions: vi.fn(async () => ({ display: "granted" })),
        checkExactNotificationSetting: vi.fn(),
    }
})

vi.mock("@capacitor/local-notifications", () => ({
    LocalNotifications: {
        createChannel: mocks.createChannel,
        schedule: mocks.schedule,
        getPending: mocks.getPending,
        checkPermissions: mocks.checkPermissions,
        requestPermissions: mocks.requestPermissions,
        checkExactNotificationSetting: mocks.checkExactNotificationSetting,
    },
}))

/**
 * پیاده‌سازی پیش‌فرض پل: هر اعلان را با همان شناسه‌اش تأیید می‌کند.
 * در `beforeEach` بازنشانی می‌شود تا `mockImplementation`های تست‌های قبلی
 * (مثل mock بر اساس id) به تست بعدی نشت نکنند.
 */
function defaultScheduleImpl(options: { notifications: { id: number }[] }) {
    return Promise.resolve({
        notifications: options.notifications.map((notification) => ({ id: notification.id })),
    })
}

/** آخرین اعلانی که واقعاً به پل داده شده — همان چیزی که به AlarmManager می‌رسد. */
function lastScheduledNotification(): Record<string, unknown> {
    expect(mocks.schedule).toHaveBeenCalledTimes(1)

    const options = mocks.schedule.mock.calls[0][0] as unknown as {
        notifications: Record<string, unknown>[]
    }

    return options.notifications[0]
}

describe("scheduleLocalReminder — دروازه‌ی آلارم دقیق", () => {
    beforeEach(() => {
        // محیط نیتیو را شبیه‌سازی می‌کنیم، وگرنه هیچ‌وقت به پل نمی‌رسد.
        vi.stubGlobal("window", { Capacitor: { isNativePlatform: () => true } })

        // `mockReset` هم فراخوانی‌ها و هم implementationها را پاک می‌کند؛
        // بعدش پیش‌فرض سالم دوباره گذاشته می‌شود.
        mocks.schedule.mockReset()
        mocks.schedule.mockImplementation(defaultScheduleImpl)
        mocks.createChannel.mockClear()
        mocks.checkPermissions.mockClear()
        mocks.requestPermissions.mockClear()
        mocks.checkExactNotificationSetting.mockReset()
        mocks.checkExactNotificationSetting.mockResolvedValue({ exact_alarm: "denied" })

        // گزارش قبلی نباشد تا ادعاهای هر تست فقط روی همان اجرا باشند.
        clearNativeDiagnostics()
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it("مجوز نداشته باشد ⇒ غیردقیق ثبت می‌شود و promise هم resolve می‌شود", async () => {
        mocks.checkExactNotificationSetting.mockResolvedValue({ exact_alarm: "denied" })

        const result = await scheduleLocalReminder({
            title: "🔔 تست",
            body: "بدنه",
            delayMs: 1_000,
            id: 11,
        })

        // مهم‌ترین ادعا: هرگز معلق نمی‌ماند (چون هرگز آن شاخه‌ی مسدودکننده فعال نمی‌شود).
        expect(result.ok).toBe(true)

        const notification = lastScheduledNotification()
        expect(notification.id).toBe(11)
        expect(notification.isExactNotification).toBe(false)
        expect(notification.schedule).toEqual({
            at: expect.any(Date),
            allowWhileIdle: true,
        })
    })

    it("مجوز داده شده باشد ⇒ دقیق ثبت می‌شود", async () => {
        mocks.checkExactNotificationSetting.mockResolvedValue({ exact_alarm: "granted" })

        const result = await scheduleLocalReminder({
            title: "🔔 تست",
            body: "بدنه",
            delayMs: 1_000,
            id: 12,
        })

        expect(result.ok).toBe(true)
        expect(lastScheduledNotification().isExactNotification).toBe(true)
    })

    it("اگر خواندن وضعیت شکست بخورد ⇒ امن می‌مانیم و غیردقیق ثبت می‌شود", async () => {
        mocks.checkExactNotificationSetting.mockRejectedValue(new Error("no bridge"))

        const result = await scheduleLocalReminder({
            title: "یادآور روزساز",
            body: "بدنه",
            delayMs: 1_000,
            id: 13,
        })

        expect(result.ok).toBe(true)
        expect(lastScheduledNotification().isExactNotification).toBe(false)
    })

    it("`exact: false` صریح هیچ‌وقت وضعیت را نمی‌خواند", async () => {
        const result = await scheduleLocalReminder({
            title: "🔔 تست",
            body: "بدنه",
            delayMs: 1_000,
            id: 14,
            exact: false,
        })

        expect(result.ok).toBe(true)
        expect(mocks.checkExactNotificationSetting).not.toHaveBeenCalled()
        expect(lastScheduledNotification().isExactNotification).toBe(false)
    })

    /*
     * مسیر شکستِ خودِ پل (نه شکست مجوز).
     *
     * چرا این تست مهم است؟ چون دو چیز در این شاخه باید درست باشد:
     *   ۱. شکست به خروجیِ ساختاریافته (`ok: false` + `SCHEDULE_FAILED`) تبدیل
     *      شود، نه throw و نه معلق‌ماندن؛
     *   ۲. تایمر هشدار «بدون پاسخ» **لغو** شود — وگرنه ۴ ثانیه بعد برای یک
     *      زمان‌بندیِ شکست‌خوردهٔ تمام‌شده `SCHEDULE_UNRESOLVED` ثبت می‌شد و
     *      گزارش دستگاه دروغ می‌گفت.
     */
    it("اگر خودِ پل رد کند ⇒ SCHEDULE_FAILED و بدون رویداد «بدون پاسخ» بعد از مهلت", async () => {
        vi.useFakeTimers()

        try {
            mocks.checkExactNotificationSetting.mockResolvedValue({ exact_alarm: "granted" })
            mocks.schedule.mockRejectedValueOnce(new Error("boom"))

            const result = await scheduleLocalReminder({
                title: "🔔 تست",
                body: "بدنه",
                delayMs: 1_000,
                id: 21,
            })

            expect(result.ok).toBe(false)
            if (result.ok) throw new Error("انتظار شکست داشتیم")
            expect(result.reason).toBe("SCHEDULE_FAILED")

            // گزارش را پاک می‌کنیم تا هر چیزی که *بعد* از شکست ثبت شود لو برود.
            clearNativeDiagnostics()

            await vi.advanceTimersByTimeAsync(SCHEDULE_UNRESOLVED_WARN_MS + 1_000)

            const events = getNativeDiagnostics().map((entry) => entry.event)
            expect(events).not.toContain("SCHEDULE_UNRESOLVED")
        } finally {
            vi.useRealTimers()
        }
    })

    /*
     * رگرسیون «فقط اولین یادآور کار می‌کند».
     *
     * این تست سه schedule پشت‌سرهم را از همان API عمومی اجرا می‌کند و اثبات
     * می‌کند که هیچ‌کدام به قفل دائمی نمی‌خورند: هر سه به پل می‌رسند و خودِ
     * رویدادهای حاشیه‌ای با شناسهٔ درست ثبت می‌شوند. اگر queue یا گزارش
     * به‌خاطر اجرای اول قفل می‌شد، اینجا شکست می‌خورد.
     */
    it("سه schedule پشت‌سرهم: هر سه اجرا و هر سه با شناسهٔ درست ثبت می‌شوند", async () => {
        const result1 = await scheduleLocalReminder({
            title: "🔔 تست",
            body: "بدنه",
            delayMs: 1_000,
            id: 31,
        })
        expect(result1.ok).toBe(true)

        const result2 = await scheduleLocalReminder({
            title: "🔔 تست",
            body: "بدنه",
            delayMs: 1_000,
            id: 32,
        })
        expect(result2.ok).toBe(true)

        const result3 = await scheduleLocalReminder({
            title: "🔔 تست",
            body: "بدنه",
            delayMs: 1_000,
            id: 33,
        })
        expect(result3.ok).toBe(true)

        expect(mocks.schedule).toHaveBeenCalledTimes(3)
        expect(mocks.createChannel).toHaveBeenCalledTimes(3)

        const scheduledIds = mocks.schedule.mock.calls.map(
            (call) => (call[0] as unknown as { notifications: { id: number }[] }).notifications[0].id,
        )
        expect(scheduledIds).toEqual([31, 32, 33])

        const entries = getNativeDiagnostics()

        // هر تلاش با SCHEDULE_START و شناسهٔ خودش شروع می‌شود.
        const startEvents = entries.filter((entry) => entry.event === "SCHEDULE_START")
        expect(startEvents.map((entry) => entry.id)).toEqual([31, 32, 33])
        const startAttempts = startEvents.map((entry) => entry.attemptNo)
        expect(new Set(startAttempts).size).toBe(3)
        expect(startAttempts).toEqual([...startAttempts].sort((a, b) => (a ?? 0) - (b ?? 0)))

        const permEvents = entries.filter((entry) => entry.event === "PERMISSION_RESULT")
        expect(permEvents.map((entry) => entry.id)).toEqual([31, 32, 33])
        expect(permEvents.map((entry) => entry.attemptNo)).toEqual(startAttempts)

        const exactEvents = entries.filter((entry) => entry.event === "EXACT_CAPABILITY")
        expect(exactEvents.map((entry) => entry.id)).toEqual([31, 32, 33])

        const channelEvents = entries.filter((entry) => entry.event === "CHANNEL_RESULT")
        expect(channelEvents.map((entry) => entry.id)).toEqual([31, 32, 33])

        const nativeStartEvents = entries.filter(
            (entry) => entry.event === "NATIVE_SCHEDULE_START",
        )
        expect(nativeStartEvents.map((entry) => entry.id)).toEqual([31, 32, 33])
        expect(nativeStartEvents.map((entry) => entry.attemptNo)).toEqual(startAttempts)

        const nativeResolvedEvents = entries.filter(
            (entry) => entry.event === "NATIVE_SCHEDULE_RESOLVED",
        )
        expect(nativeResolvedEvents.map((entry) => entry.id)).toEqual([31, 32, 33])
        expect(nativeResolvedEvents.map((entry) => entry.attemptNo)).toEqual(startAttempts)

        // محیط mock هرگز معلق نمی‌ماند، پس هیچ‌جای این مسیر نباید «بدون پاسخ» باشد.
        const events = entries.map((entry) => entry.event)
        expect(events).not.toContain("SCHEDULE_UNRESOLVED")
        expect(events).not.toContain("QUEUE_RELEASED")

        // هر رویداد باید timestamp داشته باشد (Dos".
        for (const entry of entries) {
            expect(typeof entry.at).toBe("number")
            expect(entry.iso).toBe(new Date(entry.at).toISOString())
        }

        // هر سه تلاش مجوز تأیید و capability «denied» دریافت کردند.
        expect(permEvents[0].message).toContain("تأیید")
    })

    /*
     * همان سناریو، ولی با exact-alarm granted.
     * باید جداگانه پوشش داده شود چون مسیر تصمیم `isExactNotification: true` است.
     */
    it("سه schedule پشت‌سرهم با exact-alarm granted: هر سه دقیق ثبت می‌شوند", async () => {
        mocks.checkExactNotificationSetting.mockResolvedValue({ exact_alarm: "granted" })

        for (const id of [41, 42, 43]) {
            const result = await scheduleLocalReminder({
                title: "🔔 تست",
                body: "بدنه",
                delayMs: 1_000,
                id,
            })
            expect(result.ok).toBe(true)
        }

        expect(mocks.schedule).toHaveBeenCalledTimes(3)
        for (const call of mocks.schedule.mock.calls) {
            const notification = (call[0] as unknown as { notifications: Record<string, unknown>[] })
                .notifications[0]
            expect(notification.isExactNotification).toBe(true)
        }

        const entries = getNativeDiagnostics()

        const exactEvents = entries.filter((entry) => entry.event === "EXACT_CAPABILITY")
        expect(exactEvents.map((entry) => entry.id)).toEqual([41, 42, 43])
        // مجوز داده شده بود، پس پیام باید مسیر «آلارم دقیق» را نشان دهد، نه denied.
        for (const entry of exactEvents) expect(entry.message).toContain("granted")

        const nativeResolved = entries.filter(
            (entry) => entry.event === "NATIVE_SCHEDULE_RESOLVED",
        )
        expect(nativeResolved.map((entry) => entry.id)).toEqual([41, 42, 43])
        for (const entry of nativeResolved) expect(entry.isExact).toBe(true)
    })

    /*
     * رگرسیون «شکست اول، قفل همیشگی بقیه».
     *
     * دقیقاً همان حالت باگ: اولین زمان‌بندی به پل می‌رسد و از دست می‌رود. سؤال
     * واقعی این است که آیا **بعدی‌ها هنوز اجرا می‌شوند یا نه**. این تست اجرای
     * اول را رد می‌کند و بعد دو اجرای سالم پشت‌سرهم می‌گیرد.
     *
     * نکته‌ی مهم درباره‌ی محدوده: `scheduleLocalReminder` خودش هیچ mutex ای
     * ندارد؛ صف سریال در `app/lib/native/primitives.ts` → `enqueueNative` است و
     * تضمین «یک عملیات معلق صف را برای همیشه قفل نمی‌کند» انجا اندازه‌گیری
     * می‌شود (`primitives.test.ts`). اینجا فقط اثبات می‌کنیم که خودِ این تابع
     * پس از یک شکست، دوباره کامل و مستقل اجرا می‌شود.
     */
    it("اگر native schedule اول reject کند، schedule دوم و سوم هنوز کار می‌کنند", async () => {
        mocks.schedule.mockRejectedValueOnce(new Error("native boom"))

        const first = await scheduleLocalReminder({
            title: "🔔 تست",
            body: "بدنه",
            delayMs: 1_000,
            id: 51,
        })

        expect(first.ok).toBe(false)
        if (first.ok) throw new Error("انتظار شکست داشتیم")
        expect(first.reason).toBe("SCHEDULE_FAILED")

        const second = await scheduleLocalReminder({
            title: "🔔 تست",
            body: "بدنه",
            delayMs: 1_000,
            id: 52,
        })
        const third = await scheduleLocalReminder({
            title: "🔔 تست",
            body: "بدنه",
            delayMs: 1_000,
            id: 53,
        })

        expect(second.ok, `second=${JSON.stringify(second)}`).toBe(true)
        expect(third.ok, `third=${JSON.stringify(third)}`).toBe(true)

        const entries = getNativeDiagnostics()
        const startIds = entries
            .filter((entry) => entry.event === "SCHEDULE_START")
            .map((entry) => entry.id)
        expect(startIds).toEqual([51, 52, 53])

        const permIds = entries
            .filter((entry) => entry.event === "PERMISSION_RESULT")
            .map((entry) => entry.id)
        expect(permIds).toEqual([51, 52, 53])

        // شکست اول یک رویداد rejected ثبت کرده؛ دو اجرای بعدی resolved شده‌اند.
        const resolvedIds = entries
            .filter((entry) => entry.event === "NATIVE_SCHEDULE_RESOLVED")
            .map((entry) => entry.id)
        expect(resolvedIds).toEqual([52, 53])

        const rejected = entries.filter((entry) => entry.event === "NATIVE_SCHEDULE_REJECTED")
        expect(rejected.map((entry) => entry.id)).toEqual([51])
    })
})
