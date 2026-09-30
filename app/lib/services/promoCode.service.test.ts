// AI Quota v2 — تست‌های Promo Code
//
// پوشش: اعتبارسنجی ساخت، پنجرهٔ ریدیمپشن، ضدتکرار، CAS سقف، اتمی‌بودن grant،
// استقلال per-feature، و rollback وقتی grant شکست بخورد.
//
// نکتهٔ تست‌نویسی: `$transaction` شبیه‌سازی می‌شود که callback را با یک کلاینت
// `tx` جدا صدا بزند. آن‌وقت می‌توان اثبات کرد که نوشتن‌ها **داخل** تراکنش‌اند:
// اگر روی `tx` شکست بخورد، هیچ نوشتنی روی prisma ریشه انجام نشده — که معادل
// rollback واقعی PostgreSQL است.

import { beforeEach, describe, expect, it, vi } from "vitest"

import {
    createPromoCode,
    InvalidPromoCodeError,
    PromoAlreadyRedeemedError,
    PromoCodeInvalidError,
    redeemPromoCode,
} from "./promoCode.service"
import { QuotaUnavailableError } from "./errors"

const NOW = new Date("2026-09-15T12:00:00.000Z")
const VALID_FROM = new Date("2026-09-01T00:00:00.000Z")
const EXPIRES_AT = new Date("2026-10-01T00:00:00.000Z")

function makePrisma() {
    return {
        promoCode: {
            findUnique: vi.fn(),
            create: vi.fn(),
            updateMany: vi.fn(),
            findMany: vi.fn(),
            update: vi.fn(),
        },
        promoRedemption: { findUnique: vi.fn(), create: vi.fn() },
        aiQuotaBucket: { upsert: vi.fn(), create: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
        adminAuditLog: { create: vi.fn() },
        $transaction: vi.fn(),
    }
}

/** $transaction روی همان prisma (حالت ساده‌ی اکثر تست‌ها) */
function wireInline(prisma: ReturnType<typeof makePrisma>) {
    prisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<any>) => fn(prisma))
}

/** $transaction با کلاینت tx متمایز — برای اثبات «نوشتن داخل تراکنش است» */
function wireSeparateTx(
    prisma: ReturnType<typeof makePrisma>,
    tx: ReturnType<typeof makePrisma>,
) {
    prisma.$transaction.mockImplementation(async (fn: (client: any) => Promise<any>) => fn(tx))
}

function promoRow(overrides: Record<string, unknown> = {}) {
    return {
        id: "promo-1",
        code: "GIFT",
        isActive: true,
        validFrom: VALID_FROM,
        expiresAt: EXPIRES_AT,
        maxRedemptions: null,
        bonusAnalyzeUnits: 5,
        bonusPlanUnits: 0,
        redeemedCount: 0,
        createdAt: NOW,
        updatedAt: NOW,
        ...overrides,
    }
}

function basePrisma() {
    const prisma = makePrisma()
    prisma.promoCode.findUnique.mockResolvedValue(promoRow())
    prisma.promoCode.updateMany.mockResolvedValue({ count: 1 })
    prisma.promoRedemption.findUnique.mockResolvedValue(null)
    prisma.promoRedemption.create.mockResolvedValue({ id: "r-1" })
    prisma.aiQuotaBucket.upsert.mockResolvedValue({ id: 10 })
    wireInline(prisma)
    return prisma
}

/* ──────────────────────────────────────────────────────────────────────────── */

describe("createPromoCode — اعتبارسنجی سمت سرور", () => {
    let prisma: ReturnType<typeof makePrisma>

    beforeEach(() => {
        prisma = makePrisma()
        // create ورودی را برمی‌گرداند (مثل رفتار واقعی DB) تا audit از مقادیر
        // واقعاً ذخیره‌شده ساخته شود، نه از یک ردیف ثابت.
        prisma.promoCode.create.mockImplementation(async ({ data }: any) => ({ ...promoRow(), ...data }))
        prisma.adminAuditLog.create.mockResolvedValue({ id: "log" })
    })

    const base = {
        code: "  gift-2026  ",
        validFrom: VALID_FROM,
        expiresAt: EXPIRES_AT,
        bonusAnalyzeUnits: 5,
        bonusPlanUnits: 3,
        actorUserId: 42,
    }

    it("کد را نرمال می‌کند (trim + UPPER)", async () => {
        await createPromoCode(prisma as never, base)
        expect(prisma.promoCode.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ code: "GIFT-2026" }),
        })
    })

    it("بونوس صفرِ هر دو بُعد را رد می‌کند", async () => {
        await expect(
            createPromoCode(prisma as never, { ...base, bonusAnalyzeUnits: 0, bonusPlanUnits: 0 }),
        ).rejects.toBeInstanceOf(InvalidPromoCodeError)
    })

    it("بونوس منفی را رد می‌کند", async () => {
        await expect(
            createPromoCode(prisma as never, { ...base, bonusAnalyzeUnits: -1 }),
        ).rejects.toBeInstanceOf(InvalidPromoCodeError)
    })

    it("maxRedemptions صفر/منفی را رد می‌کند", async () => {
        await expect(
            createPromoCode(prisma as never, { ...base, maxRedemptions: 0 }),
        ).rejects.toBeInstanceOf(InvalidPromoCodeError)
    })

    it("انقضا قبل از شروع را رد می‌کند", async () => {
        await expect(
            createPromoCode(prisma as never, { ...base, expiresAt: VALID_FROM }),
        ).rejects.toBeInstanceOf(InvalidPromoCodeError)
    })

    it("کد تکراری ⇒ 409", async () => {
        prisma.promoCode.create.mockRejectedValue({ code: "P2002" })
        await expect(createPromoCode(prisma as never, base)).rejects.toMatchObject({ code: "CONFLICT" })
    })

    it("ساخت موفق ⇒ audit ثبت می‌شود", async () => {
        await createPromoCode(prisma as never, base)
        expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                action: "promo.created",
                actorUserId: 42,
                after: expect.objectContaining({ bonusAnalyzeUnits: 5, bonusPlanUnits: 3 }),
            }),
        })
    })
})

/* ──────────────────────────────────────────────────────────────────────────── */

describe("redeemPromoCode — پنجره و وضعیت کد (پاسخ عمومی ضد enumeration)", () => {
    it("کد ناموجود ⇒ PromoCodeInvalidError", async () => {
        const prisma = makePrisma()
        prisma.promoCode.findUnique.mockResolvedValue(null)
        await expect(
            redeemPromoCode(prisma as never, { userId: 1, code: "NOPE", timezone: "UTC", now: NOW }),
        ).rejects.toBeInstanceOf(PromoCodeInvalidError)
    })

    it("کد غیرفعال ⇒ همان خطای عمومی (نه کد جدا)", async () => {
        const prisma = makePrisma()
        prisma.promoCode.findUnique.mockResolvedValue(promoRow({ isActive: false }))
        await expect(
            redeemPromoCode(prisma as never, { userId: 1, code: "GIFT", timezone: "UTC", now: NOW }),
        ).rejects.toBeInstanceOf(PromoCodeInvalidError)
    })

    it("هنوز validFrom نرسیده ⇒ همان خطای عمومی", async () => {
        const prisma = makePrisma()
        prisma.promoCode.findUnique.mockResolvedValue(
            promoRow({ validFrom: new Date("2026-09-20T00:00:00.000Z") }),
        )
        await expect(
            redeemPromoCode(prisma as never, { userId: 1, code: "GIFT", timezone: "UTC", now: NOW }),
        ).rejects.toBeInstanceOf(PromoCodeInvalidError)
    })

    it("منقضی‌شده ⇒ همان خطای عمومی", async () => {
        const prisma = makePrisma()
        prisma.promoCode.findUnique.mockResolvedValue(
            promoRow({ expiresAt: new Date("2026-09-10T00:00:00.000Z") }),
        )
        await expect(
            redeemPromoCode(prisma as never, { userId: 1, code: "GIFT", timezone: "UTC", now: NOW }),
        ).rejects.toBeInstanceOf(PromoCodeInvalidError)
    })

    it("دقیقاً روی expiresAt دیگر قابل redeem نیست (بازهٔ نیمه‌باز)", async () => {
        const prisma = makePrisma()
        prisma.promoCode.findUnique.mockResolvedValue(promoRow({ expiresAt: NOW }))
        await expect(
            redeemPromoCode(prisma as never, { userId: 1, code: "GIFT", timezone: "UTC", now: NOW }),
        ).rejects.toBeInstanceOf(PromoCodeInvalidError)
    })

    it("کد را نرمال می‌کند و lowercase هم پیدا می‌شود", async () => {
        const prisma = basePrisma()
        await redeemPromoCode(prisma as never, {
            userId: 1,
            code: "  gift ",
            timezone: "UTC",
            now: NOW,
        })
        expect(prisma.promoCode.findUnique).toHaveBeenCalledWith({ where: { code: "GIFT" } })
    })
})

/* ──────────────────────────────────────────────────────────────────────────── */

describe("redeemPromoCode — ضدتکرار", () => {
    it("ریدیمپشن تکراری ⇒ PromoAlreadyRedeemedError", async () => {
        const prisma = basePrisma()
        prisma.promoRedemption.findUnique.mockResolvedValue({ id: "r-old" })
        await expect(
            redeemPromoCode(prisma as never, { userId: 1, code: "GIFT", timezone: "UTC", now: NOW }),
        ).rejects.toBeInstanceOf(PromoAlreadyRedeemedError)
        expect(prisma.promoCode.updateMany).not.toHaveBeenCalled()
    })

    it("برخورد هم‌زمان روی UNIQUE(userId,promoCodeId) ⇒ PromoAlreadyRedeemedError", async () => {
        const prisma = makePrisma()
        prisma.promoCode.findUnique.mockResolvedValue(promoRow())
        prisma.promoCode.updateMany.mockResolvedValue({ count: 1 })
        prisma.promoRedemption.findUnique
            .mockResolvedValueOnce(null) // بررسی سریع: هنوز استفاده نشده
            .mockResolvedValueOnce({ id: "r-other" }) // بعد از P2002: رقیب ثبت کرده
        prisma.promoRedemption.create.mockRejectedValue({ code: "P2002" })
        prisma.aiQuotaBucket.upsert.mockResolvedValue({ id: 10 })
        wireInline(prisma)

        await expect(
            redeemPromoCode(prisma as never, { userId: 1, code: "GIFT", timezone: "UTC", now: NOW }),
        ).rejects.toBeInstanceOf(PromoAlreadyRedeemedError)
    })
})

/* ──────────────────────────────────────────────────────────────────────────── */

describe("redeemPromoCode — CAS روی maxRedemptions", () => {
    it("وقتی سقف نامحدود است، هیچ guard روی redeemedCount نیست", async () => {
        const prisma = basePrisma()
        await redeemPromoCode(prisma as never, { userId: 1, code: "GIFT", timezone: "UTC", now: NOW })
        expect(prisma.promoCode.updateMany).toHaveBeenCalledWith({
            where: { id: "promo-1" },
            data: { redeemedCount: { increment: 1 } },
        })
    })

    it("با سقف مشخص، guard به‌صورت CAS اتمیک اعمال می‌شود", async () => {
        const prisma = basePrisma()
        prisma.promoCode.findUnique.mockResolvedValue(promoRow({ maxRedemptions: 5 }))
        await redeemPromoCode(prisma as never, { userId: 1, code: "GIFT", timezone: "UTC", now: NOW })
        expect(prisma.promoCode.updateMany).toHaveBeenCalledWith({
            where: { id: "promo-1", redeemedCount: { lt: 5 } },
            data: { redeemedCount: { increment: 1 } },
        })
    })

    it("count === 0 یعنی سقف تمام ⇒ پاسخ عمومی PROMO_CODE_INVALID (نه کدِ افشاگر) و بدون ساخت ریدیمپشن", async () => {
        const prisma = basePrisma()
        prisma.promoCode.findUnique.mockResolvedValue(promoRow({ maxRedemptions: 1 }))
        prisma.promoCode.updateMany.mockResolvedValue({ count: 0 })

        await expect(
            redeemPromoCode(prisma as never, { userId: 1, code: "GIFT", timezone: "UTC", now: NOW }),
        ).rejects.toBeInstanceOf(PromoCodeInvalidError)
        expect(prisma.promoRedemption.create).not.toHaveBeenCalled()
        expect(prisma.aiQuotaBucket.upsert).not.toHaveBeenCalled()
        // دلیل واقعی فقط سمت سرور ثبت می‌شود
        expect(prisma.adminAuditLog.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    action: "promo.redeem_rejected",
                    after: { reason: "EXHAUSTED" },
                }),
            }),
        )
    })

    it("شمارنده با increment تغییر می‌کند، نه read-modify-write", async () => {
        const prisma = basePrisma()
        await redeemPromoCode(prisma as never, { userId: 1, code: "GIFT", timezone: "UTC", now: NOW })
        const arg = prisma.promoCode.updateMany.mock.calls[0][0]
        expect(arg.data.redeemedCount).toEqual({ increment: 1 })
        expect(arg.data.redeemedCount).not.toBe(1)
    })
})

/* ──────────────────────────────────────────────────────────────────────────── */

describe("redeemPromoCode — grant اتمیک و per-feature", () => {
    it("بونوس هر بُعد در bucket جدا و مستقل می‌نشیند", async () => {
        const prisma = basePrisma()
        prisma.promoCode.findUnique.mockResolvedValue(
            promoRow({ bonusAnalyzeUnits: 5, bonusPlanUnits: 3 }),
        )

        const result = await redeemPromoCode(prisma as never, {
            userId: 7,
            code: "GIFT",
            timezone: "UTC",
            now: NOW,
        })

        expect(result.grantedFeatures).toEqual(["ANALYZE", "PLAN"])
        const upserts = prisma.aiQuotaBucket.upsert.mock.calls.map((c) => c[0])
        expect(upserts).toHaveLength(2)

        const analyze = upserts.find((u) => u.where.userId_feature_source_periodType_periodStart.feature === "ANALYZE")
        const plan = upserts.find((u) => u.where.userId_feature_source_periodType_periodStart.feature === "PLAN")

        expect(analyze.where.userId_feature_source_periodType_periodStart).toMatchObject({
            userId: 7,
            feature: "ANALYZE",
            source: "PROMO",
            periodType: "MONTHLY",
        })
        expect(analyze.update).toEqual({ grantedUnits: { increment: 5 } })
        expect(plan.update).toEqual({ grantedUnits: { increment: 3 } })
    })

    it("بونوس در همان کلیدی نوشته می‌شود که مسیر legacy می‌خواند (periodStart محلیِ کاربر)", async () => {
        // قراردادِ بین ریدم و مصرف: هر دو باید «شروع دورهٔ ماهانهٔ محلیِ کاربر» را
        // کلید بگیرند. اگر این دو کلید واگرا شوند، بونوس ثبت می‌شود ولی هیچ‌وقت
        // دیده یا مصرف نمی‌شود — دقیقاً باگی که برای کاربر رخ داد.
        const prisma = basePrisma()
        prisma.promoCode.findUnique.mockResolvedValue(
            promoRow({ bonusAnalyzeUnits: 5, bonusPlanUnits: 3 }),
        )
        const teheranNow = new Date("2026-09-30T08:45:00.000Z")

        const result = await redeemPromoCode(prisma as never, {
            userId: 7,
            code: "GIFT",
            timezone: "Asia/Tehran",
            now: teheranNow,
        })

        const upserts = prisma.aiQuotaBucket.upsert.mock.calls.map((c) => c[0])
        expect(upserts).toHaveLength(2)
        for (const u of upserts) {
            const key = u.where.userId_feature_source_periodType_periodStart
            expect(key.source).toBe("PROMO")
            expect(key.periodType).toBe("MONTHLY")
            expect(key.userId).toBe(7)
            // کلید = همان periodStart که سرویس به کاربر هم برمی‌گرداند
            expect(key.periodStart).toEqual(result.periodStart)
            expect(u.update).toEqual({ grantedUnits: { increment: expect.any(Number) } })
            // بونوسِ هر بُعد دقیقاً همان چیزی است که کد تعریف کرده
            expect(u.update.grantedUnits.increment).toBe(
                key.feature === "ANALYZE" ? 5 : 3,
            )
        }
    })

    it("بونوس صفر ⇒ آن بُعد bucket نمی‌سازد (ساختار تمیز می‌ماند)", async () => {
        const prisma = basePrisma()
        prisma.promoCode.findUnique.mockResolvedValue(
            promoRow({ bonusAnalyzeUnits: 5, bonusPlanUnits: 0 }),
        )
        const result = await redeemPromoCode(prisma as never, {
            userId: 7,
            code: "GIFT",
            timezone: "UTC",
            now: NOW,
        })
        expect(result.grantedFeatures).toEqual(["ANALYZE"])
        expect(prisma.aiQuotaBucket.upsert).toHaveBeenCalledTimes(1)
    })

    it("ریدیمپشن بونوس را snapshot می‌کند (تغییر بعدی کد معنا را عوض نمی‌کند)", async () => {
        const prisma = basePrisma()
        prisma.promoCode.findUnique.mockResolvedValue(
            promoRow({ bonusAnalyzeUnits: 5, bonusPlanUnits: 2 }),
        )
        await redeemPromoCode(prisma as never, {
            userId: 7,
            code: "GIFT",
            timezone: "UTC",
            now: NOW,
        })
        expect(prisma.promoRedemption.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                promoCodeId: "promo-1",
                userId: 7,
                bonusAnalyzeUnits: 5,
                bonusPlanUnits: 2,
                periodStart: new Date("2026-09-01T00:00:00.000Z"),
            }),
        })
    })

    it("periodStart از timezone کاربر می‌آید، نه از UTC سرور", async () => {
        const prisma = basePrisma()
        await redeemPromoCode(prisma as never, {
            userId: 7,
            code: "GIFT",
            timezone: "Asia/Tehran",
            now: NOW,
        })
        // شروع ماه سپتامبرِ تهران = ۳۱ اوت ۲۰:۳۰ UTC
        expect(prisma.promoRedemption.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ periodStart: new Date("2026-08-31T20:30:00.000Z") }),
        })
    })

    it("بنوس بعد از expire شدن کد معتبر می‌ماند (ساختار snapshot، بدون bonusExpiresAt)", async () => {
        const prisma = basePrisma()
        prisma.promoCode.findUnique.mockResolvedValue(promoRow({ bonusAnalyzeUnits: 5 }))
        const result = await redeemPromoCode(prisma as never, {
            userId: 7,
            code: "GIFT",
            timezone: "UTC",
            now: NOW,
        })
        expect(result.bonusAnalyzeUnits).toBe(5)
        // grant فقط در bucket دورهٔ فعلی انجام می‌شود؛ هیچ تاریخ انقضایی ثبت نمی‌شود
        const upsert = prisma.aiQuotaBucket.upsert.mock.calls[0][0]
        expect(Object.keys(upsert.create)).not.toContain("bonusExpiresAt")
        expect(Object.keys(upsert.create)).not.toContain("expiresAt")
    })
})

/* ──────────────────────────────────────────────────────────────────────────── */

describe("redeemPromoCode — اتمی‌بودن و rollback", () => {
    it("همهٔ نوشتن‌ها داخل transaction‌اند (روی prisma ریشه نوشته نمی‌شود)", async () => {
        const root = makePrisma()
        root.promoCode.findUnique.mockResolvedValue(promoRow())
        root.promoRedemption.findUnique.mockResolvedValue(null)

        const tx = makePrisma()
        tx.promoCode.updateMany.mockResolvedValue({ count: 1 })
        tx.promoRedemption.create.mockResolvedValue({ id: "r-1" })
        tx.aiQuotaBucket.upsert.mockResolvedValue({ id: 10 })
        wireSeparateTx(root, tx)

        await redeemPromoCode(root as never, {
            userId: 7,
            code: "GIFT",
            timezone: "UTC",
            now: NOW,
        })

        expect(root.promoCode.updateMany).not.toHaveBeenCalled()
        expect(root.promoRedemption.create).not.toHaveBeenCalled()
        expect(root.aiQuotaBucket.upsert).not.toHaveBeenCalled()
        expect(tx.promoCode.updateMany).toHaveBeenCalledTimes(1)
        expect(tx.promoRedemption.create).toHaveBeenCalledTimes(1)
    })

    it("شکست grant ⇒ fail-closed و بدون نوشتن روی ریشه (معادل rollback)", async () => {
        const root = makePrisma()
        root.promoCode.findUnique.mockResolvedValue(promoRow())
        root.promoRedemption.findUnique.mockResolvedValue(null)

        const tx = makePrisma()
        tx.promoCode.updateMany.mockResolvedValue({ count: 1 })
        tx.promoRedemption.create.mockResolvedValue({ id: "r-1" })
        tx.aiQuotaBucket.upsert.mockRejectedValue(new Error("bucket write failed"))
        wireSeparateTx(root, tx)

        await expect(
            redeemPromoCode(root as never, { userId: 7, code: "GIFT", timezone: "UTC", now: NOW }),
        ).rejects.toBeInstanceOf(QuotaUnavailableError)

        // چون updateMany شمارنده فقط داخل tx بود، یک DB واقعی آن را rollback می‌کند
        expect(root.promoCode.updateMany).not.toHaveBeenCalled()
    })

    it("خطای خواندن کد ⇒ fail-closed، نه پاسخ عمومیِ «کد نامعتبر»", async () => {
        const prisma = makePrisma()
        prisma.promoCode.findUnique.mockRejectedValue(new Error("db down"))
        await expect(
            redeemPromoCode(prisma as never, { userId: 1, code: "GIFT", timezone: "UTC", now: NOW }),
        ).rejects.toBeInstanceOf(QuotaUnavailableError)
    })
})

/* ────────────────────────────────────────────────────────────────────────── */
/* ضد-enumeration: یک پاسخ، پنج دلیل متفاوت                                  */
/* ────────────────────────────────────────────────────────────────────────── */

describe("redeemPromoCode — enumeration-resistant", () => {
    /** دلیلی که سمت سرور باید audit شود. */
    async function rejectionReasonOf(
        prisma: ReturnType<typeof makePrisma>,
    ): Promise<string | undefined> {
        const call = prisma.adminAuditLog.create.mock.calls.at(-1)?.[0]
        return (call?.data?.after as { reason?: string } | undefined)?.reason
    }

    it("پیدا نشد ⇒ PROMO_CODE_INVALID + audit(INVALID)", async () => {
        const prisma = basePrisma()
        prisma.promoCode.findUnique.mockResolvedValue(null)

        await expect(
            redeemPromoCode(prisma as never, { userId: 1, code: "NOPE", timezone: "UTC", now: NOW }),
        ).rejects.toBeInstanceOf(PromoCodeInvalidError)
        expect(await rejectionReasonOf(prisma)).toBe("INVALID")
    })

    it("غیرفعال ⇒ همان PROMO_CODE_INVALID + audit(INACTIVE)", async () => {
        const prisma = basePrisma()
        prisma.promoCode.findUnique.mockResolvedValue(promoRow({ isActive: false }))

        await expect(
            redeemPromoCode(prisma as never, { userId: 1, code: "GIFT", timezone: "UTC", now: NOW }),
        ).rejects.toBeInstanceOf(PromoCodeInvalidError)
        expect(await rejectionReasonOf(prisma)).toBe("INACTIVE")
    })

    it("هنوز معتبر نشده ⇒ همان PROMO_CODE_INVALID + audit(NOT_YET_VALID)", async () => {
        const prisma = basePrisma()
        prisma.promoCode.findUnique.mockResolvedValue(
            promoRow({ validFrom: new Date("2026-10-01T00:00:00.000Z") }),
        )

        await expect(
            redeemPromoCode(prisma as never, { userId: 1, code: "GIFT", timezone: "UTC", now: NOW }),
        ).rejects.toBeInstanceOf(PromoCodeInvalidError)
        expect(await rejectionReasonOf(prisma)).toBe("NOT_YET_VALID")
    })

    it("منقضی ⇒ همان PROMO_CODE_INVALID + audit(EXPIRED)", async () => {
        const prisma = basePrisma()
        prisma.promoCode.findUnique.mockResolvedValue(
            promoRow({ expiresAt: new Date("2026-09-10T00:00:00.000Z") }),
        )

        await expect(
            redeemPromoCode(prisma as never, { userId: 1, code: "GIFT", timezone: "UTC", now: NOW }),
        ).rejects.toBeInstanceOf(PromoCodeInvalidError)
        expect(await rejectionReasonOf(prisma)).toBe("EXPIRED")
    })

    it("ظرفیت تمام ⇒ همان PROMO_CODE_INVALID + audit(EXHAUSTED)", async () => {
        const prisma = basePrisma()
        prisma.promoCode.findUnique.mockResolvedValue(promoRow({ maxRedemptions: 1 }))
        prisma.promoCode.updateMany.mockResolvedValue({ count: 0 })

        await expect(
            redeemPromoCode(prisma as never, { userId: 1, code: "GIFT", timezone: "UTC", now: NOW }),
        ).rejects.toBeInstanceOf(PromoCodeInvalidError)
        expect(await rejectionReasonOf(prisma)).toBe("EXHAUSTED")
    })

    it("PROMO_EXHAUSTED دیگر هیچ‌جا وجود ندارد (پاسخِ افشاگر حذف شد)", async () => {
        // قفل صریح: اگر کسی دوباره کدِ جداگانه برگرداند، این تست قرمز می‌شود.
        const prisma = basePrisma()
        prisma.promoCode.findUnique.mockResolvedValue(promoRow({ maxRedemptions: 1 }))
        prisma.promoCode.updateMany.mockResolvedValue({ count: 0 })

        const error = await redeemPromoCode(prisma as never, {
            userId: 1,
            code: "GIFT",
            timezone: "UTC",
            now: NOW,
        }).catch((e: unknown) => e)

        expect((error as { code?: string }).code).toBe("PROMO_CODE_INVALID")
        expect((error as { code?: string }).code).not.toBe("PROMO_EXHAUSTED")
    })

    it("همهٔ حالت‌های رد، status و message یکسان می‌دهند (client قابل تفکیک نیست)", async () => {
        const cases = [
            { row: null as unknown, label: "INVALID" },
            { row: promoRow({ isActive: false }), label: "INACTIVE" },
            { row: promoRow({ validFrom: new Date("2026-10-01T00:00:00.000Z") }), label: "NOT_YET_VALID" },
            { row: promoRow({ expiresAt: new Date("2026-09-01T00:00:00.000Z") }), label: "EXPIRED" },
        ]

        const seen: { status: number; code: string; message: string }[] = []
        for (const { row, label } of cases) {
            const prisma = basePrisma()
            prisma.promoCode.findUnique.mockResolvedValue(row)
            const err = (await redeemPromoCode(prisma as never, {
                userId: 1,
                code: "GIFT",
                timezone: "UTC",
                now: NOW,
            }).catch((e: unknown) => e)) as { status: number; code: string; message: string }
            expect(err.code, label).toBe("PROMO_CODE_INVALID")
            seen.push({ status: err.status, code: err.code, message: err.message })
        }

        // ظرفیت تمام هم دقیقاً همان سه فیلد را دارد
        const capPrisma = basePrisma()
        capPrisma.promoCode.findUnique.mockResolvedValue(promoRow({ maxRedemptions: 1 }))
        capPrisma.promoCode.updateMany.mockResolvedValue({ count: 0 })
        const capErr = (await redeemPromoCode(capPrisma as never, {
            userId: 1,
            code: "GIFT",
            timezone: "UTC",
            now: NOW,
        }).catch((e: unknown) => e)) as { status: number; code: string; message: string }
        seen.push({ status: capErr.status, code: capErr.code, message: capErr.message })

        expect(new Set(seen.map((s) => s.status)).size).toBe(1)
        expect(new Set(seen.map((s) => s.code)).size).toBe(1)
        expect(new Set(seen.map((s) => s.message)).size).toBe(1)
    })

    it("ALREADY_REDEEMED تنها پاسخِ متمایز است (oracle عمومی نمی‌سازد)", async () => {
        const prisma = basePrisma()
        prisma.promoRedemption.findUnique.mockResolvedValue({ id: "r-existing" })

        await expect(
            redeemPromoCode(prisma as never, { userId: 1, code: "GIFT", timezone: "UTC", now: NOW }),
        ).rejects.toBeInstanceOf(PromoAlreadyRedeemedError)
        expect(await rejectionReasonOf(prisma)).toBe("ALREADY_REDEEMED")
    })

    it("متنِ کدِ نامعتبر ذخیره نمی‌شود — audit ورودیِ مهاجم را تکرار نمی‌کند", async () => {
        const prisma = basePrisma()
        prisma.promoCode.findUnique.mockResolvedValue(null)

        await redeemPromoCode(prisma as never, {
            userId: 1,
            code: "ATTACKER-SUPPLIED-GUESS",
            timezone: "UTC",
            now: NOW,
        }).catch(() => undefined)

        const call = prisma.adminAuditLog.create.mock.calls.at(-1)?.[0]
        expect(JSON.stringify(call?.data)).not.toContain("ATTACKER")
    })

    it("نوشتن audit هرگز ریدیمپشن را از کار نمی‌اندازد (best-effort)", async () => {
        // خرابی audit نباید پاسخ عمومی را به 503 تبدیل کند؛ `writeAdminAuditLog`
        // خودش swallow می‌کند و این تست آن را از بیرون قفل می‌کند.
        const prisma = basePrisma()
        prisma.adminAuditLog.create.mockRejectedValue(new Error("audit down"))
        prisma.promoCode.findUnique.mockResolvedValue(null)

        await expect(
            redeemPromoCode(prisma as never, { userId: 1, code: "GIFT", timezone: "UTC", now: NOW }),
        ).rejects.toBeInstanceOf(PromoCodeInvalidError)
    })
})
