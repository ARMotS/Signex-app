-- The name the customer types beside their delivery signature.
--
-- Additive only: nullable, so existing rows need no backfill and the previous
-- deploy's code keeps working against this schema.
-- AlterTable
ALTER TABLE "Stop" ADD COLUMN     "signedByName" TEXT;
