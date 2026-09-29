-- AlterTable
ALTER TABLE "AiUsageEvent" ADD COLUMN     "bucketId" INTEGER,
ADD COLUMN     "fallbackUsed" BOOLEAN,
ADD COLUMN     "policyAllowedUnits" INTEGER,
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "quotaSource" "AiQuotaSource";

-- CreateIndex
CREATE INDEX "AiUsageEvent_status_createdAt_idx" ON "AiUsageEvent"("status", "createdAt");

-- ═════════════════════════════════════════════════════════════════════════════
-- AI Quota v2 — Phase 1: AiUsageEvent audit metadata (schema only)
--
-- چرا این ستون‌ها:
--   provider            → provider واقعیِ همان عملیات ("openrouter" | "1xai")،
--                         نه مقدار ثابت/documented
--   fallbackUsed        → آیا پاسخ از provider جایگزین آمده است
--   quotaSource         → این عملیات روی کدام bucket حساب شد (BASE یا PROMO)
--   policyAllowedUnits  → snapshot سقف BASE در لحظه‌ی رزرو؛ اگر ادمین سقف را
--                         وسط ماه عوض کند، audit هنوز می‌تواند تشخیص دهد عملیات
--                         قبلی تحت چه ظرفیتی انجام شده است
--   bucketId            → id همان AiQuotaBucket (عمداً بدون FK، مثل الگوی موجود
--                         PaymentOrder.entitlementId)؛ complete/release را قطعی
--                         می‌کند و ابهام «آخرین دوره» را حذف می‌کند
--
-- هر پنج ستون NULLABLE‌اند: همه‌ی رکوردهای قبلی معتبر می‌مانند و معنایشان
-- «نامعلوم/legacy» است — هیچ backfill و هیچ حدس تاریخی زده نمی‌شود.
--
-- ایندکس (status, createdAt) برای job بازیابی رزروهای یتیم
-- (RESERVED + قدیمی‌تر از سقف زمانی عملیات) اضافه می‌شود.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── invariant: فیلدهای audit باید هم‌راستا باشند ─────────────────────────────
-- (bucketId و quotaSource همیشه با هم ست می‌شوند یا هیچ‌کدام)
ALTER TABLE "AiUsageEvent"
    ADD CONSTRAINT "AiUsageEvent_bucket_source_together"
        CHECK (("bucketId" IS NULL) = ("quotaSource" IS NULL)),
    ADD CONSTRAINT "AiUsageEvent_policyAllowedUnits_non_negative"
        CHECK ("policyAllowedUnits" IS NULL OR "policyAllowedUnits" >= 0);
