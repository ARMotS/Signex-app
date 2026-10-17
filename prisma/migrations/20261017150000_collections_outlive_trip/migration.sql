-- Collections outlive the trip that carried them.
--
-- A credit note references only the invoice and arrives days after the trip
-- has completed — which deleted the Collection rows with it. From now on
-- completion DETACHES a collection (tripSheetId and stopId set to null) instead.
--
-- Expand-only and safe under the previous deploy's code: relaxing NOT NULL
-- changes nothing while every row still has both ids, and only the new code
-- ever writes a null. The composite foreign keys are untouched; a null
-- component simply switches the constraint off for an archived row.

-- AlterTable
ALTER TABLE "Collection" ALTER COLUMN "tripSheetId" DROP NOT NULL,
ALTER COLUMN "stopId" DROP NOT NULL,
ADD COLUMN     "customerName" TEXT,
ADD COLUMN     "completedTripSheetId" TEXT,
ADD COLUMN     "signedIncludesSource" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Collection_tenantId_completedTripSheetId_idx" ON "Collection"("tenantId", "completedTripSheetId");

-- Live collections take their customer from their stop now, so an archived
-- one still has it. Same scope by construction (composite FK).
UPDATE "Collection" c
SET "customerName" = s."customerName"
FROM "Stop" s
WHERE s."id" = c."stopId"
  AND s."tenantId" = c."tenantId"
  AND c."customerName" IS NULL;
