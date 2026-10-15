import { describe, expect, it } from "vitest"

import { taskReminderNotificationId } from "@/app/lib/native/task-reminder"
import {
    findTaskAlarm,
    pruneTaskAlarms,
    readTaskAlarms,
    removeTaskAlarm,
    taskAlarmId,
    taskAlarmsStorageKey,
    TASK_ALARM_MAX_ITEMS,
    TASK_ALARM_MIN_LEAD_MS,
    TASK_ALARM_PAST_GRACE_MS,
    upsertTaskAlarm,
    validateTaskAlarmTime,
    writeTaskAlarms,
    type TaskAlarm,
} from "@/app/lib/taskAlarm"

const NOW = 1_700_000_000_000

function alarm(taskId: number, overrides: Partial<TaskAlarm> = {}): TaskAlarm {
    return {
        taskId,
        title: `تسک ${taskId}`,
        at: NOW + 10 * 60_000,
        createdAt: NOW,
        ...overrides,
    }
}

/** Storage جعلی درون‌حافظه‌ای — همان قرارداد `StorageLike` پروژه. */
function fakeStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial))

    return {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => void data.set(key, value),
        removeItem: (key: string) => void data.delete(key),
        raw: data,
    }
}

describe("taskAlarmId", () => {
    it("برای یک تسک پایدار است (تغییر زمان آلارم ⇒ همان شناسه)", () => {
        expect(taskAlarmId(12)).toBe(taskAlarmId(12))
    })

    it("برای تسک‌های مختلف متفاوت است", () => {
        expect(taskAlarmId(1)).not.toBe(taskAlarmId(2))
    })

    it("شناسه‌ی مثبت است (برای PendingIntent و NotificationManager)", () => {
        expect(taskAlarmId(7)).toBeGreaterThan(0)
        expect(Number.isInteger(taskAlarmId(7))).toBe(true)
    })

    /*
     * آلارم و یادآور دو قابلیت مستقل‌اند و نباید اعلان همدیگر را بازنویسی کنند:
     * فضاهای کلید عمداً جدا هستند (`task-alarm:` در برابر `task-reminder:`).
     */
    it("با شناسه‌ی اعلانِ یادآور همان تسک یکی نیست", () => {
        for (const taskId of [1, 2, 42, 999, 123456]) {
            expect(taskAlarmId(taskId)).not.toBe(taskReminderNotificationId(taskId))
        }
    })
})

describe("pruneTaskAlarms", () => {
    it("آلارم‌های آینده را نگه می‌دارد و مرتب بر اساس زمان می‌کند", () => {
        const list = [alarm(1, { at: NOW + 60_000 }), alarm(2, { at: NOW + 30_000 })]

        expect(pruneTaskAlarms(list, NOW).map((item) => item.taskId)).toEqual([2, 1])
    })

    it("آلارم خیلی گذشته حذف می‌شود", () => {
        const old = alarm(1, { at: NOW - TASK_ALARM_PAST_GRACE_MS - 1 })

        expect(pruneTaskAlarms([old], NOW)).toEqual([])
    })

    it("آلارم تازه‌زنگ‌زده (داخل مهلت) می‌ماند تا بازخورد UI ممکن باشد", () => {
        const justRang = alarm(1, { at: NOW - 1_000 })

        expect(pruneTaskAlarms([justRang], NOW)).toHaveLength(1)
    })

    it("سقف تعداد اعمال می‌شود", () => {
        const many = Array.from({ length: TASK_ALARM_MAX_ITEMS + 25 }, (_, index) =>
            alarm(index + 1, { at: NOW + 60_000 + index * 1_000 }),
        )

        expect(pruneTaskAlarms(many, NOW)).toHaveLength(TASK_ALARM_MAX_ITEMS)
    })
})

describe("readTaskAlarms / writeTaskAlarms", () => {
    it("رفت‌وبرگشت سالم است", () => {
        const storage = fakeStorage()
        writeTaskAlarms(storage, [alarm(5)])

        expect(readTaskAlarms(storage, NOW)).toEqual([alarm(5)])
    })

    it("کلید user-scoped است (روی دستگاه مشترک نشتی نمی‌کند)", () => {
        expect(taskAlarmsStorageKey(7)).not.toBe(taskAlarmsStorageKey(null))
        expect(taskAlarmsStorageKey(7)).toContain("u7")
        expect(taskAlarmsStorageKey(null)).toContain("anon")
    })

    it("storage نمی‌دهد ⇒ لیست خالی، بدون استثنا", () => {
        expect(readTaskAlarms(null, NOW)).toEqual([])
    })

    it("داده‌ی خراب بی‌صدا نادیده گرفته می‌شود", () => {
        const storage = fakeStorage({ [taskAlarmsStorageKey(null)]: "{not-json" })

        expect(readTaskAlarms(storage, NOW)).toEqual([])
    })

    it("آیتم‌های بی‌شکل حذف می‌شوند و آیتم‌های سالم می‌مانند", () => {
        const storage = fakeStorage({
            [taskAlarmsStorageKey(null)]: JSON.stringify([
                alarm(1),
                { taskId: "غلط" },
                null,
                { taskId: 2, title: "بدون زمان", createdAt: NOW },
            ]),
        })

        expect(readTaskAlarms(storage, NOW).map((item) => item.taskId)).toEqual([1])
    })

    it("نوشتن روی storage پر خطا نمی‌دهد", () => {
        const full = {
            getItem: () => null,
            setItem: () => {
                throw new Error("QuotaExceededError")
            },
        }

        expect(() => writeTaskAlarms(full, [alarm(1)])).not.toThrow()
    })
})

describe("upsertTaskAlarm / removeTaskAlarm / findTaskAlarm", () => {
    it("ثبت آلارم تازه اضافه می‌کند", () => {
        const next = upsertTaskAlarm([], { id: 3, title: "کار" }, NOW + 60_000, NOW)

        expect(next).toHaveLength(1)
        expect(next[0]).toMatchObject({ taskId: 3, title: "کار", at: NOW + 60_000 })
    })

    it("ثبت دوباره‌ی همان تسک جایگزین می‌شود (نه تکراری)", () => {
        const first = upsertTaskAlarm([], { id: 3, title: "کار" }, NOW + 60_000, NOW)
        const second = upsertTaskAlarm(first, { id: 3, title: "کار ویرایش‌شده" }, NOW + 120_000, NOW)

        expect(second).toHaveLength(1)
        expect(second[0]).toMatchObject({ title: "کار ویرایش‌شده", at: NOW + 120_000 })
    })

    it("حذف، آلارم همان تسک را برمی‌دارد و بقیه را نگه می‌دارد", () => {
        const list = [alarm(1), alarm(2)]
        const next = removeTaskAlarm(list, 1, NOW)

        expect(next.map((item) => item.taskId)).toEqual([2])
    })

    it("find آلارم همان تسک را برمی‌گرداند", () => {
        const list = [alarm(1), alarm(2)]

        expect(findTaskAlarm(list, 2)?.taskId).toBe(2)
        expect(findTaskAlarm(list, 9)).toBeUndefined()
    })
})

describe("validateTaskAlarmTime", () => {
    it("زمان گذشته پذیرفته نمی‌شود", () => {
        expect(validateTaskAlarmTime(NOW - 1, NOW)).toEqual({ ok: false, reason: "IN_THE_PAST" })
    })

    it("زمانی که کمتر از حداقل فاصله جلوتر است پذیرفته نمی‌شود", () => {
        expect(validateTaskAlarmTime(NOW + TASK_ALARM_MIN_LEAD_MS - 1, NOW)).toEqual({
            ok: false,
            reason: "IN_THE_PAST",
        })
    })

    it("زمان معتبر پذیرفته می‌شود", () => {
        expect(validateTaskAlarmTime(NOW + TASK_ALARM_MIN_LEAD_MS, NOW)).toEqual({ ok: true })
        expect(validateTaskAlarmTime(NOW + 3_600_000, NOW)).toEqual({ ok: true })
    })

    it("عدد نامعتبر پذیرفته نمی‌شود", () => {
        expect(validateTaskAlarmTime(Number.NaN, NOW)).toEqual({ ok: false, reason: "IN_THE_PAST" })
        expect(validateTaskAlarmTime(Number.POSITIVE_INFINITY, NOW)).toEqual({
            ok: false,
            reason: "IN_THE_PAST",
        })
    })
})
