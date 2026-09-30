-- محصول اشتراک روی سفارش پرداخت — `PaymentOrder.productCode`
--
-- 1) `PaymentOrder.productCode` — شناسه محصولی که کاربر انتخاب کرده
--    (PRO_1M|PRO_2M|PRO_3M). این ستون فقط برای گزارش فروش/ردیابی است؛ منبع حقیقت
--    مبلغ و مدت همچنان `amount`/`currency`/`entitlementDays` اسنپ‌شات همین ردیف است و
--    `Entitlement` هم تغییری نمی‌کند (`planCode` همچنان فقط FREE|PRO).
--
-- نکته: ستون **nullable** و بدون default است، پس کاملاً additive است:
-- سفارش‌های قدیمی (که محصول تکی داشتند) بدون backfill و بدون downtime سالم می‌مانند.
-- هیچ ستون/جدول/ایندکس یونیکی موجودی تغییر نمی‌کند.

-- AlterTable
ALTER TABLE "PaymentOrder" ADD COLUMN "productCode" TEXT;