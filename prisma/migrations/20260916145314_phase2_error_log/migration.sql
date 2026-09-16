-- CreateTable
CREATE TABLE "ErrorLog" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "userId" INTEGER,
    "endpoint" TEXT NOT NULL,
    "feature" TEXT,
    "errorCode" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "metadata" JSONB,
    "environment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErrorLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ErrorLog_createdAt_idx" ON "ErrorLog"("createdAt");

-- CreateIndex
CREATE INDEX "ErrorLog_errorCode_createdAt_idx" ON "ErrorLog"("errorCode", "createdAt");

-- CreateIndex
CREATE INDEX "ErrorLog_category_createdAt_idx" ON "ErrorLog"("category", "createdAt");

-- CreateIndex
CREATE INDEX "ErrorLog_severity_createdAt_idx" ON "ErrorLog"("severity", "createdAt");

-- CreateIndex
CREATE INDEX "ErrorLog_endpoint_createdAt_idx" ON "ErrorLog"("endpoint", "createdAt");

-- CreateIndex
CREATE INDEX "ErrorLog_userId_createdAt_idx" ON "ErrorLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ErrorLog_requestId_idx" ON "ErrorLog"("requestId");
