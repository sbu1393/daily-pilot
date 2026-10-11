import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
    scheduleLocalReminder,
    SCHEDULE_UNRESOLVED_WARN_MS,
} from "@/app/lib/native/local-notifications"
import { clearNativeDiagnostics, getNativeDiagnostics } from "@/app/lib/native/diagnostics"

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

        mocks.schedule.mockClear()
        mocks.createChannel.mockClear()
        mocks.checkExactNotificationSetting.mockReset()
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
})
