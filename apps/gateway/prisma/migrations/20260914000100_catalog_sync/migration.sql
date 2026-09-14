CREATE TABLE "CatalogSyncConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 240,
    "sourceUrl" TEXT,
    "itemsPath" TEXT NOT NULL DEFAULT 'items',
    "timeoutMs" INTEGER NOT NULL DEFAULT 20000,
    "encryptedAuth" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CatalogSyncConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CatalogSyncConfig_tenantId_key" ON "CatalogSyncConfig"("tenantId");
CREATE INDEX "CatalogSyncConfig_enabled_lastRunAt_idx" ON "CatalogSyncConfig"("enabled", "lastRunAt");
ALTER TABLE "CatalogSyncConfig" ADD CONSTRAINT "CatalogSyncConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
