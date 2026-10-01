-- AI Quota — چرخهٔ سهمیه بر پایهٔ اشتراک (مسیر A)
--
-- چرا این مهاجرت:
--   مرز دورهٔ سهمیه قبلاً اولِ ماهِ تقویمیِ کاربر بود و هیچ ربطی به مرز اشتراک نداشت.
--   نتیجه: خرید ۳۰ روزه در آخرین روز ماه ⇒ دو دورهٔ کامل سهمیه بدون پول بیشتر، و
--   عدد وعده‌داده‌شده در کارت فروش (۳۰ روزه = ۲۷۰ تحلیل) قابل تضمین نبود.
--
-- این مهاجبت فقط **زیرساخت** می‌سازد؛ رفتار را `app/lib/services/quotaWindow.ts`
-- می‌خواند و با backfill پایین پشتیبانی می‌شود (ستون‌ها nullable می‌مانند تا
-- استقرار و rollback بدون ریسک باشد).

-- ── ۱) لنگر دورهٔ سهمیهٔ کاربر ───────────────────────────────────────────────
-- برای کاربر PRO از `Entitlement.currentPeriodStart` استفاده می‌شود (runtime) و
-- این ستون فقط لنگر پایهٔ کاربران بدون اشتراک فعال است.
ALTER TABLE "User" ADD COLUMN "quotaAnchorAt" TIMESTAMP(3);

-- ── ۲) snapshot ظرفیت دوره ─────────────────────────────────────────────────
-- تا پیش از این ستون، سقف BASE هر بار زنده از `AiQuotaPolicy` خوانده می‌شد؛ یعنی
-- تغییرِ بعدیِ policy سقفِ دوره‌های گذشته را هم عوض می‌کرد و تضمینِ «۹۰ روزه = ۸۱۰
-- تحلیل» می‌شکست. از این پس ظرفیت در لحظهٔ ایجاد دوره snapshot می‌شود.
ALTER TABLE "AiQuotaBucket" ADD COLUMN "capacityUnits" INTEGER;

-- ── ۳) backfill لنگر کاربران ─────────────────────────────────────────────────
-- مبنا: قدیمی‌ترین ردیف مصرفِ کاربر (`AiUsage.periodStart`) — یعنی همان لحظه‌ای که
-- کاربر عملاً وارد چرخهٔ سهمیه شد. کاربرِ بدون هیچ مصرفی → زمانِ همین مهاجرت.
--
-- چرا نه `User.createdAt`: ستون `createdAt` روی مدل User وجود ندارد، و افزودنش
-- فقط برای این backfill ارزش هزینه ندارد.
UPDATE "User" u
SET "quotaAnchorAt" = COALESCE(
    (
        SELECT MIN(a."periodStart")
        FROM "AiUsage" a
        WHERE a."userId" = u."id"
    ),
    CURRENT_TIMESTAMP
)
WHERE u."quotaAnchorAt" IS NULL;

-- ── ۴) backfill ظرفیت ردیف‌های BASE موجود ───────────────────────────────────
-- ردیف‌های BASE که از قبل ساخته شده‌اند باید ظرفیت snapshot داشته باشند، وگرنه
-- `remaining` بعد از استقرار به‌جای مقدار زنده، صفر می‌شد و سهمیهٔ مصرف‌نشدهٔ
-- کاربر از بین می‌رفت.
UPDATE "AiQuotaBucket" b
SET "capacityUnits" = p."allowedUnits"
FROM "AiQuotaPolicy" p
WHERE b."source" = 'BASE'
  AND b."capacityUnits" IS NULL
  AND p."plan" = 'PRO'
  AND p."feature" = b."feature";

-- ردیف‌های BASEای که کاربرشان FREE بوده‌اند (یا policy متناظر نبوده) با سقف 0
-- fail-closed می‌شوند تا هرگز «سهمیهٔ رایگانِ بی‌سقف» باز نشود؛ runtime در
-- دورهٔ بعد خودش سقف درست را snapshot می‌کند.
UPDATE "AiQuotaBucket" b
SET "capacityUnits" = 0
WHERE b."source" = 'BASE'
  AND b."capacityUnits" IS NULL;

-- ── ۵) invariants ───────────────────────────────────────────────────────────
ALTER TABLE "AiQuotaBucket"
    ADD CONSTRAINT "AiQuotaBucket_capacity_non_negative"
        CHECK ("capacityUnits" IS NULL OR "capacityUnits" >= 0);

-- قاعدهٔ شکل: `grantedUnits` فقط مال PROMO است (بونوس قابل‌جمع) و `capacityUnits`
-- فقط مال BASE است (snapshot سقف دوره). حالت NULL برای هر دو مجاز است تا
-- backfill و استقرار مرحله‌ای ممکن باشد.
ALTER TABLE "AiQuotaBucket" DROP CONSTRAINT IF EXISTS "AiQuotaBucket_source_shape";
ALTER TABLE "AiQuotaBucket"
    ADD CONSTRAINT "AiQuotaBucket_source_shape" CHECK (
        ("source" = 'BASE'  AND "grantedUnits" IS NULL) OR
        ("source" = 'PROMO' AND "grantedUnits" IS NOT NULL)
    ),
    ADD CONSTRAINT "AiQuotaBucket_capacity_only_base" CHECK (
        ("source" = 'BASE' AND "capacityUnits" IS NOT NULL) OR
        ("source" = 'PROMO' AND "capacityUnits" IS NULL)
    );