import { describe, expect, it } from "vitest"

/* ------------------------------------------------------------------ */
/* «تنظیم زمان» — یادآوری تسک + آلارم                                  */
/*                                                                     */
/* این تست‌ها فقط منطق خالص را پوشش می‌دهند (بدون DOM/React):            */
/* اعتبارسنجی localStorage، علامت‌گذاری رسیدن زمان، پاک‌سازی، فرمت         */
/* نمایش فارسی و تبدیل مقدار <input type="datetime-local">.             */
/* هیچ قرارداد سروری (schema/API) در این فیچر وجود ندارد.               */
/* ------------------------------------------------------------------ */

import {
    fromDateTimeLocalValue,
    formatReminderRelative,
    formatReminderTime,
    markDueReminders,
    pruneReminders,
    readReminders,
    removeReminder,
    toDateTimeLocalValue,
    upsertReminder,
    writeReminders,
    REMINDER_MAX_ITEMS,
    REMINDER_STORAGE_KEY,
    type TaskReminder,
} from "./taskReminder"
import { getCanonicalDayKey } from "./canonicalDay"

const TZ = "Asia/Tehran"

/** localStorage ساختگی — حداقلِ رابط مورد نیاز */
function makeStorage(initial?: string, opts: { throwOnSet?: boolean } = {}) {
    let value = initial ?? null

    return {
        getItem: () => value,
        setItem: (_key: string, next: string) => {
            if (opts.throwOnSet) throw new Error("quota exceeded")
            value = next
        },
        current: () => value,
    }
}

function reminder(over: Partial<TaskReminder> = {}): TaskReminder {
    return {
        taskId: 1,
        title: "تسک نمونه",
        dueAt: 1_700_000_000_000,
        createdAt: 1_699_000_000_000,
        firedAt: null,
        ...over,
    }
}

describe("readReminders — اعتبارسنجی و بازیابی", () => {
    it("بدون داده یا با JSON خراب، آرایه‌ی خالی برمی‌گرداند", () => {
        expect(readReminders(null)).toEqual([])
        expect(readReminders(makeStorage())).toEqual([])
        expect(readReminders(makeStorage("{ not json"))).toEqual([])
        expect(readReminders(makeStorage('{"a":1}'))).toEqual([])
    })

    it("رکوردهای ناسازگار را حذف می‌کند و معتبرها را نگه می‌دارد", () => {
        const payload = JSON.stringify([
            reminder({ taskId: 1 }),
            { taskId: "x" },
            null,
            42,
            { taskId: 2, title: "ok", dueAt: "nope", createdAt: 1, firedAt: null },
            reminder({ taskId: 3, dueAt: 1_700_000_100_000 }),
        ])

        const out = readReminders(makeStorage(payload), 1_700_000_000_000)

        expect(out.map((r) => r.taskId)).toEqual([1, 3])
    })

    it("خروجی بر اساس زمان هدف صعودی مرتب می‌شود", () => {
        const payload = JSON.stringify([
            reminder({ taskId: 3, dueAt: 300 }),
            reminder({ taskId: 1, dueAt: 100 }),
            reminder({ taskId: 2, dueAt: 200 }),
        ])

        const out = readReminders(makeStorage(payload), 0)

        expect(out.map((r) => r.taskId)).toEqual([1, 2, 3])
    })
})

describe("pruneReminders — پاک‌سازی و سقف تعداد", () => {
    it("یادآوری اجراشده‌ی قدیمی را حذف و اجراشده‌ی تازه را نگه می‌دارد", () => {
        const now = 10_000_000_000
        const list = [
            reminder({ taskId: 1, firedAt: now - 1000 }),
            reminder({ taskId: 2, firedAt: now - 8 * 24 * 60 * 60 * 1000 }),
            reminder({ taskId: 3, firedAt: null }),
        ]

        const out = pruneReminders(list, now)

        expect(out.map((r) => r.taskId).sort()).toEqual([1, 3])
    })

    it("سقف تعداد را اعمال می‌کند", () => {
        const list = Array.from({ length: REMINDER_MAX_ITEMS + 25 }, (_, i) =>
            reminder({ taskId: i + 1, dueAt: i + 1 }),
        )

        expect(pruneReminders(list, 0)).toHaveLength(REMINDER_MAX_ITEMS)
    })
})

describe("upsertReminder / removeReminder — هر تسک یک یادآوری", () => {
    it("یادآوری تازه اضافه می‌شود و firedAt پاک می‌شود", () => {
        const first = upsertReminder([], { id: 7, title: "ورزش" }, 500_000, 1000)

        expect(first).toHaveLength(1)
        expect(first[0]).toMatchObject({ taskId: 7, title: "ورزش", dueAt: 500_000, firedAt: null })

        const second = upsertReminder(first, { id: 7, title: "ورزش" }, 900_000, 2000)

        expect(second).toHaveLength(1)
        expect(second[0]!.dueAt).toBe(900_000)
    })

    it("جایگزینی، یادآوری قدیمی همان تسک را حذف می‌کند (بدون تکرار)", () => {
        const list = upsertReminder([reminder({ taskId: 5 })], { id: 5, title: "کتاب" }, 999, 1)

        expect(list.filter((r) => r.taskId === 5)).toHaveLength(1)
        expect(list[0]!.title).toBe("کتاب")
    })

    it("حذف فقط یادآوری همان تسک را برمی‌دارد", () => {
        const list = [reminder({ taskId: 1 }), reminder({ taskId: 2 })]

        expect(removeReminder(list, 1, 0).map((r) => r.taskId)).toEqual([2])
    })
})

describe("markDueReminders — فقط یک بار هشدار", () => {
    it("یادآوری نرسیده را دست‌نخورده می‌گذارد", () => {
        const out = markDueReminders([reminder({ dueAt: 5000 })], 1000)

        expect(out.newlyFired).toEqual([])
        expect(out.ring).toBe(false)
        expect(out.list[0]!.firedAt).toBeNull()
    })

    it("یادآوری رسیده را یک بار اجرا و با صدا علامت می‌زند", () => {
        const out = markDueReminders([reminder({ taskId: 9, dueAt: 1000 })], 2000)

        expect(out.newlyFired.map((r) => r.taskId)).toEqual([9])
        expect(out.ring).toBe(true)
        expect(out.list[0]!.firedAt).toBe(2000)

        // اجرای دوباره → هیچ هشدار تازه‌ای نیست (idempotent)
        const again = markDueReminders(out.list, 9000)
        expect(again.newlyFired).toEqual([])
        expect(again.ring).toBe(false)
    })

    it("یادآوری خیلی قدیمی بی‌صدا اجرا می‌شود (بدون پخش ناگهانی صدا)", () => {
        const now = 60 * 60 * 1000
        const out = markDueReminders([reminder({ dueAt: 0 })], now)

        expect(out.newlyFired).toHaveLength(1)
        expect(out.ring).toBe(false)
    })
})

describe("writeReminders — مقاوم در برابر خطای localStorage", () => {
    it("روی کلید اختصاصی می‌نویسد و رفت و برگشت خواندن درست است", () => {
        const storage = makeStorage()

        writeReminders(storage, [reminder({ taskId: 4 })])

        expect(REMINDER_STORAGE_KEY).toBe("dp:task-reminders")
        expect(readReminders(storage, 0).map((r) => r.taskId)).toEqual([4])
    })

    it("وقتی setItem خطا بدهد (حالت خصوصی/سهمیه‌ی پر) throw نمی‌کند", () => {
        const storage = makeStorage(undefined, { throwOnSet: true })

        expect(() => writeReminders(storage, [reminder()])).not.toThrow()
    })
})

describe("datetime-local — رفت و برگشت", () => {
    it("epoch → مقدار ورودی → همان epoch (بدون از دست دادن دقت دقیقه)", () => {
        const base = new Date(2026, 8, 21, 14, 30, 0, 0).getTime()

        const value = toDateTimeLocalValue(base)

        expect(value).toBe("2026-09-21T14:30")
        expect(fromDateTimeLocalValue(value)).toBe(base)
    })

    it("مقدار خالی یا نامعتبر → null", () => {
        expect(fromDateTimeLocalValue("")).toBeNull()
        expect(fromDateTimeLocalValue("   ")).toBeNull()
        expect(fromDateTimeLocalValue("nonsense")).toBeNull()
    })
})

describe("formatReminderTime — برچسب فارسی", () => {
    /*
     * نکته‌ی مهم: این testها به timezone ماشین اجرا وابسته نیستند.
     * لحظه‌ها با UTC ثابت تعریف می‌شوند و انتظار با timezone تهران حساب شده —
     * یعنی دقیقاً همان چیزی که تضمین می‌کنیم: timezone صریح، نه ساعت محلی سرور.
     */

    // ۱۰:۰۰ تهران، ۳۰ شهریور ۱۴۰۵
    const now = Date.parse("2026-09-21T06:30:00Z")

    it("همان روز → «امروز HH:MM» با ارقام فارسی", () => {
        const due = Date.parse("2026-09-21T11:00:00Z") // ۱۴:۳۰ تهران

        expect(formatReminderTime(due, TZ, now)).toBe("امروز ۱۴:۳۰")
    })

    it("روز بعد → «فردا HH:MM»", () => {
        const due = Date.parse("2026-09-22T05:35:00Z") // ۰۹:۰۵ تهران

        expect(formatReminderTime(due, TZ, now)).toBe("فردا ۰۹:۰۵")
    })

    it("روز قبل → «دیروز HH:MM»", () => {
        const due = Date.parse("2026-09-20T16:45:00Z") // ۲۰:۱۵ تهران

        expect(formatReminderTime(due, TZ, now)).toBe("دیروز ۲۰:۱۵")
    })

    it("روز دورتر → تاریخ جلالی + ساعت", () => {
        const due = Date.parse("2026-10-02T05:30:00Z") // ۰۹:۰۰ تهران → ۱۴۰۵/۰۷/۱۰
        const label = formatReminderTime(due, TZ, now)

        expect(label).toContain("۰۹:۰۰")
        expect(label).toContain("۱۴۰۵/۰۷/۱۰")
    })

    it("مرجع روز از timezone می‌آید (نه از ساعت محلی سرور)", () => {
        // 2026-09-21T20:45Z = ۱۴۰۵/۰۶/۳۱ ۰۰:۱۵ تهران (روز بعد) ولی همچنان ۲۱ سپتامبر در UTC
        const due = Date.parse("2026-09-21T20:45:00Z")
        const utcKey = getCanonicalDayKey(new Date(due), "UTC")

        expect(utcKey).toBe("2026-09-21")
        // در تهران این لحظه «امروز» است چون now هم تهران است
        expect(formatReminderTime(due, TZ, due)).toBe("امروز ۰۰:۱۵")
    })
})

describe("formatReminderRelative", () => {
    const now = 1_000_000_000_000

    it("دقایق / ساعت / روز", () => {
        expect(formatReminderRelative(now + 12 * 60_000, now)).toBe("۱۲ دقیقه دیگر")
        expect(formatReminderRelative(now + 2 * 60 * 60_000, now)).toBe("۲ ساعت دیگر")
        expect(formatReminderRelative(now + 3 * 24 * 60 * 60_000, now)).toBe("۳ روز دیگر")
    })

    it("کمتر از یک دقیقه و زمان گذشته", () => {
        expect(formatReminderRelative(now + 30_000, now)).toBe("کمتر از یک دقیقه دیگر")
        expect(formatReminderRelative(now - 1, now)).toBe("گذشت")
    })
})
