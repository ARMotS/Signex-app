-- Automatic delivery-confirmation email, and an archive of completed trip sheets.
--
-- 1. Stop.emailStatus and friends
--    The confirmation email is now sent the instant the customer signs, so a
--    single nullable emailSentAt is no longer enough to describe the outcome.
--    The dispatcher's queue has to tell "never attempted" from "attempted and
--    failed" from "there is no address on file" — the first two are worth a
--    retry, the third needs a contact record fixed first.
--
--    SENDING is an in-flight claim, not a resting state. It is what keeps the
--    automatic send and a dispatcher pressing Send at the same moment from
--    mailing the customer twice.
--
-- 2. CompletedTripSheet
--    completeTripSheet() deletes the sheet (see lib/trip-data.ts) — the stops
--    are done and leaving them behind keeps them in every driver's run sheet.
--    A flat snapshot is written here first so that closing out the day stops
--    erasing it.

CREATE TYPE "EmailStatus" AS ENUM ('NOT_SENT', 'SENDING', 'SENT', 'FAILED', 'NO_EMAIL');

ALTER TABLE "Stop" ADD COLUMN "emailStatus" "EmailStatus" NOT NULL DEFAULT 'NOT_SENT';
ALTER TABLE "Stop" ADD COLUMN "emailAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Stop" ADD COLUMN "emailLastAttemptAt" TIMESTAMP(3);
ALTER TABLE "Stop" ADD COLUMN "emailError" TEXT;

-- Anything already emailed under the old scheme is SENT, so existing signed
-- deliveries do not all reappear in the dispatcher's queue on first deploy.
UPDATE "Stop"
   SET "emailStatus" = 'SENT',
       "emailAttempts" = 1,
       "emailLastAttemptAt" = "emailSentAt"
 WHERE "emailSentAt" IS NOT NULL;

CREATE INDEX "Stop_tenantId_emailStatus_idx" ON "Stop"("tenantId", "emailStatus");
CREATE INDEX "Stop_tenantId_signedAt_idx" ON "Stop"("tenantId", "signedAt");

CREATE TABLE "CompletedTripSheet" (
    "id" TEXT NOT NULL,
    "tripSheetId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "driverName" TEXT NOT NULL,
    "regNo" TEXT,
    "sourceFilename" TEXT NOT NULL,
    "archivedFile" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedBy" TEXT,
    "totalStops" INTEGER NOT NULL,
    "signedStops" INTEGER NOT NULL,
    "stops" JSONB NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompletedTripSheet_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CompletedTripSheet_tenantId_idx" ON "CompletedTripSheet"("tenantId");
CREATE INDEX "CompletedTripSheet_tenantId_completedAt_idx" ON "CompletedTripSheet"("tenantId", "completedAt");
CREATE INDEX "CompletedTripSheet_tenantId_driverId_idx" ON "CompletedTripSheet"("tenantId", "driverId");

-- No row may exist without a real scope. The DEFAULT '' above is a type-level
-- convenience for the scoped client only; this foreign key rejects an actual ''.
ALTER TABLE "CompletedTripSheet"
  ADD CONSTRAINT "CompletedTripSheet_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
