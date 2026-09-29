-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL,
    "actorUserId" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AdminAuditLog_action_createdAt_idx" ON "AdminAuditLog"("action", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAuditLog_actorUserId_createdAt_idx" ON "AdminAuditLog"("actorUserId", "createdAt");

-- ═════════════════════════════════════════════════════════════════════════════
-- AI Quota v2 — Phase 1: Admin Audit Log (schema only)
--
-- targetType: "AiQuotaPolicy" | "PromoCode"
-- action:     "quota_policy.updated" | "promo.created" | "promo.updated"
--
-- عمداً بدون FK به User: این جدول append-only و حافظ سابقه است؛ حذف یک ادمین
-- نباید رد audit را پاک کند (actorUserId فقط یک شناسه‌ی تاریخی است).
-- requestId همان requestId سرور-ساخته‌ی observability است و برای correlation با
-- ErrorLog استفاده می‌شود — نه برای احراز هویت.
-- ═════════════════════════════════════════════════════════════════════════════
