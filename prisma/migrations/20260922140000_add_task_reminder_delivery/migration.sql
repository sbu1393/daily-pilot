-- CreateEnum (additive)
CREATE TYPE "ReminderDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'GONE');

-- CreateTable (additive only — no existing table/column is dropped or altered)
CREATE TABLE "TaskReminderDelivery" (
    "id" TEXT NOT NULL,
    "taskId" INTEGER NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "reminderAt" TIMESTAMP(3) NOT NULL,
    "status" "ReminderDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "TaskReminderDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — idempotency: one logical delivery per (task, subscription, reminderAt)
CREATE UNIQUE INDEX "TaskReminderDelivery_taskId_subscriptionId_reminderAt_key" ON "TaskReminderDelivery"("taskId", "subscriptionId", "reminderAt");

-- CreateIndex
CREATE INDEX "TaskReminderDelivery_status_createdAt_idx" ON "TaskReminderDelivery"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "TaskReminderDelivery" ADD CONSTRAINT "TaskReminderDelivery_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskReminderDelivery" ADD CONSTRAINT "TaskReminderDelivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "PushSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
