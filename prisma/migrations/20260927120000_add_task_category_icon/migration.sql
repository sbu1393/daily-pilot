-- AlterTable
-- دستهٔ سفارشی: یک ستون nullable اضافه می‌شود تا هر Task بتواند آیکن خودش را
-- نگه دارد. nullable ماندن عمدی است: تمام Taskهای موجود (و presetها که
-- آیکن‌شان از واژگان canonical می‌آید) بدون هیچ backfill سالم می‌مانند.
ALTER TABLE "Task" ADD COLUMN     "categoryIcon" TEXT;
