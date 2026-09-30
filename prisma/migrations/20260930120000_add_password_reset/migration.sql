-- رمز عبور موقت (Password Reset) — AI Quota / Auth فاز جدید
--
-- 1) `User.mustChangePassword` — وضعیت «با رمز موقت لاگین کرده ولی هنوز رمز دائمی
--    تعیین نکرده». DB تنها منبع حقیقت است.
--
-- 2) `PasswordResetToken` — lifecycle رمز موقت، عمداً جدا از `User.password` تا
--    رمز دائمی قبلی سالم بماند (ایمیل ممکن است به inbox نرسد؛ در آن صورت کاربر
--    نباید قفل شود). فقط bcrypt hash ذخیره می‌شود؛ plaintext هرگز persist نمی‌شود.
--
-- نکته: `tokenHash` عمداً UNIQUE **نیست**. bcrypt salt تصادفی دارد، پس هش یکسان
-- از یک رشتهٔ یکسان تولید نمی‌شود و یونیکیتی در سطح DB قابل اتکا نیست.
-- ضد replay از `usedAt` و ضد همزمانی از حذف اتمیک در transaction می‌آید.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- FK با CASCADE: حذف کاربر، توکن‌های باز او را هم می‌برد (توکن بی‌صاحب بی‌معناست
-- و هیچ مسیر login دیگری ندارد).
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- lookup مسیر لاگین: «فعال‌ترین توکن این کاربر» (باز، مصرف‌نشده، منقضی‌نشده)
CREATE INDEX "PasswordResetToken_userId_createdAt_idx" ON "PasswordResetToken"("userId", "createdAt");

-- پاک‌سازی دوره‌ای توکن‌های منقضی
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");
