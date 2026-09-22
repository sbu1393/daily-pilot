-- AlterTable (additive only — nullable column, no data loss, no drops)
ALTER TABLE "Task" ADD COLUMN "reminderAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Task_userId_reminderAt_idx" ON "Task"("userId", "reminderAt");
