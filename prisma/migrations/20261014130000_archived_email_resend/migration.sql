-- Resending a delivery confirmation from the completed-trip archive, at most
-- three times per delivery.
--
-- Additive only: a new table plus a unique index on CompletedTripSheet
-- ("tenantId", "id") — already unique, since "id" alone is the primary key —
-- so the previous deploy's code keeps working against this schema.

-- CreateIndex
CREATE UNIQUE INDEX "CompletedTripSheet_tenantId_id_key" ON "CompletedTripSheet"("tenantId", "id");

-- CreateTable
CREATE TABLE "ArchivedEmailResend" (
    "id" TEXT NOT NULL,
    "completedTripSheetId" TEXT NOT NULL,
    "stopNumber" INTEGER NOT NULL,
    "attempt" INTEGER NOT NULL,
    "recipient" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "sentBy" TEXT,
    "tenantId" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ArchivedEmailResend_pkey" PRIMARY KEY ("id"),
    -- The resend budget, enforced by the database: with "attempt" unique per
    -- archived stop, a fourth resend cannot be written however callers race.
    CONSTRAINT "ArchivedEmailResend_attempt_check" CHECK ("attempt" BETWEEN 1 AND 3)
);

-- CreateIndex
CREATE INDEX "ArchivedEmailResend_tenantId_completedTripSheetId_idx" ON "ArchivedEmailResend"("tenantId", "completedTripSheetId");

-- CreateIndex
CREATE UNIQUE INDEX "ArchivedEmailResend_tenantId_completedTripSheetId_stopNumbe_key" ON "ArchivedEmailResend"("tenantId", "completedTripSheetId", "stopNumber", "attempt");

-- AddForeignKey
ALTER TABLE "ArchivedEmailResend" ADD CONSTRAINT "ArchivedEmailResend_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArchivedEmailResend" ADD CONSTRAINT "ArchivedEmailResend_tenantId_completedTripSheetId_fkey" FOREIGN KEY ("tenantId", "completedTripSheetId") REFERENCES "CompletedTripSheet"("tenantId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
