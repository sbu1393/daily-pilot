// AI Quota v2 — تست‌های منبع حقیقت سقف‌ها
//
// سه چیز قفل می‌شود:
//  1) مقادیر نهایی محصول دقیقاً ۱۵/۲/۲۷۰/۵۰ هستند (از خودِ فایل migration خوانده
//     می‌شوند، نه از یک ثابت در تست — وگرنه هر دو با هم جابه‌جا می‌شدند).
//  2) سقف **زنده از DB** خوانده می‌شود: اگر mock مقدار ۷ برگرداند، سرویس باید ۷
//     بدهد نه ۱۵. این مهم‌ترین ضد-تستِ «hard-code شدن سقف» است.
//  3) کلاینت نمی‌تواند plan/units/bonus/userId را تحمیل کند.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
    AI_FEATURE_SPECS,
    InvalidQuotaPolicyError,
    MultiUnitNotAllowedError,
    assertQuotaUnitsAllowed,
    normalizePlan,
    readQuotaPolicy,
    resolveQuotaFeature,
    resolveUserQuota,
    UnknownAiFeatureError,
    updateQuotaPolicy,
} from "./quotaPolicy.service"
import { QuotaUnavailableError } from "./errors"
import {
    createPromoCodeSchema,
    redeemPromoCodeSchema,
    updateQuotaPolicySchema,
} from "@/app/schema/aiQuotaSchema"

const POLICY_MIGRATION = join(
    process.cwd(),
    "prisma",
    "migrations",
    "20260929120000_add_ai_quota_policy_and_buckets",
    "migration.sql",
)

function makePrisma() {
    return {
        aiQuotaPolicy: {
            findUnique: vi.fn(),
            update: vi.fn(),
            create: vi.fn(),
            findMany: vi.fn(),
        },
        adminAuditLog: { create: vi.fn() },
    }
}

describe("مقادیر نهایی محصول (seed)", () => {
    const sql = readFileSync(POLICY_MIGRATION, "utf8")

    it("FREE/ANALYZE = 15", () => {
        expect(sql).toContain("('FREE', 'ANALYZE', 15,")
    })
    it("FREE/PLAN = 2", () => {
        expect(sql).toContain("('FREE', 'PLAN',    2,")
    })
    it("PRO/ANALYZE = 270", () => {
        expect(sql).toContain("('PRO',  'ANALYZE', 270,")
    })
    it("PRO/PLAN = 50", () => {
        expect(sql).toContain("('PRO',  'PLAN',    50,")
    })

    it("مقادیر قدیمیِ ردشده دیگر در migration نیستند", () => {
        expect(sql).not.toContain("'FREE', 'PLAN',    15,")
        expect(sql).not.toContain("'PRO',  'PLAN',    300,")
        expect(sql).not.toContain("'PRO',  'ANALYZE', 300,")
    })
})

describe("resolveQuotaFeature — هزینه و بُعد، فقط سمت سرور", () => {
    it("analyze → بُعد ANALYZE با ۱ واحد", () => {
        expect(resolveQuotaFeature("analyze")).toEqual({
            dimension: "ANALYZE",
            units: 1,
            multiUnit: false,
            name: "analyze",
        })
    })

    it("plan → بُعد PLAN با ۱ واحد", () => {
        expect(resolveQuotaFeature("plan").dimension).toBe("PLAN")
        expect(resolveQuotaFeature("plan").units).toBe(1)
    })

    it("دو بُعد کاملاً مستقل‌اند", () => {
        expect(resolveQuotaFeature("analyze").dimension).not.toBe(resolveQuotaFeature("plan").dimension)
    })

    it("ai-test دیگر فیچر سهمیه‌ای نیست و عمداً throw می‌شود", () => {
        // تصمیم قطعی: endpoint تشخیصی `GET /api/ai/test` سهمیه‌ی محصول مصرف نمی‌کند
        // (در production ۴۰۴ است و UI/caller ندارد). نه به ANALYZE نگاشت می‌شود و نه
        // feature جدیدی می‌گیرد — پس جدول سیاست دقیقاً ۴ ترکیب محصول را نگه می‌دارد.
        expect(() => resolveQuotaFeature("ai-test")).toThrow(UnknownAiFeatureError)
    })

    it("جدول featureها دقیقاً همان دو قابلیت محصول است", () => {
        expect(Object.keys(AI_FEATURE_SPECS).sort()).toEqual(["analyze", "plan"])
    })

    it("هر دو فیچر محصول تک‌واحدی‌اند (M2: multiUnit = false)", () => {
        expect(resolveQuotaFeature("analyze").units).toBe(1)
        expect(resolveQuotaFeature("analyze").multiUnit).toBe(false)
        expect(resolveQuotaFeature("plan").units).toBe(1)
        expect(resolveQuotaFeature("plan").multiUnit).toBe(false)
    })

    it("فیچر ثبت‌نشده throw می‌شود (پیش‌فرض خاموش نداریم)", () => {
        expect(() => resolveQuotaFeature("new-gpt-thing")).toThrow(UnknownAiFeatureError)
    })
})

/* ------------------------------------------------------------------ */
/* M2 — گارد هزینه: `units > 1` فقط با اعلام صریح `multiUnit: true`    */
/* ------------------------------------------------------------------ */
describe("M2 — assertQuotaUnitsAllowed (چندواحدی فقط با اعلام صریح)", () => {
    it("هزینهٔ ۱ برای هر دو فیچر مجاز است", () => {
        expect(() => assertQuotaUnitsAllowed("analyze", 1)).not.toThrow()
        expect(() => assertQuotaUnitsAllowed("plan", 1)).not.toThrow()
    })

    it("هزینهٔ > ۱ برای فیچر تک‌واحدی fail-fast می‌شود (۴۰۰، نه ۵۰۳)", () => {
        // دلیل ۴۰۰: یک باگ برنامه‌نویسی است، نه خرابی زیرساخت.
        expect(() => assertQuotaUnitsAllowed("analyze", 2)).toThrow(MultiUnitNotAllowedError)
        expect(() => assertQuotaUnitsAllowed("analyze", 500)).toThrow(MultiUnitNotAllowedError)
        expect(() => assertQuotaUnitsAllowed("plan", 3)).toThrow(MultiUnitNotAllowedError)
    })

    it("پیام خطا نام فیچر و هزینهٔ اعلام‌نشده را افشا می‌کند (قابل رفع اشکال)", () => {
        try {
            assertQuotaUnitsAllowed("analyze", 7)
            expect.unreachable("باید throw می‌کرد")
        } catch (error) {
            expect(error).toBeInstanceOf(MultiUnitNotAllowedError)
            expect((error as MultiUnitNotAllowedError).code).toBe("AI_FEATURE_NOT_MULTI_UNIT")
            expect((error as MultiUnitNotAllowedError).message).toContain("analyze")
            expect((error as MultiUnitNotAllowedError).message).toContain("7")
        }
    })

    it("عدد نامعتبر (NaN / صفر / منفی / غیرصحیح) هم fail-fast می‌شود", () => {
        expect(() => assertQuotaUnitsAllowed("analyze", Number.NaN)).toThrow(MultiUnitNotAllowedError)
        expect(() => assertQuotaUnitsAllowed("analyze", 0)).toThrow(MultiUnitNotAllowedError)
        expect(() => assertQuotaUnitsAllowed("analyze", -1)).toThrow(MultiUnitNotAllowedError)
        expect(() => assertQuotaUnitsAllowed("analyze", 1.5)).toThrow(MultiUnitNotAllowedError)
    })

    it("فیچر ثبت‌نشده اول در resolve شکست می‌خورد، بعد در guard", () => {
        // ترتیب عمدی: چون cost=1 برای فیچر ناشناخته هم reject می‌شود،
        // `UnknownAiFeatureError` باید اول بیاید تا پیام گمراه‌کننده ندهد.
        expect(() => assertQuotaUnitsAllowed("ai-test", 1)).toThrow(UnknownAiFeatureError)
    })

    it("هیچ فیچر فعلی multiUnit نیست ⇒ جدول هزینه بسته و تک‌واحدی است", () => {
        for (const spec of Object.values(AI_FEATURE_SPECS)) {
            expect(spec.multiUnit).toBe(false)
            expect(spec.units).toBe(1)
        }
    })
})

describe("normalizePlan", () => {
    it("PRO → PRO", () => expect(normalizePlan("PRO")).toBe("PRO"))
    it("FREE → FREE", () => expect(normalizePlan("FREE")).toBe("FREE"))
    it("null/undefined/garbage → FREE (هرگز PRO)", () => {
        expect(normalizePlan(null)).toBe("FREE")
        expect(normalizePlan(undefined)).toBe("FREE")
        expect(normalizePlan("pro")).toBe("FREE")
        expect(normalizePlan("HACKED_PRO")).toBe("FREE")
    })
})

describe("readQuotaPolicy — سقف زنده از DB، نه hard-code", () => {
    let prisma: ReturnType<typeof makePrisma>

    beforeEach(() => {
        prisma = makePrisma()
    })

    it("هرچه DB بگوید برمی‌گرداند (حتی عددی غیر از مقدار محصول)", async () => {
        prisma.aiQuotaPolicy.findUnique.mockResolvedValue({ allowedUnits: 7 })
        await expect(readQuotaPolicy(prisma as never, "FREE", "ANALYZE")).resolves.toBe(7)
    })

    it("برای FREE/PLAN هم مقدار DB را می‌دهد، نه ۱۵", async () => {
        prisma.aiQuotaPolicy.findUnique.mockResolvedValue({ allowedUnits: 2 })
        await expect(readQuotaPolicy(prisma as never, "FREE", "PLAN")).resolves.toBe(2)
    })

    it("کلید یونیک دقیقاً (plan, feature) است", async () => {
        prisma.aiQuotaPolicy.findUnique.mockResolvedValue({ allowedUnits: 270 })
        await readQuotaPolicy(prisma as never, "PRO", "ANALYZE")
        expect(prisma.aiQuotaPolicy.findUnique).toHaveBeenCalledWith({
            where: { plan_feature: { plan: "PRO", feature: "ANALYZE" } },
            select: { allowedUnits: true },
        })
    })

    it("ردیف گمشده ⇒ fail-closed، نه «نامحدود»", async () => {
        prisma.aiQuotaPolicy.findUnique.mockResolvedValue(null)
        await expect(readQuotaPolicy(prisma as never, "FREE", "ANALYZE")).rejects.toBeInstanceOf(
            QuotaUnavailableError,
        )
    })

    it("خطای DB ⇒ fail-closed", async () => {
        prisma.aiQuotaPolicy.findUnique.mockRejectedValue(new Error("connection reset"))
        await expect(readQuotaPolicy(prisma as never, "PRO", "PLAN")).rejects.toBeInstanceOf(
            QuotaUnavailableError,
        )
    })
})

describe("resolveUserQuota", () => {
    it("plan نامعتبر کاربر به FREE نگاشت و از DB خوانده می‌شود", async () => {
        const prisma = makePrisma()
        prisma.aiQuotaPolicy.findUnique.mockResolvedValue({ allowedUnits: 2 })
        await expect(
            resolveUserQuota(prisma as never, { plan: "<script>" }, "PLAN"),
        ).resolves.toEqual({ plan: "FREE", feature: "PLAN", allowedUnits: 2 })
    })
})

describe("updateQuotaPolicy — ادمین", () => {
    let prisma: ReturnType<typeof makePrisma>

    beforeEach(() => {
        prisma = makePrisma()
        prisma.aiQuotaPolicy.findUnique.mockResolvedValue({
            plan: "FREE",
            feature: "PLAN",
            allowedUnits: 2,
        })
        prisma.aiQuotaPolicy.update.mockResolvedValue({})
        prisma.adminAuditLog.create.mockResolvedValue({ id: "log-1" })
    })

    it("مقدار منفی را رد می‌کند", async () => {
        await expect(
            updateQuotaPolicy(prisma as never, {
                plan: "FREE",
                feature: "PLAN",
                allowedUnits: -1,
                actorUserId: 1,
            }),
        ).rejects.toBeInstanceOf(InvalidQuotaPolicyError)
        expect(prisma.aiQuotaPolicy.update).not.toHaveBeenCalled()
    })

    it("عدد غیرصحیح (float) را رد می‌کند", async () => {
        await expect(
            updateQuotaPolicy(prisma as never, {
                plan: "PRO",
                feature: "ANALYZE",
                allowedUnits: 2.5,
                actorUserId: 1,
            }),
        ).rejects.toBeInstanceOf(InvalidQuotaPolicyError)
    })

    it("کاهش سقف وسط ماه مجاز است و شمارنده‌ها را دست نمی‌زند", async () => {
        await expect(
            updateQuotaPolicy(prisma as never, {
                plan: "FREE",
                feature: "PLAN",
                allowedUnits: 1,
                actorUserId: 42,
            }),
        ).resolves.toEqual({ plan: "FREE", feature: "PLAN", allowedUnits: 1 })
        // فقط policy به‌روزرسانی می‌شود؛ هیچ bucketای نوشته نمی‌شود
        expect(prisma.aiQuotaPolicy.update).toHaveBeenCalledTimes(1)
        expect(prisma.aiQuotaPolicy.create).not.toHaveBeenCalled()
    })

    it("before/after را در AdminAuditLog ثبت می‌کند", async () => {
        await updateQuotaPolicy(prisma as never, {
            plan: "FREE",
            feature: "PLAN",
            allowedUnits: 5,
            actorUserId: 42,
            requestId: "req-9",
        })
        expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                actorUserId: 42,
                action: "quota_policy.updated",
                targetId: "FREE:PLAN",
                before: { allowedUnits: 2 },
                after: { allowedUnits: 5 },
                requestId: "req-9",
            }),
        })
    })

    it("ردیف ناموجود را به‌جای خطا ایجاد می‌کند (policy همیشه کامل)", async () => {
        prisma.aiQuotaPolicy.findUnique.mockResolvedValue(null)
        prisma.aiQuotaPolicy.create.mockResolvedValue({})
        await updateQuotaPolicy(prisma as never, {
            plan: "PRO",
            feature: "PLAN",
            allowedUnits: 50,
            actorUserId: 1,
        })
        expect(prisma.aiQuotaPolicy.create).toHaveBeenCalledWith({
            data: expect.objectContaining({ plan: "PRO", feature: "PLAN", allowedUnits: 50 }),
        })
    })

    it("شکست audit جریان عملیات را fail نمی‌کند (best-effort)", async () => {
        prisma.adminAuditLog.create.mockRejectedValue(new Error("audit table down"))
        await expect(
            updateQuotaPolicy(prisma as never, {
                plan: "FREE",
                feature: "ANALYZE",
                allowedUnits: 20,
                actorUserId: 1,
            }),
        ).resolves.toEqual({ plan: "FREE", feature: "ANALYZE", allowedUnits: 20 })
    })
})

describe("اعتبارسنجی ورودی — کلاینت نمی‌تواند سهمیه/پلن/بونوس را تحمیل کند", () => {
    it("redeem فقط code می‌پذیرد و کلید اضافه را رد می‌کند", () => {
        expect(redeemPromoCodeSchema.safeParse({ code: "GIFT" }).success).toBe(true)
        expect(redeemPromoCodeSchema.safeParse({ code: "GIFT", userId: 1 }).success).toBe(false)
        expect(
            redeemPromoCodeSchema.safeParse({ code: "GIFT", bonusAnalyzeUnits: 9999 }).success,
        ).toBe(false)
        expect(redeemPromoCodeSchema.safeParse({ code: "GIFT", plan: "PRO" }).success).toBe(false)
        expect(redeemPromoCodeSchema.safeParse({ code: "GIFT", units: 0 }).success).toBe(false)
    })

    it("policy update کلید اضافه را رد می‌کند", () => {
        expect(
            updateQuotaPolicySchema.safeParse({ plan: "PRO", feature: "ANALYZE", allowedUnits: 5 })
                .success,
        ).toBe(true)
        expect(
            updateQuotaPolicySchema.safeParse({
                plan: "PRO",
                feature: "ANALYZE",
                allowedUnits: 5,
                actorUserId: 1,
            }).success,
        ).toBe(false)
    })

    it("policy update سقف منفی/بزرگ را رد می‌کند", () => {
        expect(
            updateQuotaPolicySchema.safeParse({ plan: "PRO", feature: "ANALYZE", allowedUnits: -1 })
                .success,
        ).toBe(false)
        expect(
            updateQuotaPolicySchema.safeParse({
                plan: "PRO",
                feature: "ANALYZE",
                allowedUnits: 10_000_000,
            }).success,
        ).toBe(false)
    })

    it("ساخت promo بدون بونوس یا با انقضای نامعتبر رد می‌شود", () => {
        const base = {
            code: "GIFT",
            validFrom: "2026-09-01T00:00:00.000Z",
            expiresAt: "2026-10-01T00:00:00.000Z",
        }
        expect(
            createPromoCodeSchema.safeParse({ ...base, bonusAnalyzeUnits: 0, bonusPlanUnits: 0 })
                .success,
        ).toBe(false)
        expect(
            createPromoCodeSchema.safeParse({
                ...base,
                validFrom: "2026-10-01T00:00:00.000Z",
                expiresAt: "2026-09-01T00:00:00.000Z",
                bonusAnalyzeUnits: 5,
                bonusPlanUnits: 0,
            }).success,
        ).toBe(false)
        expect(
            createPromoCodeSchema.safeParse({ ...base, bonusAnalyzeUnits: 5, bonusPlanUnits: 0 })
                .success,
        ).toBe(true)
    })

    it("ساخت promo با کلید اضافه (مثلاً redeemedCount) رد می‌شود", () => {
        expect(
            createPromoCodeSchema.safeParse({
                code: "GIFT",
                validFrom: "2026-09-01T00:00:00.000Z",
                expiresAt: "2026-10-01T00:00:00.000Z",
                bonusAnalyzeUnits: 5,
                bonusPlanUnits: 0,
                redeemedCount: 999,
            }).success,
        ).toBe(false)
    })
})
