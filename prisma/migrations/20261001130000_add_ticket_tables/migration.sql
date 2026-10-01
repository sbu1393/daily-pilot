-- Ticketing — فاز T1: زیرساخت دیتابیس MVP
-- ─────────────────────────────────────────────────────────────────────────────
-- هدف: فقط ساخت دو مدل `Ticket` و `TicketMessage` (+ دو enum و روابط User).
-- این مهاجرت **کاملاً additive** است:
--   • هیچ ستون/جدول موجودی تغییر یا rename نمی‌شود.
--   • هیچ داده‌ای migrate/transform نمی‌شود.
--   • هیچ unique constraint غیرضروری اضافه نمی‌شود.
--
-- خارج از دامنهٔ MVP (عمداً ساخته نشده): TicketAttachment، TicketCategory،
-- TicketAuditLog، NotificationTarget/FCM، assignedToUserId، نقش SUPPORT.

-- ── ۱) enumها ────────────────────────────────────────────────────────────────
-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'PENDING', 'CLOSED');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- ── ۲) Ticket ────────────────────────────────────────────────────────────────
-- id از نوع SERIAL است (autoincrement) — هم‌راستا با Task/User به‌عنوان موجودیت
-- دامنه‌ای متعلق به کاربر. status/priority پیش‌فرض‌شان OPEN/MEDIUM است.
-- CreateTable
CREATE TABLE "Ticket" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "TicketPriority" NOT NULL DEFAULT 'MEDIUM',
    "category" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- ── ۳) TicketMessage ─────────────────────────────────────────────────────────
-- id از نوع cuid (TEXT) است — هم‌راستا با TaskEvent/AdminAuditLog برای رکوردهای
-- فرزندی که با والد یکی‌به‌چند هستند. authorUserId نویسندهٔ پیام است و isStaff
-- در لحظهٔ نوشتن snapshot می‌شود.
-- CreateTable
CREATE TABLE "TicketMessage" (
    "id" TEXT NOT NULL,
    "ticketId" INTEGER NOT NULL,
    "authorUserId" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "isStaff" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketMessage_pkey" PRIMARY KEY ("id")
);

-- ── ۴) indexها (دقیقاً بر اساس access patternهای گزارش ممیزی) ─────────────────
-- CreateIndex
-- «تیکت‌های من، جدیدترین اول»
CREATE INDEX "Ticket_userId_createdAt_idx" ON "Ticket"("userId", "createdAt");

-- CreateIndex
-- «تیکت‌های یک وضعیت، تازه‌به‌روزشده‌ها اول» (صف ادمین)
CREATE INDEX "Ticket_status_updatedAt_idx" ON "Ticket"("status", "updatedAt");

-- CreateIndex
-- «پیام‌های یک تیکت، به ترتیب زمان»
CREATE INDEX "TicketMessage_ticketId_createdAt_idx" ON "TicketMessage"("ticketId", "createdAt");

-- ── ۵) foreign keyها ─────────────────────────────────────────────────────────
-- AddForeignKey
-- حذف کاربر ⇒ تیکت‌های او هم می‌رود.
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- حذف تیکت ⇒ همهٔ پیام‌های آن می‌رود (متعلق به والد).
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- حذف نویسنده ⇒ پیام‌های نوشتهٔ او هم می‌رود. این FK برای برآورده‌کردن
-- back-reference اجباری `User.ticketMessages` در Prisma لازم است.
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
