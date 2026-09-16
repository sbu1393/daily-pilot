-- CreateEnum
CREATE TYPE "AiUsagePeriodType" AS ENUM ('MONTHLY');

-- CreateEnum
CREATE TYPE "AiUsageEventStatus" AS ENUM ('RESERVED', 'CONSUMED', 'RELEASED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastSeenAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AiUsage" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "periodType" "AiUsagePeriodType" NOT NULL DEFAULT 'MONTHLY',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "reservedUnits" INTEGER NOT NULL DEFAULT 0,
    "consumedUnits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiUsageEvent" (
    "id" SERIAL NOT NULL,
    "requestId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "feature" TEXT NOT NULL,
    "model" TEXT,
    "units" INTEGER NOT NULL DEFAULT 1,
    "status" "AiUsageEventStatus" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "failureCode" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiUsage_userId_periodStart_idx" ON "AiUsage"("userId", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "AiUsage_userId_periodType_periodStart_key" ON "AiUsage"("userId", "periodType", "periodStart");

-- CreateIndex
CREATE UNIQUE INDEX "AiUsageEvent_requestId_key" ON "AiUsageEvent"("requestId");

-- CreateIndex
CREATE INDEX "AiUsageEvent_userId_createdAt_idx" ON "AiUsageEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AiUsageEvent_userId_status_idx" ON "AiUsageEvent"("userId", "status");

-- AddForeignKey
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiUsageEvent" ADD CONSTRAINT "AiUsageEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
