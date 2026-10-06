import { describe, expect, it } from "vitest"

import {
    cancelTaskReminder,
    cancelTaskReminders,
    scheduleTaskReminder,
    taskReminderNotificationId,
    validateTaskReminderTime,
    authorizeTaskReminder,
    TASK_REMINDER_KEY_PREFIX,
} from "@/app/lib/native/task-reminder"
import { dailyReminderNotificationId } from "@/app/lib/native/daily-reminder"
import { REMINDER_MIN_LEAD_MS } from "@/app/lib/taskReminder"
import type { LocalNotificationPermissionOutcome } from "@/app/lib/native/local-notifications"

/*
 * تست‌های یادآور تسکِ نیتیو — `app/lib/native/task-reminder.ts`
 * -------------------------------------------------------------
 * فقط منطق قطعی و مسیرهای بدون دستگاه: شناسه، اعتبار زمان، و **ترتیبِ مجوز**.
 *
 * Capacitor اصلاً mock نمی‌شود. در محیط node هیچ `window` وجود ندارد، پس لایه‌ی
 * نیتیو با `NOT_NATIVE` برمی‌گردد — و همین برای ما کافی و حتی مفید است:
 * ثابت می‌کند wrapper واقعاً به utility می‌رسد، ساختاریافته خطا می‌دهد و هیچ‌وقت
 * معلق یا throw نمی‌شود. رفتار «زمان‌بندی دقیق روی دستگاه» جداگانه روی APK
 * سنجیده می‌شود.
 */

const MIN_ID = 1
/** سقف int32 علامت‌دار اندروید = 2_147_483_647؛ wrapper با حاشیه زیر آن می‌ماند. */
const MAX_ID = 2_000_000_000

const TASK_IDS = [1, 2, 3, 7, 42, 12345, 2_147_483_647]

const GRANTED: LocalNotificationPermissionOutcome = { ok: true, display: "granted" }

describe("taskReminderNotificationId", () => {
    it("برای یک تسک ثابت، قطعی است", () => {
        for (const taskId of TASK_IDS) {
            const first = taskReminderNotificationId(taskId)

            for (let attempt = 0; attempt < 5; attempt += 1) {
                expect(taskReminderNotificationId(taskId)).toBe(first)
            }
        }
    })

    it("تسک‌های مختلف شناسه‌ی یکسان نمی‌سازند", () => {
        const ids = TASK_IDS.map(taskReminderNotificationId)

        expect(new Set(ids).size).toBe(ids.length)
    })

    it("عدد صحیح در محدوده‌ی معتبر اندروید است", () => {
        for (const taskId of TASK_IDS) {
            const id = taskReminderNotificationId(taskId)

            expect(Number.isInteger(id)).toBe(true)
            expect(id).toBeGreaterThanOrEqual(MIN_ID)
            expect(id).toBeLessThanOrEqual(MAX_ID)
        }
    })

    it("به تاریخ و زمان وابسته نیست", () => {
        // تابع pure است و هیچ ورودیِ زمانی ندارد؛ این تست قفل می‌کند که کسی
        // بعداً `dayKey`/`dueAt` را به امضایش اضافه نکند.
        const before = TASK_IDS.map(taskReminderNotificationId)

        const future = Date.now() + 86_400_000
        for (const taskId of TASK_IDS) {
            void future
            void new Date(future)
        }

        expect(TASK_IDS.map(taskReminderNotificationId)).toEqual(before)
    })

    it("با شناسه‌ی یادآور روزانه برخورد نمی‌کند", () => {
        // پیشوندها متفاوت‌اند؛ این تست تضمین می‌کند لغو یادآور تسک، اعلان
        // یادآور روزانه‌ی همان کاربر را هم پاک نکند.
        expect(TASK_REMINDER_KEY_PREFIX).toBe("task-reminder")

        for (const id of TASK_IDS) {
            expect(taskReminderNotificationId(id)).not.toBe(dailyReminderNotificationId(id))
        }
    })

    it("شناسه‌ی نامعتبر (۰ یا منفی) هم بازه‌ی مجاز می‌ماند تا call-site آن را رد کند", () => {
        for (const taskId of [0, -1, -999]) {
            const id = taskReminderNotificationId(taskId)

            expect(Number.isInteger(id)).toBe(true)
            expect(id).toBeGreaterThanOrEqual(MIN_ID)
            expect(id).toBeLessThanOrEqual(MAX_ID)
        }
    })
})

describe("validateTaskReminderTime", () => {
    const NOW = new Date(2026, 8, 8, 17, 0, 0, 0).getTime()

    it("زمانِ آینده را عیناً به‌عنوان لحظه‌ی هدف برمی‌گرداند", () => {
        // lead time در UI قبلاً اعمال و ذخیره شده؛ wrapper نباید دوباره کم کند.
        const dueAt = NOW + 10 * 60_000
        const result = validateTaskReminderTime(dueAt, NOW)

        expect(result.ok).toBe(true)
        if (!result.ok) throw new Error("انتظار می‌رفت معتبر باشد")
        expect(result.at.getTime()).toBe(dueAt)
    })

    it("حداقل lead پروژه را می‌پذیرد (semantics موجود تغییر نمی‌کند)", () => {
        const result = validateTaskReminderTime(NOW + REMINDER_MIN_LEAD_MS, NOW)

        expect(result.ok).toBe(true)
    })

    it("زمان گذشته را رد می‌کند", () => {
        const result = validateTaskReminderTime(NOW - 1, NOW)

        expect(result.ok).toBe(false)
        if (result.ok) throw new Error("انتظار می‌رفت رد شود")
        expect(result.reason).toBe("IN_THE_PAST")
    })

    it("دقیقاً «همین حالا» را هم رد می‌کند", () => {
        const result = validateTaskReminderTime(NOW, NOW)

        expect(result.ok).toBe(false)
        if (result.ok) throw new Error("انتظار می‌رفت رد شود")
        expect(result.reason).toBe("IN_THE_PAST")
    })

    it("ورودی نامعتبر (NaN / Infinity) را رد می‌کند", () => {
        for (const dueAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
            const result = validateTaskReminderTime(dueAt, NOW)

            expect(result.ok).toBe(false)
            if (result.ok) throw new Error("انتظار می‌رفت رد شود")
            expect(result.reason).toBe("INVALID_DUE_AT")
        }
    })
})

describe("authorizeTaskReminder — مجوز پیش از ذخیره/زمان‌بندی", () => {
    it("مجوز داده‌شده ⇒ ok با همان لحظه‌ی هدف", async () => {
        const now = Date.now()
        const dueAt = now + 10 * 60_000

        const outcome = await authorizeTaskReminder({
            taskId: 5,
            dueAt,
            requestPermission: async () => GRANTED,
        })

        expect(outcome.ok).toBe(true)
        if (!outcome.ok) throw new Error("انتظار می‌رفت موفق باشد")
        expect(outcome.at.getTime()).toBe(dueAt)
    })

    it("مجوز ردشده ⇒ شکست با همان دلیل، بدون زمان‌بندی", async () => {
        let permissionCalls = 0

        const outcome = await authorizeTaskReminder({
            taskId: 5,
            dueAt: Date.now() + 60_000,
            requestPermission: async () => {
                permissionCalls += 1

                return { ok: false, reason: "PERMISSION_DENIED", message: "رد شد" }
            },
        })

        expect(outcome.ok).toBe(false)
        if (outcome.ok) throw new Error("انتظار می‌رفت شکست بخورد")
        expect(outcome.reason).toBe("PERMISSION_DENIED")
        expect(outcome.message).toBe("رد شد")
        expect(permissionCalls).toBe(1)
    })

    it("مجوز «هنوز داده نشده» هم شکست است (همان باگ یادآور روزانه)", async () => {
        const outcome = await authorizeTaskReminder({
            taskId: 5,
            dueAt: Date.now() + 60_000,
            requestPermission: async () => ({
                ok: false,
                reason: "PERMISSION_PROMPT",
                message: "کاربر هنوز پاسخ نداده",
            }),
        })

        expect(outcome.ok).toBe(false)
        if (outcome.ok) throw new Error("انتظار می‌رفت شکست بخورد")
        expect(outcome.reason).toBe("PERMISSION_PROMPT")
    })

    it("پیش از resolve‌شدن مجوز، نتیجه‌ای برنمی‌گردد", async () => {
        let resolvePermission!: (value: LocalNotificationPermissionOutcome) => void
        const pending = new Promise<LocalNotificationPermissionOutcome>((resolve) => {
            resolvePermission = resolve
        })

        let settled = false
        const promise = authorizeTaskReminder({
            taskId: 5,
            dueAt: Date.now() + 60_000,
            requestPermission: () => pending,
        }).then((value) => {
            settled = true
            return value
        })

        await Promise.resolve()
        expect(settled).toBe(false)

        resolvePermission(GRANTED)
        expect((await promise).ok).toBe(true)
    })

    it("زمان گذشته ⇒ حتی مجوز هم پرسیده نمی‌شود", async () => {
        let permissionCalls = 0

        const outcome = await authorizeTaskReminder({
            taskId: 5,
            dueAt: Date.now() - 60_000,
            requestPermission: async () => {
                permissionCalls += 1
                return GRANTED
            },
        })

        expect(outcome.ok).toBe(false)
        if (outcome.ok) throw new Error("انتظار می‌رفت رد شود")
        expect(outcome.reason).toBe("IN_THE_PAST")
        expect(permissionCalls).toBe(0)
    })

    it("شناسه‌ی نامعتبر ⇒ بدون درخواست مجوز", async () => {
        let permissionCalls = 0

        for (const taskId of [0, -3, 1.5, Number.NaN]) {
            const outcome = await authorizeTaskReminder({
                taskId,
                dueAt: Date.now() + 60_000,
                requestPermission: async () => {
                    permissionCalls += 1
                    return GRANTED
                },
            })

            expect(outcome.ok).toBe(false)
            if (outcome.ok) throw new Error("انتظار می‌رفت رد شود")
            expect(outcome.reason).toBe("INVALID_TASK_ID")
        }

        expect(permissionCalls).toBe(0)
    })
})

/*
 * مسیر نیتیو — در node به `NOT_NATIVE` می‌رسد. تست می‌کند که wrapper دروازه‌های
 * اعتبارسنجی را **پیش** از پل نیتیو می‌بندد و هرگز معلق یا throw نمی‌شود.
 */
describe("scheduleTaskReminder / cancelTaskReminder — دروازه‌ها پیش از پل نیتیو", () => {
    it("زمان آینده ⇒ به لایه‌ی نیتیو می‌رسد و خطای ساختاریافته می‌دهد", async () => {
        const outcome = await scheduleTaskReminder({
            taskId: 9,
            title: "خرید نان",
            dueAt: Date.now() + 10 * 60_000,
        })

        expect(outcome.ok).toBe(false)
        if (outcome.ok) throw new Error("در node انتظار NOT_NATIVE داشتیم")
        expect(outcome.reason).toBe("NOT_NATIVE")
    })

    it("زمان گذشته ⇒ اصلاً به پل نیتیو نمی‌رسد", async () => {
        const outcome = await scheduleTaskReminder({
            taskId: 9,
            title: "خرید نان",
            dueAt: Date.now() - 1,
        })

        expect(outcome.ok).toBe(false)
        if (outcome.ok) throw new Error("انتظار می‌رفت رد شود")
        expect(outcome.reason).toBe("IN_THE_PAST")
    })

    it("شناسه‌ی نامعتبر ⇒ رد می‌شود", async () => {
        for (const taskId of [0, -1, 2.5]) {
            const outcome = await scheduleTaskReminder({
                taskId,
                title: "x",
                dueAt: Date.now() + 60_000,
            })

            expect(outcome.ok).toBe(false)
            if (outcome.ok) throw new Error("انتظار می‌رفت رد شود")
            expect(outcome.reason).toBe("INVALID_TASK_ID")
        }
    })

    it("زمان‌بندی دوباره ⇒ همان شناسه ⇒ جایگزینی، نه اعلان تازه", () => {
        // جایگزینی در اندروید از «یکی بودن id» می‌آید، نه از state این ماژول.
        const first = taskReminderNotificationId(9)
        const laterTime = Date.now() + 3 * 60 * 60_000

        expect(taskReminderNotificationId(9)).toBe(first)
        expect(Number.isFinite(laterTime)).toBe(true)
    })

    it("لغو ⇒ خطای ساختاریافته می‌دهد و معلق نمی‌ماند", async () => {
        const outcome = await cancelTaskReminder(9)

        expect(outcome.ok).toBe(false)
        if (outcome.ok) throw new Error("در node انتظار NOT_NATIVE داشتیم")
        expect(outcome.reason).toBe("NOT_NATIVE")
    })

    it("لغو با شناسه‌ی نامعتبر ⇒ رد می‌شود", async () => {
        for (const taskId of [0, -2, 1.5]) {
            const outcome = await cancelTaskReminder(taskId)

            expect(outcome.ok).toBe(false)
            if (outcome.ok) throw new Error("انتظار می‌رفت رد شود")
            expect(outcome.reason).toBe("INVALID_TASK_ID")
        }
    })

    it("لغو گروهی تکراری‌ها و نامعتبرها را حذف می‌کند و resolve می‌شود", async () => {
        await expect(cancelTaskReminders([1, 1, 2, 0, -4, 3])).resolves.toBeUndefined()
    })
})
