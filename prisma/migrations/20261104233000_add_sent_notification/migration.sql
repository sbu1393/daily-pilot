-- اعلان‌های زمان‌بندی‌شده — لاگ ضدتکرار روزانه (idempotency)
--
-- هر ردیف = یک اعلانِ {userId, type, dayKey}. کلید یکتای ترکیبی تضمین می‌کند
-- اگر Vercel Cron (یا هر فراخوانی دستی) چند بار در یک روز اجرا شود، برای هر
-- کاربر و هر نوع اعلان فقط یک ارسال انجام شود.
--
-- `dayKey` روز محلی خود کاربر است (نه UTC) تا مرز روز با timezone او هم‌خوان باشد.
-- `type` یکی از morning | night | overdue است و اعتبارسنجی آن در لایه‌ی سرویس
-- انجام می‌شود (عمداً enum نشد تا افزودن نوع جدید نیازمند migration نباشد).

CREATE TABLE "SentNotification" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "dayKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SentNotification_pkey" PRIMARY KEY ("id")
);

-- کلید idempotency: یک ردیف برای هر {کاربر، نوع، روز}
CREATE UNIQUE INDEX "SentNotification_userId_type_dayKey_key" ON "SentNotification"("userId", "type", "dayKey");

-- برای پاک‌سازی/گزارش‌گیری دوره‌ای
CREATE INDEX "SentNotification_userId_createdAt_idx" ON "SentNotification"("userId", "createdAt");

ALTER TABLE "SentNotification" ADD CONSTRAINT "SentNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
