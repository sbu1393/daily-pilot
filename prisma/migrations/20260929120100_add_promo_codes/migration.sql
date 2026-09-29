-- CreateTable
CREATE TABLE "PromoCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "maxRedemptions" INTEGER,
    "bonusAnalyzeUnits" INTEGER NOT NULL DEFAULT 0,
    "bonusPlanUnits" INTEGER NOT NULL DEFAULT 0,
    "redeemedCount" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromoRedemption" (
    "id" TEXT NOT NULL,
    "promoCodeId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "bonusAnalyzeUnits" INTEGER NOT NULL,
    "bonusPlanUnits" INTEGER NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromoRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PromoCode_code_key" ON "PromoCode"("code");

-- CreateIndex
CREATE INDEX "PromoCode_isActive_expiresAt_idx" ON "PromoCode"("isActive", "expiresAt");

-- CreateIndex
CREATE INDEX "PromoRedemption_promoCodeId_redeemedAt_idx" ON "PromoRedemption"("promoCodeId", "redeemedAt");

-- CreateIndex
CREATE INDEX "PromoRedemption_userId_redeemedAt_idx" ON "PromoRedemption"("userId", "redeemedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PromoRedemption_userId_promoCodeId_key" ON "PromoRedemption"("userId", "promoCodeId");

-- AddForeignKey
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "PromoCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ═════════════════════════════════════════════════════════════════════════════
-- AI Quota v2 — Phase 1: Promo Codes (schema only; no runtime behavior)
--
-- تضمین‌های DB-level (تکیه‌گاه اصلی، نه application):
--   • "PromoRedemption_userId_promoCodeId_key" → هر کاربر هر کد را فقط یک‌بار
--   • "PromoCode_code_key"                    → کد یکتا (نرمال‌شده: trim + UPPER)
--   • "PromoRedemption_promoCodeId_fkey" ON DELETE RESTRICT → حذف کد، audit را
--     از بین نمی‌برد
-- قید احراز «سقف maxRedemptions» در application با CAS روی redeemedCount و در
-- همان transaction ریدیمپشن اجرا می‌شود (اگر ریدیمپشن تکراری باشد rollback می‌شود).
-- ═════════════════════════════════════════════════════════════════════════════

-- ── invariants ───────────────────────────────────────────────────────────────
ALTER TABLE "PromoCode"
    ADD CONSTRAINT "PromoCode_bonus_non_negative"
        CHECK ("bonusAnalyzeUnits" >= 0 AND "bonusPlanUnits" >= 0),
    -- کدی که هیچ bonusی نمی‌دهد بی‌معناست
    ADD CONSTRAINT "PromoCode_bonus_total_positive"
        CHECK ("bonusAnalyzeUnits" + "bonusPlanUnits" >= 1),
    ADD CONSTRAINT "PromoCode_redeemedCount_non_negative"
        CHECK ("redeemedCount" >= 0),
    ADD CONSTRAINT "PromoCode_maxRedemptions_positive"
        CHECK ("maxRedemptions" IS NULL OR "maxRedemptions" >= 1),
    ADD CONSTRAINT "PromoCode_window_valid"
        CHECK ("expiresAt" > "validFrom");

ALTER TABLE "PromoRedemption"
    ADD CONSTRAINT "PromoRedemption_bonus_non_negative"
        CHECK ("bonusAnalyzeUnits" >= 0 AND "bonusPlanUnits" >= 0),
    ADD CONSTRAINT "PromoRedemption_bonus_total_positive"
        CHECK ("bonusAnalyzeUnits" + "bonusPlanUnits" >= 1);
