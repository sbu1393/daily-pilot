// AI Quota v2 — تست‌های مرز گذار legacy ⇄ جدید
//
// پنج سناریوی الزامی محصول، هرکدام با مقدار instantِ محاسبه‌شده‌ی دستی
// (نه «شبیه»): یک تستِ timezone/DST که فقط بگوید «LEGACY بود» هیچ چیزی را ثابت
// نمی‌کند؛ باید خودِ لحظهٔ مرز را قفل کند.
//
// قاعده‌ی تحت تست:
//   NEW ⟺ periodStart >= firstNewPeriodStart(cutoverAt, timezone)
//   firstNewPeriodStart = اولین شروع دورهٔ محلی که >= cutoverAt باشد

import { describe, expect, it } from "vitest"

import {
    firstNewPeriodStart,
    readCutoverAt,
    resolveActivationCutover,
    resolveCurrentQuotaMode,
    resolveQuotaMode,
} from "./aiQuotaCutover.service"
import { QuotaUnavailableError } from "./errors"
import { getMonthlyPeriod } from "./planPolicy.service"

const iso = (s: string) => new Date(s)

describe("firstNewPeriodStart — سناریوی ۱: cutover وسط ماه", () => {
    const cutoverAt = iso("2026-09-15T12:00:00.000Z")

    it("دورهٔ در بر گیرندهٔ cutoverAt آخرین دورهٔ legacy است", () => {
        expect(firstNewPeriodStart(cutoverAt, "UTC").toISOString()).toBe(
            "2026-10-01T00:00:00.000Z",
        )
        expect(resolveQuotaMode(iso("2026-09-01T00:00:00.000Z"), cutoverAt, "UTC")).toBe("LEGACY")
    })

    it("دورهٔ بعد، NEW است", () => {
        expect(resolveQuotaMode(iso("2026-10-01T00:00:00.000Z"), cutoverAt, "UTC")).toBe("NEW")
    })

    it("دورهٔ خیلی قدیمی هم LEGACY است", () => {
        expect(resolveQuotaMode(iso("2026-01-01T00:00:00.000Z"), cutoverAt, "UTC")).toBe("LEGACY")
    })
})

describe("firstNewPeriodStart — سناریوی ۲: cutover دقیقاً روی periodStart", () => {
    const cutoverAt = iso("2026-10-01T00:00:00.000Z")

    it("همان دوره NEW است، نه یک دوره دیرتر", () => {
        expect(firstNewPeriodStart(cutoverAt, "UTC").toISOString()).toBe("2026-10-01T00:00:00.000Z")
        expect(resolveQuotaMode(iso("2026-10-01T00:00:00.000Z"), cutoverAt, "UTC")).toBe("NEW")
    })

    it("دورهٔ قبل همچنان LEGACY است", () => {
        expect(resolveQuotaMode(iso("2026-09-01T00:00:00.000Z"), cutoverAt, "UTC")).toBe("LEGACY")
    })

    it("یک میلی‌ثانیه قبل از مرز، LEGACY است (مرز بسته به سمت راست است)", () => {
        const justBefore = iso("2026-09-30T23:59:59.999Z")
        expect(resolveQuotaMode(justBefore, cutoverAt, "UTC")).toBe("LEGACY")
    })
})

describe("firstNewPeriodStart — سناریوی ۳: Asia/Tehran (UTC+3:30)", () => {
    it("مرز به وقت محلی، نه نیمه‌شب UTC، منتقل می‌شود", () => {
        // نیمه‌شب ۱ اکتبر به وقت تهران = ۲۰:۳۰ شب ۳۰ سپتامبر UTC
        const cutoverAt = iso("2026-09-30T20:30:00.000Z")
        expect(firstNewPeriodStart(cutoverAt, "Asia/Tehran").toISOString()).toBe(
            "2026-09-30T20:30:00.000Z",
        )
        expect(resolveQuotaMode(iso("2026-09-30T20:30:00.000Z"), cutoverAt, "Asia/Tehran")).toBe("NEW")
        // شروع ماه سپتامبرِ تهران = ۲۰:۳۰ شب ۳۱ اوت UTC
        expect(resolveQuotaMode(iso("2026-08-31T20:30:00.000Z"), cutoverAt, "Asia/Tehran")).toBe("LEGACY")
    })

    it("resolveCurrentQuotaMode برای همان لحظه، NEW می‌دهد", () => {
        const cutoverAt = iso("2026-09-30T20:30:00.000Z")
        expect(resolveCurrentQuotaMode(cutoverAt, cutoverAt, "Asia/Tehran")).toBe("NEW")
    })
})

describe("firstNewPeriodStart — سناریوی ۴: دو کاربر با timezone متفاوت، یک cutoverAt", () => {
    const cutoverAt = iso("2026-10-01T00:00:00.000Z") // نیمه‌شب UTC

    it("هر کاربر در مرز خودش گذر می‌کند، نه در مرز جهانی", () => {
        const utcUser = firstNewPeriodStart(cutoverAt, "UTC")
        const tehranUser = firstNewPeriodStart(cutoverAt, "Asia/Tehran")

        // UTC: ۱ اکتش�� ۰۰:۰۰ UTC
        expect(utcUser.toISOString()).toBe("2026-10-01T00:00:00.000Z")
        // تهران: ۱۰۱ اکتبر ۰۰:۰۰ محلی = ۳۱ اکتبر ۲۳:۰۰ UTC (چون cutoverAt هنوز داخل اکتبر محلی است)
        expect(tehranUser.toISOString()).toBe("2026-10-31T20:30:00.000Z")
        expect(tehranUser.getTime()).not.toBe(utcUser.getTime())
    })

    it("در لحظهٔ مشترک، کاربر UTC زودتر از کاربر تهران NEW شده است", () => {
        // ۱ نوامبر ۰۰:۰۰ UTC
        const now = iso("2026-11-01T00:00:00.000Z")
        expect(resolveQuotaMode(getMonthlyPeriod(now, "UTC").periodStart, cutoverAt, "UTC")).toBe("NEW")
        expect(resolveQuotaMode(getMonthlyPeriod(now, "Asia/Tehran").periodStart, cutoverAt, "Asia/Tehran")).toBe(
            "NEW",
        )
    })
})

describe("firstNewPeriodStart — سناریوی ۵: مرز ماه در timezone دارای DST (Europe/Berlin)", () => {
    it("شروع اکتبر (+02:00) درست محاسبه می‌شود", () => {
        expect(getMonthlyPeriod(iso("2026-10-10T00:00:00.000Z"), "Europe/Berlin").periodStart.toISOString()).toBe(
            "2026-09-30T22:00:00.000Z",
        )
    })

    it("شروع نوامبر بعد از پایان DST (+01:00) یک ساعت عقب‌تر است", () => {
        // DST اروپا در ۲۵ اکتبر ۲۰۲۶ تمام می‌شود ⇒ آفست از +02:00 به +01:00 می‌رود.
        // محاسبهٔ «کور» ۲۲ اکتبر ۲۳:۰۰ UTC می‌داد که یک ساعت غلط است.
        expect(getMonthlyPeriod(iso("2026-11-10T00:00:00.000Z"), "Europe/Berlin").periodStart.toISOString()).toBe(
            "2026-10-31T23:00:00.000Z",
        )
    })

    it("cutover وسط اکتبر ⇒ مرز روی شروع نوامبر (+01:00) می‌افتد", () => {
        const cutoverAt = iso("2026-10-15T00:00:00.000Z")
        expect(firstNewPeriodStart(cutoverAt, "Europe/Berlin").toISOString()).toBe(
            "2026-10-31T23:00:00.000Z",
        )
        // دورهٔ اکتبر (شروع ۳۰ سپتامبر ۲۲:۰۰ UTC) آخرین دورهٔ legacy است
        expect(resolveQuotaMode(iso("2026-09-30T22:00:00.000Z"), cutoverAt, "Europe/Berlin")).toBe("LEGACY")
        expect(resolveQuotaMode(iso("2026-10-31T23:00:00.000Z"), cutoverAt, "Europe/Berlin")).toBe("NEW")
    })
})

describe("readCutoverAt / resolveActivationCutover", () => {
    function makePrisma(row: { cutoverAt: Date } | null) {
        return {
            aiQuotaCutover: {
                findUnique: async () => (row ? { cutoverAt: row.cutoverAt } : null),
                update: async () => ({}),
            },
        }
    }

    it("ردیف موجود را برمی‌گرداند", async () => {
        const at = iso("2026-10-01T00:00:00.000Z")
        await expect(readCutoverAt(makePrisma({ cutoverAt: at }) as never)).resolves.toEqual(at)
    })

    it("نبودِ ردیف ⇒ fail-closed (نه «بدون مرز»)", async () => {
        await expect(readCutoverAt(makePrisma(null) as never)).rejects.toBeInstanceOf(QuotaUnavailableError)
    })

    it("فعال‌سازی دیرهنگام مرز را جلو می‌برد", () => {
        const current = iso("2026-10-01T00:00:00.000Z")
        const activation = iso("2026-10-20T00:00:00.000Z")
        expect(resolveActivationCutover(current, activation).toISOString()).toBe(
            "2026-10-20T00:00:00.000Z",
        )
    })

    it("فعال‌سازی زودهنگام مرز را دست‌نخورده می‌گذارد (هرگز عقب نمی‌رود)", () => {
        const current = iso("2026-12-01T00:00:00.000Z")
        const activation = iso("2026-10-20T00:00:00.000Z")
        expect(resolveActivationCutover(current, activation).toISOString()).toBe(
            "2026-12-01T00:00:00.000Z",
        )
    })
})
