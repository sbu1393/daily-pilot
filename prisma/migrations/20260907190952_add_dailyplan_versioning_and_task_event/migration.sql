-- CreateEnum
CREATE TYPE "TaskEventType" AS ENUM ('CREATED', 'ANALYZED', 'EDITED', 'ROLLED_OVER', 'COMPLETED');

-- AlterTable
ALTER TABLE "DailyPlan" ADD COLUMN     "planVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rebalancedVersion" INTEGER;

-- CreateTable
CREATE TABLE "TaskEvent" (
    "id" TEXT NOT NULL,
    "taskId" INTEGER NOT NULL,
    "type" "TaskEventType" NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskEvent_taskId_createdAt_idx" ON "TaskEvent"("taskId", "createdAt");

-- AddForeignKey
ALTER TABLE "TaskEvent" ADD CONSTRAINT "TaskEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;
