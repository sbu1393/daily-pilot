import { beforeEach, describe, expect, it, vi } from "vitest"

/* ------------------------------------------------------------------ */
/* یادآور روزانه — تست هسته‌ی خالص (app/lib/reminder.ts)                */
/*                                                                     */
/* محیط vitest این پروژه «node» است و jsdom نصب نمی‌شود (قید صفر       */
/* وابستگی) — بنابراین همین‌جا حداقل stub برای window.localStorage /    */
/* navigator / Notification ساخته می‌شود، دقیقاً مثل offline.test.ts.   */
/*                                                                     */
/* قفل‌شده در این فایل:                                                 */
/*  ۱. کلیدها user-scoped هستند و کلید قدیمیِ بدون scope خوانده نمی‌شود. */
/*  ۲. منطق آستانه‌ای + پنجره‌ی جبران (یادآور نمی‌سوزد).                  */
/*  ۳. اعلان فقط از مسیر Service Worker نمایش داده می‌شود و شکست در      */
/*     نمایش → `false` (پس fired ثبت نمی‌شود).                          */
/* ------------------------------------------------------------------ */

const storage: Record<string, unknown> = {
    getItem: (key: string) => (key in storage ? (storage[key] as string) : null),
    setItem: (key: string, value: string) => {
        storage[key] = String(value)
    },
    removeItem: (key: string) => {
        delete storage[key]
    },
}

const windowStub: Record<string, unknown> = { localStorage: storage }

vi.stubGlobal("window", windowStub)
vi.stubGlobal("navigator", {})

import {
    DEFAULT_SETTINGS,
    LEGACY_FIRED_STORAGE_KEY,
    LEGACY_SETTINGS_STORAGE_KEY,
    REMINDER_GRACE_MS,
    SW_READY_TIMEOUT_MS,
    canShowNotifications,
    clearLegacySettingsKeys,
    firedStorageKey,
    isReminderDue,
    parseReminderHHMM,
    readFiredKey,
    readStoredSettings,
    reminderFireKey,
    reminderTarget,
    saveStoredSettings,
    scopeToken,
    settingsStorageKey,
    showSystemNotification,
    writeFiredKey,
} from "./reminder"

const STORAGE_METHODS = ["getItem", "setItem", "removeItem"]

function resetStorage() {
    for (const key of Object.keys(storage)) {
        if (!STORAGE_METHODS.includes(key)) delete storage[key]
    }
}

function stubNotifications(permission: "granted" | "denied" | "default") {
    const notificationStub = { permission }
    windowStub.Notification = notificationStub
    vi.stubGlobal("Notification", notificationStub)
}

function stubServiceWorker(options: {
    registration?: { showNotification: unknown } | null
    ready?: Promise<unknown>
}) {
    const getRegistration = vi.fn(async () => options.registration ?? undefined)
    vi.stubGlobal("navigator", {
        serviceWorker: {
            getRegistration,
            ready: options.ready ?? Promise.resolve(options.registration ?? undefined),
        },
    })
    return getRegistration
}

beforeEach(() => {
    resetStorage()
    delete windowStub.Notification
    vi.stubGlobal("window", windowStub)
    vi.stubGlobal("navigator", {})
})

/* ---------------- کلیدهای user-scoped ---------------- */

describe("reminder — کلیدهای ذخیره‌سازی user-scoped", () => {
    it("برای کاربر وارد‌شده و بازدیدکننده‌ی ناشناس کلید جدا می‌سازد", () => {
        expect(scopeToken(7)).toBe("u7")
        expect(scopeToken(null)).toBe("anon")
        expect(scopeToken(0)).toBe("anon")
        expect(settingsStorageKey(7)).toBe("dp:settings:u7")
        expect(firedStorageKey(7)).toBe("dp:reminder-fired:u7")
        expect(settingsStorageKey(null)).toBe("dp:settings:anon")
        expect(firedStorageKey(null)).toBe("dp:reminder-fired:anon")
    })

    it("هرگز روی کلید قدیمیِ بدون scope نمی‌نویسد", () => {
        expect(settingsStorageKey(7)).not.toBe(LEGACY_SETTINGS_STORAGE_KEY)
        expect(firedStorageKey(7)).not.toBe(LEGACY_FIRED_STORAGE_KEY)
        expect(settingsStorageKey(null)).not.toBe(LEGACY_SETTINGS_STORAGE_KEY)
    })

    it("تنظیمات حساب قبلی (کلید بدون scope) را نمی‌خواند", () => {
        storage[LEGACY_SETTINGS_STORAGE_KEY] = JSON.stringify({
            theme: "dark",
            reminderEnabled: true,
            reminderTime: "23:59",
        })

        expect(readStoredSettings(7)).toEqual(DEFAULT_SETTINGS)
        expect(readStoredSettings(null)).toEqual(DEFAULT_SETTINGS)
    })

    it("تنظیمات هر کاربر فقط زیر کلید خودش می‌نشیند", () => {
        saveStoredSettings(7, {
            theme: "dark",
            sound: false,
            reminderEnabled: true,
            reminderTime: "07:30",
        })

        expect(readStoredSettings(7)).toEqual({
            theme: "dark",
            sound: false,
            reminderEnabled: true,
            reminderTime: "07:30",
        })
        expect(readStoredSettings(8)).toEqual(DEFAULT_SETTINGS)

        writeFiredKey(7, "2026-05-12|07:30")
        expect(readFiredKey(7)).toBe("2026-05-12|07:30")
        expect(readFiredKey(8)).toBeNull()
        expect(readFiredKey(null)).toBeNull()
    })

    it("فیلد نامعتبر یا JSON خراب را به پیش‌فرض برمی‌گرداند", () => {
        storage[settingsStorageKey(7)] = JSON.stringify({
            theme: "neon",
            sound: "yes",
            reminderEnabled: 1,
            reminderTime: "99:99",
        })
        expect(readStoredSettings(7)).toEqual(DEFAULT_SETTINGS)

        storage[settingsStorageKey(7)] = "{not json"
        expect(readStoredSettings(7)).toEqual(DEFAULT_SETTINGS)

        storage[settingsStorageKey(7)] = JSON.stringify({ theme: "light", reminderTime: "09:00" })
        expect(readStoredSettings(7)).toEqual({
            theme: "light",
            sound: DEFAULT_SETTINGS.sound,
            reminderEnabled: DEFAULT_SETTINGS.reminderEnabled,
            reminderTime: "09:00",
        })
    })

    it("clearLegacySettingsKeys کلیدهای بدون scope را حذف می‌کند", () => {
        storage[LEGACY_SETTINGS_STORAGE_KEY] = "{}"
        storage[LEGACY_FIRED_STORAGE_KEY] = "2026-05-12|09:00"

        clearLegacySettingsKeys()

        expect(storage[LEGACY_SETTINGS_STORAGE_KEY]).toBeUndefined()
        expect(storage[LEGACY_FIRED_STORAGE_KEY]).toBeUndefined()
        expect(readFiredKey(7)).toBeNull()
    })
})

/* ---------------- زمان‌بندی ---------------- */

describe("reminder — زمان‌بندی آستانه‌ای و پنجره‌ی جبران", () => {
    const at = (hour: number, minute: number, second = 0) =>
        new Date(2026, 4, 12, hour, minute, second, 0)

    it("زمان HH:MM را با تحمل قالب‌های ساده پارس می‌کند", () => {
        expect(parseReminderHHMM("09:00")).toEqual({ hour: 9, minute: 0 })
        expect(parseReminderHHMM("9:5")).toEqual({ hour: 9, minute: 5 })
        expect(parseReminderHHMM("23:59")).toEqual({ hour: 23, minute: 59 })
        expect(parseReminderHHMM("24:00")).toBeNull()
        expect(parseReminderHHMM("09:60")).toBeNull()
        expect(parseReminderHHMM("")).toBeNull()
        expect(parseReminderHHMM("صبح")).toBeNull()
    })

    it("زمان مقرر را روی همان روز محلی می‌سازد", () => {
        const target = reminderTarget(at(8, 0), "09:30")

        expect(target).not.toBeNull()
        expect(target?.getFullYear()).toBe(2026)
        expect(target?.getMonth()).toBe(4)
        expect(target?.getDate()).toBe(12)
        expect(target?.getHours()).toBe(9)
        expect(target?.getMinutes()).toBe(30)
        expect(reminderTarget(at(8, 0), "99:99")).toBeNull()
    })

    it("کلید fired روز محلی + زمان نرمال‌شده است (نه UTC)", () => {
        expect(reminderFireKey(at(9, 0), "09:00")).toBe("2026-05-12|09:00")
        expect(reminderFireKey(at(9, 0), "9:0")).toBe("2026-05-12|09:00")
        // ۰۰:۳۰ بامداد محلی باید روز همان محلی بماند
        expect(reminderFireKey(new Date(2026, 0, 2, 0, 30), "00:30")).toBe("2026-01-02|00:30")
    })

    it("پیش از زمان مقرر فایر نمی‌شود و در/بعد از آن فایر می‌شود", () => {
        const args = { reminderTime: "09:00", firedKey: null }

        expect(isReminderDue({ ...args, now: at(8, 59, 59) })).toBe(false)
        expect(isReminderDue({ ...args, now: at(9, 0) })).toBe(true)
        // تأخیر تایمر / throttling تب پس‌زمینه → یادآور نمی‌سوزد
        expect(isReminderDue({ ...args, now: at(9, 7) })).toBe(true)
        expect(isReminderDue({ ...args, now: at(10, 30) })).toBe(true)
    })

    it("بعد از پنجره‌ی جبران، یادآور کهنه فایر نمی‌شود", () => {
        const args = { reminderTime: "09:00", firedKey: null }
        const grace = REMINDER_GRACE_MS

        expect(isReminderDue({ ...args, now: at(10, 59), graceMs: grace })).toBe(true)
        expect(isReminderDue({ ...args, now: at(11, 1), graceMs: grace })).toBe(false)
        expect(isReminderDue({ ...args, now: at(11, 1), graceMs: 4 * 60 * 60 * 1000 })).toBe(true)
    })

    it("پس از ثبت fired همان روز دیگر تکرار نمی‌شود", () => {
        const now = at(9, 5)
        const firedKey = reminderFireKey(now, "09:00")

        expect(isReminderDue({ now, reminderTime: "09:00", firedKey })).toBe(false)
        // fired دیروز → امروز دوباره فایر می‌شود
        expect(isReminderDue({ now, reminderTime: "09:00", firedKey: "2026-05-11|09:00" })).toBe(true)
    })

    it("تغییر زمان یادآور یک کلید تازه و قابل فایر می‌سازد", () => {
        const now = at(9, 5)
        const firedForNine = reminderFireKey(now, "09:00")

        expect(isReminderDue({ now, reminderTime: "09:00", firedKey: firedForNine })).toBe(false)
        expect(isReminderDue({ now, reminderTime: "09:05", firedKey: firedForNine })).toBe(true)
    })

    it("زمان نامعتبر هرگز فایر نمی‌شود", () => {
        expect(isReminderDue({ now: at(9, 0), reminderTime: "", firedKey: null })).toBe(false)
        expect(isReminderDue({ now: at(9, 0), reminderTime: "25:70", firedKey: null })).toBe(false)
    })
})

/* ---------------- نمایش اعلان ---------------- */

describe("reminder — نمایش اعلان از مسیر Service Worker", () => {
    it("بدون مجوز اعلان → false", async () => {
        stubNotifications("denied")
        const getRegistration = stubServiceWorker({
            registration: { showNotification: vi.fn(async () => undefined) },
        })

        expect(canShowNotifications()).toBe(false)
        expect(await showSystemNotification({ title: "یادآور", body: "بدنه" })).toBe(false)
        expect(getRegistration).not.toHaveBeenCalled()
    })

    it("وقتی Notification API در دسترس نیست → false (iOS Safari)", async () => {
        stubServiceWorker({ registration: { showNotification: vi.fn() } })

        expect(canShowNotifications()).toBe(false)
        expect(await showSystemNotification({ title: "یادآور", body: "بدنه" })).toBe(false)
    })

    it("اعلان را با deep link و تنظیمات فارسی از registration نمایش می‌دهد", async () => {
        stubNotifications("granted")
        const showNotification = vi.fn(async () => undefined)
        stubServiceWorker({ registration: { showNotification } })

        const shown = await showSystemNotification({
            title: "یادآور روزساز",
            body: "وقت برنامه‌ریزی روزت رسیده است ✨",
            url: "/dashboard",
            tag: "dp-reminder-2026-05-12|09:00",
        })

        expect(shown).toBe(true)
        expect(showNotification).toHaveBeenCalledTimes(1)
        expect(showNotification).toHaveBeenCalledWith(
            "یادآور روزساز",
            expect.objectContaining({
                body: "وقت برنامه‌ریزی روزت رسیده است ✨",
                dir: "rtl",
                lang: "fa",
                tag: "dp-reminder-2026-05-12|09:00",
                data: { url: "/dashboard" },
            }),
        )
    })

    it("بدون Service Worker ثبت‌شده → false (یادآور نسوخته)", async () => {
        stubNotifications("granted")
        stubServiceWorker({ registration: null, ready: Promise.reject(new Error("no sw")) })

        expect(await showSystemNotification({ title: "یادآور", body: "بدنه" })).toBe(false)
    })

    it("اگر Service Worker آماده نشود، پس از مهلت false برمی‌گرداند", async () => {
        vi.useFakeTimers()
        try {
            stubNotifications("granted")
            stubServiceWorker({ registration: null, ready: new Promise(() => undefined) })

            const pending = showSystemNotification({ title: "یادآور", body: "بدنه" })
            await vi.advanceTimersByTimeAsync(SW_READY_TIMEOUT_MS + 1)

            expect(await pending).toBe(false)
        } finally {
            vi.useRealTimers()
        }
    })

    it("اگر showNotification رد شود → false (fired ثبت نمی‌شود)", async () => {
        stubNotifications("granted")
        stubServiceWorker({
            registration: { showNotification: vi.fn(async () => Promise.reject(new Error("denied"))) },
        })

        expect(await showSystemNotification({ title: "یادآور", body: "بدنه" })).toBe(false)
    })
})
