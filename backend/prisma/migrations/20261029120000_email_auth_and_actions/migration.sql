ALTER TABLE "Tenant" ALTER COLUMN "googleSub" DROP NOT NULL;

CREATE TABLE "EmailCredential" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmailCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailCredential_email_key" ON "EmailCredential"("email");
CREATE UNIQUE INDEX "EmailCredential_tenantId_key" ON "EmailCredential"("tenantId");
ALTER TABLE "EmailCredential" ADD CONSTRAINT "EmailCredential_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TYPE "EmailStatus" ADD VALUE 'CANCELLED';
ALTER TABLE "Email" ADD COLUMN "starred" BOOLEAN NOT NULL DEFAULT false;
