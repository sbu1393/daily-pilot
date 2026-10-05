import { afterAll, beforeAll, describe, expect, it } from "vitest"

import {
    dailyReminderNotificationId,
    nextDailyReminderAt,
} from "@/app/lib/native/daily-reminder"
import { parseReminderHHMM, reminderTarget } from "@/app/lib/reminder"

/*
 * تست‌های pure برای `app/lib/native/daily-reminder.ts`
 * -------------------------------------------------------------
 * عمداً فقط منطق قطعی (تابع خالص) تست می‌شود — نه Capacitor، نه WebView.
 * wrapper فقط در تابع‌های `schedule`/`cancel` به لایه‌ی نیتیو می‌رسد و آن‌ها
 * برای تست native نیازمند دستگاه/ساخت APK هستند؛ پس اینجا فقط چیزی تست
 * می‌شود که بدون شبیه‌ساز هم قابل اثبات است: «شناسه‌ی اعلان» و «لحظه‌ی هدف».
 *
 * مهم‌ترین قراردادی که اینجا قفل می‌شود: wrapper **هیچ ریاضیات زمان جدیدی
 * اختراع نمی‌کند** و دقیقاً همان `reminderTarget` موجود پروژه را به کار
 * می‌برد. اگر کسی بعداً منطق را عوض کند، این تست‌ها می‌شکنند.
 */

const MIN_ID = 1
/** سقف int32 علامت‌دار اندروید = 2_147_483_647؛ wrapper با حاشیه زیر آن می‌ماند. */
const MAX_ID = 2_000_000_000

/** scopeهای نمونه: کاربران واقعی + بازدیدکننده‌ی ناشناس. */
const SCOPES = [null, 1, 2, 7, 42, 12345, 2_147_483_647]

describe("dailyReminderNotificationId", () => {
    it("برای یک scope ثابت، قطعی است", () => {
        for (const userId of SCOPES) {
            const first = dailyReminderNotificationId(userId)

            for (let attempt = 0; attempt < 5; attempt += 1) {
                expect(dailyReminderNotificationId(userId)).toBe(first)
            }
        }
    })

    it("عدد صحیح در محدوده‌ی معتبر اندروید است", () => {
        for (const userId of SCOPES) {
            const id = dailyReminderNotificationId(userId)

            expect(Number.isInteger(id)).toBe(true)
            expect(id).toBeGreaterThanOrEqual(MIN_ID)
            expect(id).toBeLessThanOrEqual(MAX_ID)
        }
    })

    it("scopeهای متفاوت شناسه‌ی یکسان نمی‌سازند", () => {
        const ids = SCOPES.map((userId) => dailyReminderNotificationId(userId))

        expect(new Set(ids).size).toBe(ids.length)
    })

    it("به روز وابسته نیست — با گذشت زمان تغییر نمی‌کند", () => {
        const before = dailyReminderNotificationId(42)

        // عبور از یک نیمه‌شب محلی و یک مرز ماه؛ id نباید تغییر کند.
        const fakeNow = new Date()
        fakeNow.setDate(fakeNow.getDate() + 1)
        fakeNow.setHours(0, 0, 0, 0)

        expect(dailyReminderNotificationId(42)).toBe(before)
        expect(nextDailyReminderAt(fakeNow, "09:00")?.getHours()).toBe(9)
        expect(dailyReminderNotificationId(42)).toBe(before)
    })

    it("صفر یا منفی تولید نمی‌کند (0 در اندروید رزرو است)", () => {
        for (const userId of SCOPES) {
            expect(dailyReminderNotificationId(userId)).not.toBe(0)
        }
    })
})

describe("nextDailyReminderAt — انتخاب روز", () => {
    it("اگر ساعت هنوز نرسیده، امروز را انتخاب می‌کند", () => {
        const now = new Date(2026, 9, 5, 8, 0, 0, 0)
        const at = nextDailyReminderAt(now, "09:00")

        expect(at).not.toBeNull()
        expect(at!.getFullYear()).toBe(2026)
        expect(at!.getMonth()).toBe(9)
        expect(at!.getDate()).toBe(5)
        expect(at!.getHours()).toBe(9)
        expect(at!.getMinutes()).toBe(0)
        expect(at!.getSeconds()).toBe(0)
        expect(at!.getTime()).toBeGreaterThan(now.getTime())
    })

    it("اگر ساعت امروز گذشته، فردا را انتخاب می‌کند", () => {
        const now = new Date(2026, 9, 5, 10, 0, 0, 0)
        const at = nextDailyReminderAt(now, "09:00")

        expect(at!.getDate()).toBe(6)
        expect(at!.getHours()).toBe(9)
        expect(at!.getMinutes()).toBe(0)
    })

    it("اگر دقیقاً همین حالا باشد، فردا را انتخاب می‌کند (هیچ‌وقت در گذشته نمی‌زند)", () => {
        const now = new Date(2026, 9, 5, 9, 0, 0, 0)
        const at = nextDailyReminderAt(now, "09:00")

        expect(at!.getDate()).toBe(6)
        expect(at!.getTime()).toBeGreaterThan(now.getTime())
    })

    it("همیشه لحظه‌ای در آینده و حداکثر یک روز جلوتر است", () => {
        const cases: Array<[number, number, string]> = [
            [0, 0, "00:00"],
            [23, 59, "00:00"],
            [12, 0, "23:59"],
            [23, 59, "23:59"],
        ]

        for (const [hour, minute, reminderTime] of cases) {
            const now = new Date(2026, 9, 5, hour, minute, 0, 0)
            const at = nextDailyReminderAt(now, reminderTime)

            expect(at).not.toBeNull()
            expect(at!.getTime()).toBeGreaterThan(now.getTime())

            // فاصله روی محور تقویم محلی حداکثر یک روز است.
            const localGap =
                (at!.getFullYear() - now.getFullYear()) * 366 * 24 * 60 * 60 * 1000 +
                (at!.getMonth() - now.getMonth()) * 32 * 24 * 60 * 60 * 1000 +
                (at!.getDate() - now.getDate()) * 24 * 60 * 60 * 1000

            expect(localGap).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
        }
    })

    it("از مرز پایان ماه هم درست عبور می‌کند", () => {
        const now = new Date(2026, 0, 31, 23, 0, 0, 0) // ۳۱ ژانویه
        const at = nextDailyReminderAt(now, "08:00")

        expect(at!.getMonth()).toBe(1) // فوریه
        expect(at!.getDate()).toBe(1)
        expect(at!.getHours()).toBe(8)
    })
})

describe("nextDailyReminderAt — ردّ ورودی نامعتبر", () => {
    it("HH:MM نامعتبر را null برمی‌گرداند", () => {
        const now = new Date(2026, 9, 5, 8, 0, 0, 0)

        expect(nextDailyReminderAt(now, "")).toBeNull()
        expect(nextDailyReminderAt(now, "abc")).toBeNull()
        expect(nextDailyReminderAt(now, "9")).toBeNull()
        expect(nextDailyReminderAt(now, "24:00")).toBeNull()
        expect(nextDailyReminderAt(now, "09:60")).toBeNull()
        expect(nextDailyReminderAt(now, "-1:00")).toBeNull()
        expect(nextDailyReminderAt(now, "09:00:00")).toBeNull()
        expect(nextDailyReminderAt(now, "9am")).toBeNull()
        expect(nextDailyReminderAt(now, "09:0a")).toBeNull()
    })

    it("با همان قواعدی رد می‌کند که reminderTarget پروژه رد می‌کند", () => {
        const now = new Date(2026, 9, 5, 8, 0, 0, 0)

        for (const invalid of ["", "abc", "24:00", "09:60", "09:00:00"]) {
            const expected = reminderTarget(now, invalid)

            expect(expected).toBeNull()
            expect(nextDailyReminderAt(now, invalid)).toBeNull()
        }
    })

    it("قاعده‌ی کاراکتری را از reminderTarget پروژه قرض می‌گیرد، نه از خودش", () => {
        /*
         * نکته‌ی مهم: منطق کلاینت پروژه (`parseReminderHHMM`) یک تا دو رقم را
         * می‌پذیرد، برخلاف نسخه‌ی سروری (`reminderSchedule.parseHHMM`) که دو رقم
         * می‌خواهد. wrapper عمداً سخت‌گیرانه‌تر نمی‌شود تا رفتارش با مسیر مرورگر
         * یکی بماند — پس «9:00» اینجا معتبر است، هرچند API سرور آن را رد می‌کند.
         */
        const now = new Date(2026, 9, 5, 8, 0, 0, 0)

        expect(parseReminderHHMM("9:00")).not.toBeNull()
        expect(nextDailyReminderAt(now, "9:00")).not.toBeNull()
        expect(nextDailyReminderAt(now, "9:00")?.getTime()).toBe(
            reminderTarget(now, "9:00")?.getTime(),
        )
    })
})

describe("nextDailyReminderAt — سازگاری با منطق زمان پروژه", () => {
    it("دقیقاً همان خروجی reminderTarget را می‌دهد (امروز یا فردا)", () => {
        const now = new Date(2026, 9, 5, 8, 30, 0, 0)
        const tomorrow = new Date(2026, 9, 6, 8, 30, 0, 0)

        // ساعت هنوز نرسیده ⇒ همان reminderTarget امروز
        expect(nextDailyReminderAt(now, "09:00")?.getTime()).toBe(
            reminderTarget(now, "09:00")?.getTime(),
        )

        // ساعت گذشته ⇒ reminderTarget روی نیمه‌شب فردا
        expect(nextDailyReminderAt(now, "08:00")?.getTime()).toBe(
            reminderTarget(tomorrow, "08:00")?.getTime(),
        )
    })

    it("ساعت دقیقه‌ی درخواست‌شده را روی دیوار ساعت محلی حفظ می‌کند", () => {
        const now = new Date(2026, 5, 15, 8, 0, 0, 0)

        for (const reminderTime of ["00:00", "07:05", "09:00", "13:45", "23:59"]) {
            const parsed = parseReminderHHMM(reminderTime)!
            const at = nextDailyReminderAt(now, reminderTime)

            expect(at!.getHours()).toBe(parsed.hour)
            expect(at!.getMinutes()).toBe(parsed.minute)
            expect(at!.getSeconds()).toBe(0)
            expect(at!.getMilliseconds()).toBe(0)
        }
    })
})

/*
 * رفتار DST
 * ---------
 * wrapper عمداً «فردا» را با `new Date(y, m, d + 1)` می‌سازد و نه با
 * `+ ۲۴ ساعت`؛ به همین دلیل در روزهای تغییر ساعت، ساعت نهایی جابه‌جا نمی‌شود.
 * این تست‌ها همان چیزی را قفل می‌کنند که مسیر مرورگر هم با `reminderTarget`
 * انجام می‌دهد.
 */
describe("nextDailyReminderAt — تغییر ساعت (DST)", () => {
    const ORIGINAL_TZ = process.env.TZ
    const DST_TZ = "America/New_York"

    beforeAll(() => {
        process.env.TZ = DST_TZ
    })

    afterAll(() => {
        process.env.TZ = ORIGINAL_TZ
    })

    /**
     * توجه: این تاریخ‌ها باید **داخل تست** ساخته شوند، نه در سطح ماژول.
     * `new Date(y, m, d, h)` بر اساس منطقه‌ی زمانی لحظه‌ی ساخت تعبیر می‌شود،
     * پس ساختنشان پیش از `beforeAll` یعنی ساختنشان در منطقه‌ی اشتباه.
     */

    it("در روز عادیِ همان منطقه، ساعت محلی حفظ می‌شود", () => {
        const now = new Date(2026, 5, 15, 8, 0, 0, 0)
        const at = nextDailyReminderAt(now, "09:00")

        expect(at!.getHours()).toBe(9)
        expect(at!.getMinutes()).toBe(0)
        expect(at!.getTime()).toBeGreaterThan(now.getTime())
    })

    it("در روز شروع DST هم دقیقاً با reminderTarget پروژه یکی است", () => {
        // ۸ مارس ۲۰۲۶: در نیویورک ساعت ۰۲:۰۰ به ۰۳:۰۰ می‌پرد.
        const now = new Date(2026, 2, 8, 8, 0, 0, 0)
        const tomorrow = new Date(2026, 2, 9, 8, 0, 0, 0)

        expect(nextDailyReminderAt(now, "09:00")?.getTime()).toBe(
            reminderTarget(now, "09:00")?.getTime(),
        )

        // ساعت گذشته ⇒ باید فردا باشد، نه «۲۴ ساعت بعد» که با DST ناهمخوان است.
        const past = nextDailyReminderAt(now, "07:00")!

        expect(past.getTime()).toBe(reminderTarget(tomorrow, "07:00")!.getTime())
        expect(past.getDate()).toBe(9)
        expect(past.getHours()).toBe(7)
        expect(past.getTime()).toBeGreaterThan(now.getTime())
    })

    it("در روز پایان DST هم روزِ درست را انتخاب می‌کند", () => {
        // ۱ نوامبر ۲۰۲۶: ساعت ۰۲:۰۰ به ۰۱:۰۰ برمی‌گردد.
        const now = new Date(2026, 10, 1, 8, 0, 0, 0)
        const at = nextDailyReminderAt(now, "10:00")!

        expect(at.getDate()).toBe(1)
        expect(at.getHours()).toBe(10)

        const past = nextDailyReminderAt(now, "06:00")!

        expect(past.getDate()).toBe(2)
        expect(past.getHours()).toBe(6)
        expect(past.getTime()).toBeGreaterThan(now.getTime())
    })

    it("لحظه‌ی هدف همیشه در همان منطقه‌ی زمانی محلی ساخته می‌شود", () => {
        // یک زمان UTC که در نیویورک ساعت محلیِ متفاوتی دارد؛ نتیجه باید باز هم
        // ساعت درخواستی باشد، نه معادلِ UTC.
        const now = new Date(Date.UTC(2026, 5, 15, 23, 0, 0, 0))
        const at = nextDailyReminderAt(now, "07:30")

        expect(at!.getHours()).toBe(7)
        expect(at!.getMinutes()).toBe(30)
        expect(at!.getTime()).toBeGreaterThan(now.getTime())
    })
})