-- CreateEnum
CREATE TYPE "BillingProvider" AS ENUM ('ZARINPAL');

-- CreateEnum
CREATE TYPE "PaymentOrderStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'EXPIRED', 'CANCELED');

-- CreateEnum
CREATE TYPE "EntitlementStatus" AS ENUM ('ACTIVE', 'EXPIRED');

-- CreateTable
CREATE TABLE "PaymentOrder" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "provider" "BillingProvider" NOT NULL,
    "merchantOrderId" TEXT NOT NULL,
    "checkoutIdempotencyKey" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PaymentOrderStatus" NOT NULL,
    "providerAuthority" TEXT,
    "providerReference" TEXT,
    "entitlementDays" INTEGER NOT NULL,
    "requestId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "entitlementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Entitlement" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "provider" "BillingProvider" NOT NULL,
    "status" "EntitlementStatus" NOT NULL,
    "planCode" "UserPlan" NOT NULL,
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Entitlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentOrder_merchantOrderId_key" ON "PaymentOrder"("merchantOrderId");

-- CreateIndex
CREATE INDEX "PaymentOrder_userId_createdAt_idx" ON "PaymentOrder"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "PaymentOrder_status_expiresAt_idx" ON "PaymentOrder"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentOrder_userId_checkoutIdempotencyKey_key" ON "PaymentOrder"("userId", "checkoutIdempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentOrder_provider_providerAuthority_key" ON "PaymentOrder"("provider", "providerAuthority");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentOrder_provider_providerReference_key" ON "PaymentOrder"("provider", "providerReference");

-- CreateIndex
CREATE UNIQUE INDEX "Entitlement_userId_key" ON "Entitlement"("userId");

-- CreateIndex
CREATE INDEX "Entitlement_status_currentPeriodEnd_idx" ON "Entitlement"("status", "currentPeriodEnd");

-- AddForeignKey
ALTER TABLE "PaymentOrder" ADD CONSTRAINT "PaymentOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
