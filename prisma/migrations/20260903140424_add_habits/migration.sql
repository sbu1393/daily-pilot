/*
  Warnings:

  - You are about to drop the column `date` on the `DailyPlan` table. All the data in the column will be lost.
  - You are about to drop the column `remainingTime` on the `Task` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[userId,dayKey]` on the table `DailyPlan` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `dayKey` to the `DailyPlan` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "DailyPlan_userId_date_key";

-- AlterTable
ALTER TABLE "DailyPlan" DROP COLUMN "date",
ADD COLUMN     "dayKey" TEXT NOT NULL,
ALTER COLUMN "availableMinutes" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "Task" DROP COLUMN "remainingTime",
ADD COLUMN     "allocatedMinutes" INTEGER,
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "completedOn" TEXT,
ADD COLUMN     "dayKey" TEXT,
ADD COLUMN     "spentMinutes" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "DailyPlan_userId_dayKey_key" ON "DailyPlan"("userId", "dayKey");

-- CreateIndex
CREATE INDEX "Task_userId_dayKey_idx" ON "Task"("userId", "dayKey");

-- CreateIndex
CREATE INDEX "Task_userId_status_idx" ON "Task"("userId", "status");
