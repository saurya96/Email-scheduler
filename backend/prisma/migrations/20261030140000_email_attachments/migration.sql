CREATE TABLE "EmailBatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "attachments" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailBatch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailBatch_idempotencyKey_key" ON "EmailBatch"("idempotencyKey");
CREATE INDEX "EmailBatch_tenantId_createdAt_idx" ON "EmailBatch"("tenantId", "createdAt");
ALTER TABLE "EmailBatch" ADD CONSTRAINT "EmailBatch_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Email" ADD COLUMN "batchId" TEXT;
CREATE INDEX "Email_batchId_idx" ON "Email"("batchId");
ALTER TABLE "Email" ADD CONSTRAINT "Email_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "EmailBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
