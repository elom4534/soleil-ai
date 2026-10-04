-- CreateTable
CREATE TABLE "ApiCredential" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "label" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "dailyLimit" INTEGER,
    "dailyRemaining" INTEGER,
    "minuteLimit" INTEGER,
    "minuteRemaining" INTEGER,
    "usedToday" INTEGER NOT NULL DEFAULT 0,
    "usedTotal" INTEGER NOT NULL DEFAULT 0,
    "usageDay" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usageByEndpoint" JSONB NOT NULL DEFAULT '{}',
    "lastUsedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "consecutiveErrors" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiCallLog" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "credentialId" TEXT,
    "endpoint" TEXT NOT NULL,
    "cost" INTEGER NOT NULL DEFAULT 1,
    "statusCode" INTEGER,
    "durationMs" INTEGER,
    "fromCache" BOOLEAN NOT NULL DEFAULT false,
    "cacheKey" TEXT,
    "quotaAfter" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApiCredential_provider_isActive_idx" ON "ApiCredential"("provider", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ApiCredential_provider_keyHash_key" ON "ApiCredential"("provider", "keyHash");

-- CreateIndex
CREATE INDEX "ApiCallLog_provider_createdAt_idx" ON "ApiCallLog"("provider", "createdAt");

-- CreateIndex
CREATE INDEX "ApiCallLog_endpoint_createdAt_idx" ON "ApiCallLog"("endpoint", "createdAt");

