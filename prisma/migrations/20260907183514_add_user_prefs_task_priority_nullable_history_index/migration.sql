-- CreateEnum
CREATE TYPE "CalendarType" AS ENUM ('JALALI', 'GREGORIAN');

-- CreateEnum
CREATE TYPE "UserPlan" AS ENUM ('FREE', 'PRO');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "calendar" "CalendarType" NOT NULL DEFAULT 'JALALI',
ADD COLUMN     "locale" TEXT NOT NULL DEFAULT 'fa',
ADD COLUMN     "plan" "UserPlan" NOT NULL DEFAULT 'FREE',
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Asia/Tehran';

-- AlterTable
ALTER TABLE "Task" ALTER COLUMN "priority" DROP NOT NULL,
ALTER COLUMN "priority" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "Task_userId_completedOn_idx" ON "Task"("userId", "completedOn");
