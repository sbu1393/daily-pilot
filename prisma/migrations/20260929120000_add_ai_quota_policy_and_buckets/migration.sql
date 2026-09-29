-- CreateEnum
CREATE TYPE "AiFeature" AS ENUM ('ANALYZE', 'PLAN');

-- CreateEnum
CREATE TYPE "AiQuotaSource" AS ENUM ('BASE', 'PROMO');

-- CreateTable
CREATE TABLE "AiQuotaPolicy" (
    "id" SERIAL NOT NULL,
    "plan" "UserPlan" NOT NULL,
    "feature" "AiFeature" NOT NULL,
    "allowedUnits" INTEGER NOT NULL,
    "updatedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiQuotaPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiQuotaBucket" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "feature" "AiFeature" NOT NULL,
    "source" "AiQuotaSource" NOT NULL,
    "periodType" "AiUsagePeriodType" NOT NULL DEFAULT 'MONTHLY',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "grantedUnits" INTEGER,
    "reservedUnits" INTEGER NOT NULL DEFAULT 0,
    "consumedUnits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiQuotaBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiQuotaCutover" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "cutoverAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiQuotaCutover_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiQuotaPolicy_plan_feature_key" ON "AiQuotaPolicy"("plan", "feature");

-- CreateIndex
CREATE INDEX "AiQuotaBucket_userId_periodStart_idx" ON "AiQuotaBucket"("userId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "AiQuotaBucket_userId_feature_source_periodType_periodStart_key" ON "AiQuotaBucket"("userId", "feature", "source", "periodType", "periodStart");

-- AddForeignKey
ALTER TABLE "AiQuotaBucket" ADD CONSTRAINT "AiQuotaBucket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═════════════════════════════════════════════════════════════════════════════
-- AI Quota v2 — Phase 1 (schema + reference data only; runtime behavior unchanged)
--
-- این migration هیچ جدول/ستون/ردیفی را حذف یا بازنویسی نمی‌کند:
-- AiUsage و AiUsageEvent (legacy) کاملاً دست‌نخورده می‌مانند و تا لحظه‌ی cutover
-- تنها منبع حقیقت مصرف باقی می‌مانند.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── invariants (DB-level، مستقل از application) ──────────────────────────────
ALTER TABLE "AiQuotaPolicy"
    ADD CONSTRAINT "AiQuotaPolicy_allowedUnits_non_negative" CHECK ("allowedUnits" >= 0);

ALTER TABLE "AiQuotaBucket"
    ADD CONSTRAINT "AiQuotaBucket_reserved_non_negative" CHECK ("reservedUnits" >= 0),
    ADD CONSTRAINT "AiQuotaBucket_consumed_non_negative" CHECK ("consumedUnits" >= 0),
    ADD CONSTRAINT "AiQuotaBucket_granted_non_negative"
        CHECK ("grantedUnits" IS NULL OR "grantedUnits" >= 0),
    -- BASE سقفش از policy زنده می‌آید (بدون grantedUnits)؛ PROMO سقفش bonus است.
    ADD CONSTRAINT "AiQuotaBucket_source_shape" CHECK (
        ("source" = 'BASE'  AND "grantedUnits" IS NULL) OR
        ("source" = 'PROMO' AND "grantedUnits" IS NOT NULL)
    );

-- تک‌ردیفی بودن مرز گذار
ALTER TABLE "AiQuotaCutover"
    ADD CONSTRAINT "AiQuotaCutover_single_row" CHECK ("id" = 1);

-- ── seed: سقف per (plan × feature) — ۴ ردیف ──────────────────────────────────
-- مقادیر نهایی محصول (LOCKED). دو feature کاملاً مستقل‌اند:
-- مصرف ANALYZE از سهمیه‌ی PLAN کم نمی‌کند و برعکس؛ promo bonus هم per-feature
-- snapshot می‌شود. سقف از این پس فقط از همین جدول خوانده می‌شود (هیچ عددی
-- در source code hard-code نمی‌شود) و ادمین می‌تواند بدون deploy تغییرش دهد.
--
--   plan | ANALYZE | PLAN
--   -----+---------+------
--   FREE |      15 |    2
--   PRO  |     270 |   50
INSERT INTO "AiQuotaPolicy" ("plan", "feature", "allowedUnits", "updatedAt") VALUES
    ('FREE', 'ANALYZE', 15,  CURRENT_TIMESTAMP),
    ('FREE', 'PLAN',    2,  CURRENT_TIMESTAMP),
    ('PRO',  'ANALYZE', 270, CURRENT_TIMESTAMP),
    ('PRO',  'PLAN',    50, CURRENT_TIMESTAMP)
ON CONFLICT ("plan", "feature") DO NOTHING;

-- ── seed: مرز گذار legacy ⇄ جدید (تک‌ردیف) ───────────────────────────────────
-- قاعده‌ی قطعی (تنها مرجع؛ پیاده‌سازی در app/lib/services/aiQuotaCutover.service.ts):
--     LEGACY ⟺ periodStart < nextPeriodStartOf(cutoverAt, user.timezone)
-- یعنی آخرین دوره‌ی legacy همان دوره‌ای است که cutoverAt را در بر می‌گیرد و از
-- دوره‌ی بعد، AiQuotaBucket authoritative می‌شود. اگر cutoverAt دقیقاً روی
-- periodStart بیفتد، همان دوره NEW است (مرز بسته به سمت راست است، نه چپ).
-- مقایسه per-user و بر اساس instant انجام می‌شود تا کاربران non-UTC
-- (مثل Asia/Tehran) درست گذر کنند. هیچ usage تاریخی به ANALYZE/PLAN نسبت
-- داده نمی‌شود (بدون backfill، بدون over-grant).
--
-- مقدار اولیه = آغاز ماه اکتبر به وقت محلی تهران (UTC+3:30)
--   ⇒ 2026-09-30T20:30:00Z
--
-- چرا نه '2026-10-01 00:00:00+00': آن instant در تهران 03:30 روز ۱ اکتبر است، یعنی
-- **داخل** دورهٔ اکتبرِ تهران می‌افتد ⇒ طبق قاعدهٔ بالا، اکتبر LEGACY می‌ماند و
-- V2 فقط از ۱ نوامبر تهران شروع می‌شود. چون ۱۰۰٪ کاربران production در
-- Asia/Tehran هستند، این یک ماه تأخیر واقعی بود.
--
-- مقدار مصوب (Phase 5): V2 از ابتدای ۱ اکتبر **به وقت تهران** NEW شود.
-- مقدار قبلی هرگز به عقب برنمی‌گردد (setCutoverAt هم عقب‌بردن را رد می‌کند)، چون
-- برگشت به عقب دوره‌های «جدید» را legacy می‌کند و دادهٔ AiQuotaBucket را بی‌اثر
-- می‌سازد.
INSERT INTO "AiQuotaCutover" ("id", "cutoverAt", "note", "updatedAt") VALUES
    (1, '2026-09-30 20:30:00+00',
     'AI Quota v2 cutover: period containing this instant is the last legacy period. Set to 2026-10-01T00:00 Asia/Tehran so Tehran users (all of production) start V2 on Oct 1 local, not Nov 1.',
     CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
