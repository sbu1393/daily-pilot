/*
  Warnings:

  - You are about to drop the column `actualTime` on the `Task` table. All the data in the column will be lost.
  - You are about to drop the column `deadline` on the `Task` table. All the data in the column will be lost.
  - You are about to drop the column `progress` on the `Task` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[userId,date]` on the table `DailyPlan` will be added. If there are existing duplicate values, this will fail.
  - Made the column `scheduledDate` on table `Task` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "Task" DROP COLUMN "actualTime",
DROP COLUMN "deadline",
DROP COLUMN "progress",
ADD COLUMN     "category" TEXT,
ALTER COLUMN "scheduledDate" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "DailyPlan_userId_date_key" ON "DailyPlan"("userId", "date");
