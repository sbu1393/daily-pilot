-- یادآورها — Web Push (VAPID): جدول اشتراک‌های مرورگر برای ارسال یادآور
-- در حالت بسته بودن اپ / Doze اندروید.
--
-- این مایگریشن کاملاً additive است: فقط یک جدول جدید + دو ایندکس + یک FK می‌سازد.
-- هیچ ستونی از جدول‌های موجود تغییر نمی‌کند، هیچ DROP/ALTER ENUM ندارد.
-- SQL با `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma`
-- تولید شده است (خروجی دست‌کاری نشده).

-- CreateTable
CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
