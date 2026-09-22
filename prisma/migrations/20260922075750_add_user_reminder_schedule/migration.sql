-- یادآورها — آینه‌ی سرور برنامه‌ی یادآور کاربر
--
-- چرا لازم است؟ تنظیمات یادآور در سمت کلاینت (localStorage) نگه داشته می‌شد،
-- ولی برای ارسال Push در زمان مقرر (وقتی اپ بسته است) تریگر سرور باید بداند
-- هر کاربر چه ساعتی یادآور دارد و آیا امروز برای او ارسال شده یا نه.
--
-- این مایگریشن کاملاً additive است: سه ستون جدید روی "User" با مقدار پیش‌فرض
-- امن برای ردیف‌های موجود. هیچ ستونی حذف/تغییر نمی‌شود و هیچ جدول دیگری
-- دست‌نخورده می‌ماند.
-- SQL با `prisma migrate diff --from-schema-datasource … --to-schema-datamodel …`
-- تولید شده است (خروجی دست‌کاری نشده؛ فقط نویز drift دیتابیس حذف شده).

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "reminderEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reminderSentOn" TEXT,
ADD COLUMN     "reminderTime" TEXT NOT NULL DEFAULT '09:00';
